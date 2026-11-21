import Foundation

// The archive: the answers of the precheck and of the toggle routes. Decoded by hand and tolerant like all models: a missing
// field must not make the question unreadable, otherwise the user would see "Could not read the server response" instead of
// the reason why archiving is refused.
//
// The reason TEXTS are written by the server (`open[].text`); nothing is translated here. The app reads `reason` only for
// one case: if the open question is the ONLY reason, it offers "Discard question and archive".

/// A reason for open work, as the server writes it.
struct ArchiveOpen: Decodable, Hashable, Sendable {
    let reason: String
    let text: String

    init(reason: String, text: String) {
        self.reason = reason
        self.text = text
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reason = c.str(.reason)
        text = c.str(.text)
    }

    enum CodingKeys: String, CodingKey { case reason, text }
}

/// `GET /api/chats/:id/archive`: the precheck of a chat (loaded only AFTER the tap).
struct ArchivePrecheck: Decodable, Sendable {
    let archived: Bool
    let archivedAt: Double?
    let open: [ArchiveOpen]
    /// Open shells of the chat rail. Archiving ends them, so the app asks first.
    let terminals: Int

    init(archived: Bool = false, archivedAt: Double? = nil, open: [ArchiveOpen] = [], terminals: Int = 0) {
        self.archived = archived
        self.archivedAt = archivedAt
        self.open = open
        self.terminals = terminals
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        archived = c.bool(.archived)
        archivedAt = c.dblOpt(.archivedAt)
        open = c.list(.open, ArchiveOpen.self)
        terminals = c.int(.terminals)
    }

    enum CodingKeys: String, CodingKey { case archived, archivedAt, open, terminals }
}

/// A chat that blocks archiving its folder, with its title and its reasons.
struct ArchiveLockedChat: Decodable, Hashable, Sendable {
    let chatId: String
    let title: String
    let open: [ArchiveOpen]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatId = c.str(.chatId)
        title = c.str(.title)
        open = c.list(.open, ArchiveOpen.self)
    }

    enum CodingKeys: String, CodingKey { case chatId, title, open }
}

/// `GET /api/chat-folders/:id/archive`: the precheck of a folder. `chats` names what the NEXT action on the folder affects:
/// on an active folder the chats archiving would take along, on an archived one EXACTLY those that "Delete permanently"
/// deletes (server `finalSet`: only the folder's kind, only archivable chats). `contextFiles` are the context files that go
/// with the folder; `open` the blocking chats. Both numbers are OPTIONAL: if one is missing from the response it is unknown,
/// not 0 ("empty is not unknown"); otherwise the question before deleting would state a guessed number before an
/// irreversible step (like `folderDeleteQuestion` on the web).
struct ArchiveFolderPrecheck: Decodable, Sendable {
    let archived: Bool
    let archivedAt: Double?
    let chats: Int?
    let contextFiles: Int?
    let open: [ArchiveLockedChat]
    let terminals: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        archived = c.bool(.archived)
        archivedAt = c.dblOpt(.archivedAt)
        chats = c.intOpt(.chats)
        contextFiles = c.intOpt(.contextFiles)
        open = c.list(.open, ArchiveLockedChat.self)
        terminals = c.int(.terminals)
    }

    enum CodingKeys: String, CodingKey { case archived, archivedAt, chats, contextFiles, open, terminals }
}

/// The sentence of the question before permanently deleting an archived folder. The NUMBERS come from the server
/// (`ArchiveFolderPrecheck` on the archived folder), never from the view's list: that is cut down by search and project
/// filter, and the server deletes what IT counts (search "bug" ⇒ the question said "1 chat", three were deleted). The
/// singular without context files reads "will be lost" (`##one` variant); with context files the subject is compound.
/// Same calculation as `folderDeleteQuestion` in web/src/lib/archive.ts, bound in web/test/archive-binding.test.mjs: `nil`
/// if the server did not name the number of chats (then nobody is asked and nothing is deleted); an unknown number of
/// context files is phrased without a number, never as 0.
enum ArchiveQuestion {
    static func folderDelete(name: String, chats n: Int?, contextFiles m: Int?) -> String? {
        guard let n else { return nil }
        let chats = n == 1 ? L("1 chat") : L("{n} chats", ["n": n])
        guard let m else {
            return L("Delete folder \"{name}\" permanently? {chats} and all of the folder's context files will be lost (number unknown).",
                     ["name": name, "chats": chats])
        }
        if m > 0 {
            let files = m == 1 ? L("1 context file") : L("{n} context files", ["n": m])
            return L("Delete folder \"{name}\" permanently? {chats} and {files} will be lost.",
                     ["name": name, "chats": chats, "files": files])
        }
        return n == 1
            ? L("Delete folder \"{name}\" permanently? {chats} will be lost.##one", ["name": name, "chats": chats])
            : L("Delete folder \"{name}\" permanently? {chats} will be lost.", ["name": name, "chats": chats])
    }
}

