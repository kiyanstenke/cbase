import SwiftUI

// Chat folders in the mobile chat list. A folder is pure grouping — nothing arises in the
// file system. Its chats share their artifacts READ-ONLY as long as they lie in it.
//
// Deliberately ONE building block for both views (overview + left drawer): the row must not look
// different in either, and the actions (create/rename/delete/move)
// are implemented exactly once.

// ── Rows instead of cards ───────────────────────────────────────────────────
// Both lists speak the language of the Claude app's sidebar: rows on the background of the place, calm
// section heads instead of surfaces, a surface only for the selected or pressed row. What both lists
// share for that lives here: the row style, the section head and the cut of the loose chats.

/// Press and selection state of a list row: no card — selected OR pressed the row lies in
/// `CbColor.markiert`, rounded like the rows of the drawer. A `ButtonStyle` (like `.plain`), so
/// the same gesture handling: tap, long press and context menu behave as before.
struct ChatRowStyle: ButtonStyle {
    var selected = false

    /// The shape of the surface — also the context menu preview (`.contentShape(.contextMenuPreview, …)`),
    /// otherwise iOS lifts the transparent row out as an angular strip.
    static let form = RoundedRectangle(cornerRadius: 12, style: .continuous)

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Selected via `cbSelection` (in a drawer with glass a glass shape, otherwise marked), pressed marked.
            .background(configuration.isPressed && !selected ? CbColor.marked : Color.clear, in: Self.form)
            .cbSelection(selected, in: Self.form)
            // Without a surface a tap would only hit text and symbols — the whole row should be tappable.
            .contentShape(Self.form)
    }
}

/// Section head of a chat list ("Chat folders" · "Pinned" · "Chats") — like "Recents" in the Claude app:
/// muted text above the rows, no surface, no separator.
struct ChatListSection: View {
    let title: String
    /// Drawer: a little less air above.
    var compact = false

    var body: some View {
        SectionLabel(text: title)
            .padding(.horizontal, compact ? 11 : 10)
            .padding(.top, compact ? 10 : 14)
            .padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }
}

/// The loose chats (without a visible folder) in two sections, like "Starred" · "Recents" of the Claude app.
/// The sections only CUT, they do not re-sort: `AppState.visibleChats` puts pinned items first in every
/// sort anyway — the order of the rows therefore stays exactly that of the sort.
struct ChatListSections {
    let pinned: [Chat]
    let leftOver: [Chat]

    init(loose: [Chat]) {
        pinned = loose.filter(\.pinned)
        leftOver = loose.filter { !$0.pinned }
    }

    /// The head "Chats" appears only when a section already stands above the remaining chats — alone under the
    /// page title it would be a second heading for the same thing.
    func chatsHeader(byFolders: Bool) -> Bool {
        !leftOver.isEmpty && (byFolders || !pinned.isEmpty)
    }
}

