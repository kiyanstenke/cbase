import Foundation

// The archive on the open chat. The "archived" state lives ONLY in `chat.archivedAt` — no flag beside it: the composer
// bar, the ⋯ menu and the typing guard read the same field, and a second truth would drift apart on an event from
// another client.
extension ChatViewModel {

    var archived: Bool { chat.archivedAt != nil }

    /// The precheck is loaded only AFTER the tap — the reasons for open work (server text) and the number of shells
    /// that archiving ends.
    func archivePrecheck() async throws -> ArchivePrecheck {
        try await client.get("/api/chats/\(chat.id)/archive")
    }

    /// Archive. The chat stays open and shows the bar at once — so the model takes the chat from the response instead
    /// of waiting for the event. `dismissQuestion` only when an open question is dismissed with it.
    func archive(dismissQuestion: Bool = false) async throws {
        let response: ArchiveChatResponse = try await client.put(
            "/api/chats/\(chat.id)/archive",
            body: ArchiveBody(archived: true, dismissQuestion: dismissQuestion ? true : nil)
        )
        if let fresh = response.chat { chat = fresh } else { chat.archivedAt = Date().timeIntervalSince1970 * 1000 }
        onChanged()
    }

    func restore() async throws {
        let response: ArchiveChatResponse = try await client.put("/api/chats/\(chat.id)/archive", body: ArchiveBody(archived: false))
        if let fresh = response.chat { chat = fresh } else { chat.archivedAt = nil }
        onChanged()
    }

    /// The `chat_archive` event named this chat (another client, a folder archive): reload only the chat's state, not
    /// the timeline — archiving did not change it.
    func reloadArchiveStatus() async {
        guard !isDraft else { return }
        guard let fresh: Chat = try? await client.get("/api/chats/\(chat.id)") else { return }
        if fresh.archivedAt != chat.archivedAt || fresh.folderId != chat.folderId {
            chat = fresh
        }
    }
}