/// Whom the archive notices named (the `chat_archive` event and every own action, `AppState.reportArchive`).
/// Per chat id the counter value at the LAST notice that named it, not "the ids of the last notice": two notices before the
/// next render produce ONE `onChange` with the final value, and a replaced set would lose the ids of the first. The reader
/// asks with the OLD counter value of its `onChange` whether a later notice named the chat, so it sees every notice that
/// arrived between two of its evaluations.
struct ArchiveNotices: Sendable {
    private(set) var revision = 0
    private var last: [String: Int] = [:]

    mutating func report(_ chatIds: [String]) {
        let fresh = revision &+ 1
        for id in chatIds { last[id] = fresh }
        revision = fresh
    }

    /// Did a notice AFTER the counter value `old` name this chat?
    func named(_ id: String, since old: Int) -> Bool {
        guard let n = last[id] else { return false }
        return n > old
    }
}

/// The response of `PUT /api/chats/:id/archive`: the chat in its new state (missing on an older server).
struct ArchiveChatResponse: Decodable, Sendable {
    let chat: Chat?
    let terminalsEnded: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chat = (try? c.decodeIfPresent(Chat.self, forKey: .chat)) ?? nil
        terminalsEnded = c.int(.terminalsEnded)
    }

    enum CodingKeys: String, CodingKey { case chat, terminalsEnded }
}

/// The response of `PUT /api/chat-folders/:id/archive` and `DELETE /api/chat-folders/:id`: only the numbers.
struct ArchiveFolderResponse: Decodable, Sendable {
    let chatIds: [String]
    let chats: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chatIds = c.strings(.chatIds)
        chats = c.int(.chats)
    }

    enum CodingKeys: String, CodingKey { case chatIds, chats }
}

/// The body of the toggle routes. `archived` is required (a missing field is not a statement), and `dismissQuestion` is
/// only sent when set; the encoder omits `nil`.
struct ArchiveBody: Encodable, Sendable {
    let archived: Bool
    var dismissQuestion: Bool? = nil
}

/// What is to be archived: chat or folder, with the name for the questions.
enum ArchiveTarget: Identifiable, Hashable, Sendable {
    case chat(id: String, title: String)
    case folder(id: String, name: String)

    var id: String {
        switch self {
        case .chat(let id, _): return "chat:\(id)"
        case .folder(let id, _): return "folder:\(id)"
        }
    }
}

/// The precheck in ONE form for the question: blocked, only-question, the rows (server text), the shells.
struct ArchiveHint: Sendable {
    let locked: Bool
    /// Only on a chat, and only if the open question is the ONLY reason.
    let onlyQuestion: Bool
    let rows: [String]
    let terminals: Int

    init(chat v: ArchivePrecheck) {
        locked = !v.open.isEmpty
        onlyQuestion = v.open.count == 1 && v.open[0].reason == "question"
        rows = v.open.map(\.text)
        terminals = v.terminals
    }

    init(folder v: ArchiveFolderPrecheck) {
        locked = !v.open.isEmpty
        onlyQuestion = false
        rows = v.open.map { g in
            let title = g.title.isEmpty ? L("Untitled") : g.title
            return "\(title): " + g.open.map(\.text).joined(separator: " · ")
        }
        terminals = v.terminals
    }
}

/// An entry of the archive view.
struct ArchiveEntry: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let folderId: String?
    /// Only on a coding chat; the list's project filter also applies in the archive.
    let projectId: String?
    let archivedAt: Double
    /// "user" | "auto"; nil if the server does not name it. Only the row's label reads it (`automatic`); the group
    /// calculation does not know it.
    var archiveReason: String? = nil

    /// The row carries the label "archived automatically".
    var automatic: Bool { archiveReason == "auto" }
}

/// The loaded inventory of the archive view: the archived chats (`archive=only`) and ALL folders of the kind
/// (`archive=including`); the active ones only supply the labels of loose chats.
struct ArchiveInventory: Sendable {
    var chats: [ArchiveEntry]
    var folder: [ChatFolder]
}

/// The groups of the archive view; the same calculation as `archiveGroups`/`archiveSearch` in `web/src/lib/archive.ts`:
/// archived folders first (most recently archived on top), each with its chats; then the loose chats, labeled with the name
/// of their active folder. Search matches title and folder name; if the folder name matches, the whole group stays.
struct ArchiveGroups: Sendable {
    struct Folder: Identifiable, Sendable {
        let folder: ChatFolder
        let chats: [ArchiveEntry]
        var id: String { folder.id }
    }
    struct Loose: Identifiable, Sendable {
        let chat: ArchiveEntry
        let label: String
        var id: String { chat.id }
    }
    let folder: [Folder]
    let loose: [Loose]