/// Folder row: clearly distinguished from a chat row (filled folder symbol, name in medium,
/// counter) and expandable. The arrow turns on opening. Without a surface of its own
/// at rest (no card, see above); selected it lies in `CbColor.markiert`.
///
/// TWO targets in one row, as in a file manager: the surface expands the chats
/// below, the symbol at the right edge opens the FOLDER itself (context files +
/// artifacts of all chats). Both buttons belong to the row ITSELF — a button inside the label of an
/// outer button gets no touch in SwiftUI.
struct ChatFolderRow: View {
    let folder: ChatFolder
    let count: Int
    let expanded: Bool
    /// Set only when the list is NOT restricted to a project and the folder belongs to
    /// a project — then the row must say to which one.
    let projectName: String?
    let active: Bool
    let running: Bool
    let compact: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onToggle) { label }
                .buttonStyle(.plain)
            Button(action: onOpen) {
                Image(systemName: "folder.badge.gearshape")
                    .font(.symbol(compact ? 12.5 : 13.5))
                    .foregroundStyle(CbColor.textMuted)
                    .frame(width: compact ? 34 : 38, height: compact ? 30 : 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L("Open folder"))
            .accessibilityIdentifier("folder-open-\(folder.id)")
        }
        .padding(.trailing, compact ? 4 : 2)
        .cbSelection(active, in: ChatRowStyle.form)
        .contentShape(.contextMenuPreview, ChatRowStyle.form)
    }

    private var label: some View {
        HStack(spacing: 8) {
            Image(systemName: "chevron.right")
                .font(.symbol(compact ? 9.5 : 10, weight: .semibold))
                .foregroundStyle(CbColor.textMuted)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .frame(width: 12)

            // The arrow shows the state — the folder symbol stays the same and only serves to
            // distinguish it from a chat row (which carries the hexagon). Muted like the symbols
            // of the Claude sidebar; in the accent only while a chat inside is running.
            Image(systemName: "folder.fill")
                .font(.symbol(compact ? 13 : 14))
                .foregroundStyle(running ? Color.accentColor : CbColor.textMuted)
                .frame(width: 18)

            Text(folder.name)
                .cbFont(compact ? 14 : 15.5, weight: .medium)
                .foregroundStyle(CbColor.text)
                .lineLimit(1)

            if let projectName {
                Text(projectName)
                    .cbFont(10.5, weight: .medium)
                    .foregroundStyle(CbColor.textMuted)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.cbElevated, in: Capsule())
            }

            Spacer(minLength: 6)

            Text("\(count)")
                .cbFont(11.5, digitsEqual: true)
                .foregroundStyle(CbColor.textMuted)
        }
        .padding(.leading, compact ? 11 : 10)
        .padding(.vertical, compact ? 8 : 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Guide line to the left of the chats of an open folder — it makes visible that
/// the indented rows belong to THIS folder. It is structure, not state: muted like the
/// folder symbol (in the otherwise colorless lists an accent line would be the only
/// colored element, whether something ran inside or not). The run is shown by folder symbol and hexagon.
struct ChatFolderChildren<Content: View>: View {
    let compact: Bool
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 1)
                .fill(CbColor.textMuted.opacity(0.3))
                .frame(width: 2)
                .padding(.leading, compact ? 16 : 18)
                .padding(.trailing, compact ? 8 : 10)
                .padding(.vertical, 2)
            VStack(spacing: compact ? 4 : 8) { content }
        }
    }
}

/// Actions of a folder (context menu and ellipsis carry the same entries).
struct ChatFolderActions: View {
    let folder: ChatFolder
    let onOpen: () -> Void
    let onNewChat: () -> Void
    let onRename: () -> Void
    /// Archive: the folder with the chats in it — the flow with pre-check sits in the list.
    let onArchive: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(L("Open folder"), systemImage: "folder.badge.gearshape", action: onOpen)
        Button(L("New chat in folder"), systemImage: "square.and.pencil", action: onNewChat)
        Button(L("Rename"), systemImage: "pencil", action: onRename)
        Button(L("Archive"), systemImage: "archivebox", action: onArchive)
        Button(L("Delete folder"), systemImage: "trash", role: .destructive, action: onDelete)
    }
}

/// State of the three folder dialogs. Both chat lists (overview and left drawer) use
/// the same set — hence one type instead of three flags each.
struct ChatFolderSheetState {
    var creating = false
    var name = ""
    var renaming: ChatFolder?
    var deleting: ChatFolder?

    mutating func startCreate() {
        name = ""
        creating = true
    }

    mutating func startRename(_ folder: ChatFolder) {
        name = folder.name
        renaming = folder
    }
}

extension View {
    /// Attaches create/rename/delete to a view. `projectId` binds newly created
    /// folders to the entered project (nil = workspace folder).
    func chatFolderDialogs(
        _ sheet: Binding<ChatFolderSheetState>,
        model: WorkspaceChatsViewModel,
        projectId: String?
    ) -> some View {
        modifier(ChatFolderDialogs(sheet: sheet, model: model, projectId: projectId))
    }
}

private struct ChatFolderDialogs: ViewModifier {
    @Binding var sheet: ChatFolderSheetState
    @ObservedObject var model: WorkspaceChatsViewModel
    let projectId: String?
    /// The delete question names the context files that go with the folder: they belong to the folder, not to
    /// the chats. Counted BEFORE showing — a question whose text changes after appearing is read
    /// by nobody twice. `contextFor` is the folder the count was made for; `nil` in `contextCount` = unknown,
    /// then the sentence is missing (a guessed zero would be worse than no number).
    @State private var contextFor: String?
    @State private var contextCount: Int?

    private var deleteText: String {
        let base = L("The chats inside are kept and simply move out of the folder.")
        guard let n = contextCount, n > 0 else { return base }
        let set = n == 1
            ? L("The folder's 1 context file will be deleted.")
            : L("The folder's {n} context files will be deleted.", ["n": n])
        return base + "\n" + set
    }

    func body(content: Content) -> some View {
        content
            .alert(L("New folder"), isPresented: $sheet.creating) {
                TextField(L("Name"), text: $sheet.name)
                    .accessibilityIdentifier("chat-folder-name-field")
                Button(L("Create")) {
                    let name = sheet.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !name.isEmpty else { return }
                    Task { try? await model.createFolder(name: name, projectId: projectId) }
                }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("Chats in a folder can read each other's artifacts."))
            }
            .alert(
                L("Rename folder"),
                isPresented: Binding(get: { sheet.renaming != nil }, set: { if !$0 { sheet.renaming = nil } })
            ) {
                TextField(L("Name"), text: $sheet.name)
                    .accessibilityIdentifier("chat-folder-rename-field")
                Button(L("Save")) {
                    let name = sheet.name.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard let folder = sheet.renaming, !name.isEmpty else { return }
                    Task { try? await model.renameFolder(folder, to: name) }
                    sheet.renaming = nil
                }
                Button(L("Cancel"), role: .cancel) { sheet.renaming = nil }
            }
            .confirmationDialog(
                sheet.deleting.map { L("Delete folder “{name}”?", ["name": $0.name]) } ?? "",
                isPresented: Binding(
                    get: { sheet.deleting != nil && contextFor == sheet.deleting?.id },
                    set: { if !$0 { sheet.deleting = nil; contextFor = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(L("Delete folder"), role: .destructive) {
                    if let folder = sheet.deleting { Task { try? await model.deleteFolder(folder) } }
                    sheet.deleting = nil
                    contextFor = nil
                }
                Button(L("Cancel"), role: .cancel) { sheet.deleting = nil; contextFor = nil }
            } message: {
                Text(deleteText)
            }
            .task(id: sheet.deleting?.id) {
                guard let folder = sheet.deleting else { return }
                contextCount = try? await model.client.contextFileCount(folder: folder.id)
                guard sheet.deleting?.id == folder.id else { return }
                contextFor = folder.id
            }
    }
}

/// Submenu "Move to folder" for a chat's context menu. Only folders of the SAME scope
/// are offered — the server rejects everything else.
struct ChatFolderPicker: View {
    let chat: Chat
    let folders: [ChatFolder]
    let onPick: (String?) -> Void

    private var candidates: [ChatFolder] {
        folders.filter { ($0.projectId ?? "") == (chat.projectId ?? "") }
    }

    var body: some View {
        Menu {
            if chat.folderId != nil {
                Button(L("Remove from folder"), systemImage: "folder.badge.minus") { onPick(nil) }
            }
            ForEach(candidates) { folder in
                Button {
                    onPick(folder.id)
                } label: {
                    Label(folder.name, systemImage: chat.folderId == folder.id ? "checkmark" : "folder")
                }
            }
            if candidates.isEmpty && chat.folderId == nil {
                Text(L("No folders yet."))
            }
        } label: {
            Label(L("To folder"), systemImage: "folder")
        }
    }
}

// ── Artifacts as a file tree ────────────────────────────────────────────────
// Artifact paths are real paths ("issues/01-login.md"). The list showed only the
// whole string per row — with more than a handful of files the structure was no longer
// recognizable. Here they are folded into folders that can be expanded and collapsed.
//
// Artifacts of shared chats (the same chat folder, `own == false`) stand under a folder of their own
// per origin chat: otherwise two "plan.md" would lie next to each other indistinguishably.
enum ArtifactNode: Identifiable {
    case dir(key: String, name: String, count: Int, shared: Bool, children: [ArtifactNode])
    case file(artifact: ChatArtifact, name: String)

    var id: String {
        switch self {
        case .dir(let key, _, _, _, _): return "dir:\(key)"
        case .file(let artifact, _): return "file:\(artifact.id)"
        }
    }
}

/// An artifact on its way into the tree: `rest` is the not yet consumed path, the
/// artifact itself stays UNCHANGED. A copy with a shortened path would be fatal — the node
/// would then carry "01-login.md" instead of "issues/01-login.md", and neither the server nor the
/// reconciliation with `model.artifacts` would find the file again.
private struct PendingArtifact {
    let artifact: ChatArtifact
    let rest: String
}

/// Fold paths into nested nodes. `prefix` keeps the keys of the shared trees
/// apart — otherwise the "uploads" of two chats would collide.
private func foldArtifacts(_ items: [PendingArtifact], prefix: String) -> [ArtifactNode] {
    var order: [String] = []
    var groups: [String: [PendingArtifact]] = [:]
    var files: [(String, ChatArtifact)] = []
    for item in items {
        let parts = item.rest.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count > 1 else {
            files.append((parts.first ?? item.rest, item.artifact))
            continue
        }
        let head = parts[0]
        if groups[head] == nil { order.append(head); groups[head] = [] }
        // The head is consumed — continue with the rest of the path.
        groups[head]?.append(PendingArtifact(artifact: item.artifact, rest: parts.dropFirst().joined(separator: "/")))
    }
    let dirs = order.map { head -> ArtifactNode in
        let inner = groups[head] ?? []
        let key = "\(prefix)\(head)/"
        return .dir(key: key, name: head, count: inner.count, shared: false, children: foldArtifacts(inner, prefix: key))
    }
    return dirs.sorted(by: nodeName) + files
        .sorted { $0.0.localizedStandardCompare($1.0) == .orderedAscending }
        .map { ArtifactNode.file(artifact: $0.1, name: $0.0) }
}

private func nodeName(_ a: ArtifactNode, _ b: ArtifactNode) -> Bool {
    func name(_ n: ArtifactNode) -> String {
        switch n {
        case .dir(_, let name, _, _, _): return name
        case .file(_, let name): return name
        }
    }
    return name(a).localizedStandardCompare(name(b)) == .orderedAscending
}

func artifactTree(_ artifacts: [ChatArtifact]) -> [ArtifactNode] {
    let own = artifacts.filter { $0.own != false }
    var order: [String] = []
    var shared: [String: [ChatArtifact]] = [:]
    for artifact in artifacts where artifact.own == false {
        let id = artifact.chatId ?? ""
        if shared[id] == nil { order.append(id); shared[id] = [] }
        shared[id]?.append(artifact)
    }
    let pending = { (items: [ChatArtifact]) in items.map { PendingArtifact(artifact: $0, rest: $0.path) } }
    let sharedNodes = order.map { id -> ArtifactNode in
        let items = shared[id] ?? []
        let key = "chat:\(id)/"
        return .dir(
            key: key,
            name: items.first?.chatTitle ?? L("Another chat"),
            count: items.count,
            shared: true,
            children: foldArtifacts(pending(items), prefix: key)
        )
    }
    return foldArtifacts(pending(own), prefix: "") + sharedNodes.sorted(by: nodeName)
}

/// Rows of a (sub)tree. Recursive, so that a folder inserts its children directly below itself —
/// flat in ONE list, thus without nested scroll views.
/// Keys of the chat nodes of a tree. The folder view expands them on first load:
/// "which chat produced what" is the question with which one opens a folder. Deeper
/// directories stay closed.
func artifactChatKeys(_ nodes: [ArtifactNode]) -> [String] {
    nodes.compactMap { node in
        if case .dir(let key, _, _, let shared, _) = node, shared { return key }
        return nil
    }
}

struct ArtifactNodeRows<Destination: View>: View {
    let nodes: [ArtifactNode]
    let depth: Int
    @Binding var open: Set<String>
    /// Swipe gesture on a FILE ROW — the folder view deletes context files with it. Nil =
    /// no gesture (in the chat artifacts are read-only).
    let swipeDelete: ((ChatArtifact) -> Void)?
    /// Target of a file row. The chat shows its `ArtifactDetailView` (which reloads the file from the
    /// chat model), the folder view its own — hence it comes from outside.
    let destination: (ChatArtifact) -> Destination

    init(
        nodes: [ArtifactNode],
        depth: Int,
        open: Binding<Set<String>>,
        swipeDelete: ((ChatArtifact) -> Void)? = nil,
        @ViewBuilder destination: @escaping (ChatArtifact) -> Destination
    ) {
        self.nodes = nodes
        self.depth = depth
        self._open = open
        self.swipeDelete = swipeDelete
        self.destination = destination
    }

    var body: some View {
        ForEach(nodes) { node in
            switch node {
            case .dir(let key, let name, let count, let shared, let children):
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        if open.contains(key) { open.remove(key) } else { open.insert(key) }
                    }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: "chevron.right")
                            .font(.symbol(11, weight: .bold))
                            .foregroundStyle(.secondary)
                            .rotationEffect(.degrees(open.contains(key) ? 90 : 0))
                            .frame(width: 12)
                        Image(systemName: shared ? "bubble.left.and.bubble.right.fill" : "folder.fill")
                            .font(.symbol(13, weight: .semibold))
                            .foregroundStyle(.tint)
                            .frame(width: 22)
                        Text(name)
                            .cbFont(15, weight: .semibold)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text("\(count)")
                            .cbFont(11, weight: .medium)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, CGFloat(depth) * 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("artifact-dir-\(name)")
                if open.contains(key) {
                    ArtifactNodeRows(nodes: children, depth: depth + 1, open: $open, swipeDelete: swipeDelete, destination: destination)
                }
            case .file(let artifact, let name):
                NavigationLink {
                    destination(artifact)
                } label: {
                    HStack(spacing: 9) {
                        Spacer().frame(width: 12)
                        Image(systemName: artifact.mime.hasPrefix("image/") ? "photo" : "doc.text")
                            .foregroundStyle(.secondary)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name)
                                .font(.system(.subheadline, design: .monospaced, weight: .medium))
                                .lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.leading, CGFloat(depth) * 14)
                }
                .accessibilityIdentifier("artifact-file-\(name)")
                .swipeActions {
                    if let swipeDelete {
                        Button(L("Delete"), systemImage: "trash", role: .destructive) { swipeDelete(artifact) }
                    }
                }
            }
        }
    }
}