    var empty: Bool { folder.isEmpty && loose.isEmpty }

    init(_ inventory: ArchiveInventory) {
        let byId = Dictionary(inventory.folder.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let archived = inventory.folder.filter { $0.archivedAt != nil }
            .sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
        let inArchive = Set(archived.map(\.id))
        let mostRecent: (ArchiveEntry, ArchiveEntry) -> Bool = { $0.archivedAt > $1.archivedAt }
        folder = archived.map { o in
            Folder(folder: o, chats: inventory.chats.filter { $0.folderId == o.id }.sorted(by: mostRecent))
        }
        loose = inventory.chats
            .filter { c in c.folderId.map { !inArchive.contains($0) } ?? true }
            .sorted(by: mostRecent)
            .map { c in Loose(chat: c, label: c.folderId.flatMap { byId[$0]?.name } ?? "") }
    }

    private init(folder: [Folder], loose: [Loose]) {
        self.folder = folder
        self.loose = loose
    }

    func filtered(_ search: String) -> ArchiveGroups {
        let n = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !n.isEmpty else { return self }
        let hits: (String) -> Bool = { $0.lowercased().contains(n) }
        let o = folder.compactMap { g -> Folder? in
            if hits(g.folder.name) { return g }
            let chats = g.chats.filter { hits($0.title) }
            return chats.isEmpty ? nil : Folder(folder: g.folder, chats: chats)
        }
        return ArchiveGroups(folder: o, loose: loose.filter { hits($0.chat.title) || hits($0.label) })
    }
}

// There is only the archive of coding chats.

// ── The paths to the server ─────────────────────────────────────────────────────
// ONE place for the paths, used by WorkspaceChatsViewModel and ChatViewModel, like `lib/api/archive.ts` on the web. The ids
// are UUIDs and go UNENCODED into the path: `makeURL` encodes itself (do not encode before it).
extension APIClient {
    func archivePrecheck(chat id: String) async throws -> ArchivePrecheck {
        try await get("/api/chats/\(id)/archive")
    }

    func archivePrecheck(folder id: String) async throws -> ArchiveFolderPrecheck {
        try await get("/api/chat-folders/\(id)/archive")
    }

    @discardableResult
    func setArchive(chat id: String, _ archived: Bool, dismissQuestion: Bool = false) async throws -> ArchiveChatResponse {
        try await put("/api/chats/\(id)/archive",
                      body: ArchiveBody(archived: archived, dismissQuestion: dismissQuestion ? true : nil))
    }

    @discardableResult
    func setArchive(folder id: String, _ archived: Bool) async throws -> ArchiveFolderResponse {
        try await put("/api/chat-folders/\(id)/archive", body: ArchiveBody(archived: archived))
    }

    /// An ARCHIVED folder, permanently, with its archived chats (of the folder's kind) and context files. Returns the number
    /// of deleted chats, the same one `archivePrecheck(folder:)` named on the archived folder beforehand.
    @discardableResult
    func deleteFolderPermanently(_ id: String) async throws -> Int {
        let response: ArchiveFolderResponse = try await delete("/api/chat-folders/\(id)", query: [URLQueryItem(name: "permanently", value: "1")])
        return response.chats
    }

    /// How many context files a (coding) folder carries, for the questions before deleting.
    func contextFileCount(folder id: String) async throws -> Int {
        let list: [JSONValue] = try await get("/api/chat-folders/\(id)/context", timeout: 15)
        return list.count
    }

    /// The archive of coding chats: the archived chats (`archive=only`) and ALL folders (`archive=including`).
    func loadArchive(workspaceId: String) async throws -> ArchiveInventory {
        let folderQuery = [URLQueryItem(name: "workspaceId", value: workspaceId), URLQueryItem(name: "archive", value: "including")]
        async let folder: [ChatFolder] = get("/api/chat-folders", query: folderQuery, timeout: 20)
        let list: [Chat] = try await get("/api/chats", query: [
            URLQueryItem(name: "workspaceId", value: workspaceId),
            URLQueryItem(name: "archive", value: "only"),
        ], timeout: 20)
        let chats = list.map {
            ArchiveEntry(id: $0.id, title: $0.title, folderId: $0.folderId, projectId: $0.projectId, archivedAt: $0.archivedAt ?? 0,
                         archiveReason: $0.archiveReason)
        }
        return ArchiveInventory(chats: chats, folder: try await folder)
    }
}