// ── Show AND edit a file ────────────────────────────────────────────────────
// Artifacts and folder context are text files that the human must also be able to write
// themselves — not only the agent. There is NO toggle and no second sheet: the
// reading view is the editor. The text stands in the same font at the same place, it can
// just be touched.
//
// Saving is BY HAND. Nothing is written while typing or silently on leaving the view — as on the web
// (`ArtifactModal`). "Save" at the top right (active only with changes, a spinner while writing), the
// line below says the state, and with unsaved text the sheet cannot be swiped away and
// "Back" asks (Save · Discard changes · Cancel). Writing still uses
// `expectedSha256` — if the agent overwrote the file in the meantime, the server says so with
// 409 instead of its work silently vanishing.
//
// The card must not remount on saving: saving reloads the list
// (`loadArtifacts` or `load`), the new sha256 would wake the preview's `.task(id: sha256)`, and that
// sets `loading = true` — the editor would give way to a spinner and then arise anew (cursor, scroll position,
// undo and keyboard gone). The same holds for every "artifact_changed" the server sends BEFORE
// its answer; a foreign change over unsaved text would throw the draft away completely. So the saved state
// comes from the answer (`afterTheSave`, in place in the list), reloading with open text happens without
// `loading`, and the draft (`ArtifactDraft`) lives in the preview — it takes over arriving content only where it
// loses nothing.

extension ChatArtifact {
    /// The state AFTER a manual save: values from the server's answer, the origin
    /// (`chatId`, `chatTitle`, `own`) of the open file — the answer does not know it, and without it
    /// the list would not find its row again (id = origin + path).
    func afterTheSave(_ saved: ChatArtifact) -> ChatArtifact {
        ChatArtifact(
            path: saved.path, name: saved.name, mime: saved.mime, size: saved.size,
            createdAt: saved.createdAt, modifiedAt: saved.modifiedAt, sha256: saved.sha256,
            chatId: chatId, chatTitle: chatTitle, own: own
        )
    }
}

extension ChatArtifactContent {
    /// The content AFTER a manual save — from the answer and the text that went out, without
    /// reading again.
    static func saved(_ file: ChatArtifact, text: String) -> ChatArtifactContent {
        ChatArtifactContent(
            path: file.path, name: file.name, mime: file.mime, size: file.size,
            createdAt: file.createdAt, modifiedAt: file.modifiedAt, sha256: file.sha256,
            offset: 0, nextOffset: nil, truncated: false, encoding: "utf8", content: text
        )
    }
}

/// The editing state of ONE open file. Lives in the preview (`@StateObject`), not in the
/// text body: button, back, sheet lock and status line read the same state.
@MainActor
final class ArtifactDraft: ObservableObject {
    /// The text in the editor.
    @Published var text = ""
    /// Last saved or adopted text and its sha256. `text != base` means: something is
    /// open.
    @Published private(set) var base = ""
    @Published private(set) var sha = ""
    /// Is there an editor? Only WITH its text — a field that arises empty and receives the text afterwards
    /// can undo the insertion (on the web ⌘Z emptied the whole file that way).
    @Published private(set) var loaded = false
    @Published private(set) var saving = false
    @Published private(set) var saved = false
    /// The file changed elsewhere WHILE unsaved text stood here.
    @Published private(set) var stale = false
    @Published private(set) var error = ""
    /// The text currently on its way to the server. The server reports the change
    /// ("artifact_changed") BEFORE its answer; a reload then brings exactly this text — that is
    /// no conflict but the own save.
    private var inFlight: String?
    /// Every write carries the sha of the previous one; two simultaneous ones (button and question) would
    /// shoot each other down with 409. So all hang on ONE chain.
    private var chain: Task<Bool, Never>?

    var dirty: Bool { loaded && text != base }

    static func editable(_ content: ChatArtifactContent) -> Bool {
        content.encoding == "utf8" && !content.truncated
    }

    /// A content from the server: the first load, a reload after a change, the own
    /// save. It is NEVER adopted over unsaved work — then the draft
    /// stays, and the status line says the file was changed elsewhere.
    func takeOver(_ content: ChatArtifactContent) {
        guard Self.editable(content) else {
            if !dirty { loaded = false } else if content.sha256 != sha { stale = true }
            return
        }
        guard loaded else { set(content); return }
        if content.sha256 == sha { stale = false; return }
        // The own text on its way to the server: the save's answer sets the base state.
        if content.content == inFlight { return }
        // The same text already standing here is no conflict — only the new base state. The
        // editor is NOT touched (cursor, scroll position, undo stay).
        if content.content == text { base = text; sha = content.sha256; stale = false; return }
        if dirty { stale = true; return }
        set(content)
    }

    private func set(_ content: ChatArtifactContent) {
        text = content.content
        base = content.content
        sha = content.sha256
        loaded = true
        stale = false
        saved = false
        error = ""
    }

    /// Writes the text; `true` if nothing unsaved from this run remains afterwards.
    /// `schreibe` receives the text and the sha of the state worked on, and returns the
    /// new sha.
    func save(_ write: @escaping (String, String) async throws -> String) async -> Bool {
        let prior = chain
        let run = Task { () -> Bool in
            _ = await prior?.value
            return await self.writeNow(write)
        }
        chain = run
        return await run.value
    }

    private func writeNow(_ write: (String, String) async throws -> String) async -> Bool {
        guard loaded else { return false }
        let pending = text
        if pending == base { return true }
        inFlight = pending
        saving = true
        defer {
            inFlight = nil
            saving = false
        }
        do {
            sha = try await write(pending, sha)
            base = pending
            stale = false
            saved = true
            error = ""
            return true
        } catch {
            // Do not repeat: on 409 ("changed elsewhere") every attempt failed again. The
            // typed text stays, the status line says why it is not out.
            self.error = error.localizedDescription
            return false
        }
    }
}

/// The text of a file — touchable as long as the draft is loaded and writing is allowed.
struct ArtifactTextBody: View {
    /// Full text of the file as it last came from the server.
    let content: ChatArtifactContent
    @ObservedObject var draft: ArtifactDraft
    /// False = read-only (foreign artifact, truncated copy). Then plain text stands here.
    let editable: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if editable && draft.loaded {
                TextEditor(text: $draft.text)
                    .cbFont(13, design: .monospaced)
                    .scrollContentBackground(.hidden)
                    .scrollDisabled(true)
                    .frame(minHeight: 240, alignment: .topLeading)
                    // A `TextEditor` brings its own inner padding (5 pt left) — the text
                    // would otherwise sit indented compared to the former reading view.
                    .padding(.horizontal, -5)
                    .accessibilityIdentifier("artifact-editor")
            } else {
                Text(content.content)
                    .cbFont(13, design: .monospaced)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            if content.truncated {
                Text(L("Preview truncated after 1 MiB. Download the file for the full content."))
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
        .padding()
    }
}

/// "Save" at the top right in a file's preview — active only with changes, a spinner in its place while
/// writing. Sits in the preview's own `.toolbar`, behind
/// "Download"/"Share", so that it sits at the far right.
struct ArtifactSaveButton: View {
    @ObservedObject var draft: ArtifactDraft
    let save: () async -> Bool

    var body: some View {
        if draft.saving {
            ProgressView()
                .accessibilityIdentifier("artifact-saving")
        } else {
            Button(L("Save")) {
                Task { _ = await save() }
            }
            .disabled(!draft.dirty)
            .accessibilityIdentifier("artifact-save")
        }
    }
}

/// Manual saving at a file's preview, without the button: the status line below, "Back"
/// with a question and the lock against swiping the sheet away while unsaved text stands.
/// Used by `ArtifactDetailView` (chat) and `FolderFileDetailView` (folder).
struct ArtifactEditing: ViewModifier {
    @ObservedObject var draft: ArtifactDraft
    /// Is there an editor? Without it (image, foreign artifact, truncated copy) the modifier does nothing.
    let active: Bool
    let name: String
    let save: () async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var askToClose = false

    private var open: Bool { active && draft.dirty }

    /// The state in one line — the error first, then writing, the foreign change, the
    /// unsaved and finally "saved" (like the note in the head of the web window).
    private var status: (text: String, color: Color)? {
        guard active else { return nil }
        if !draft.error.isEmpty { return (draft.error, .red) }
        if draft.saving { return (L("saving…"), .secondary) }
        if draft.stale {
            return (L("The file has changed elsewhere in the meantime. Saving will fail — copy your text and open the file again."), .orange)
        }
        if draft.dirty { return (L("unsaved"), .secondary) }
        if draft.saved { return (L("saved"), .secondary) }
        return nil
    }

    func body(content: Content) -> some View {
        content
            // No silent leaving with unsaved text: the sheet cannot be swiped away, and
            // the system's back arrow (including the edge swipe) gives way to its own one that asks.
            .interactiveDismissDisabled(open)
            .navigationBarBackButtonHidden(open)
            .toolbar {
                if open {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            askToClose = true
                        } label: {
                            Image(systemName: "chevron.backward")
                                .fontWeight(.semibold)
                        }
                        .accessibilityLabel(L("Back"))
                        .accessibilityIdentifier("artifact-back")
                    }
                }
            }
            // Below rather than in the text: at the end of a long text nobody would see the row, and with the keyboard
            // open it stands directly above it.
            .safeAreaInset(edge: .bottom) {
                if let status {
                    Text(status.text)
                        .font(.caption2)
                        .foregroundStyle(status.color)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .background(CbColor.ground)
                        .accessibilityIdentifier("artifact-save-state")
                }
            }
            .confirmationDialog(L("Save changes?"), isPresented: $askToClose, titleVisibility: .visible) {
                Button(L("Save")) {
                    Task { if await save() { dismiss() } }
                }
                Button(L("Discard changes"), role: .destructive) { dismiss() }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("\"{name}\" has unsaved changes.", ["name": name]))
            }
    }
}
