// Attachments and artifacts of a chat: loading, uploading, reading, saving, downloading.
import Foundation

extension ChatViewModel {

    func attachmentData(_ attachment: Attachment) async throws -> Data {
        try await client.data("/api/chats/\(chat.id)/attachments/\(attachment.file)")
    }

    /// Files of a capture card (poster.jpg as image data; AVPlayer plays video.mp4
    /// straight from the URL — the server serves Range, `.shared` shares the session cookies).
    func captureFileData(captureId: String, name: String) async throws -> Data {
        try await client.data("/api/chats/\(chat.id)/captures/\(captureId)/file/\(name)")
    }

    func captureFileURL(captureId: String, name: String) -> URL? {
        client.captureFileURL(chatId: chat.id, captureId: captureId, name: name)
    }

    func loadArtifacts() async {
        guard !isDraft else { artifacts = []; return }
        do {
            artifacts = try await client.get("/api/chats/\(chat.id)/artifacts")
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Upload artifacts by hand. The target is ALWAYS this chat — shared files from neighbouring chats of the same
    /// folder stay read-only. Paths that already exist are NOT silently overwritten but returned as conflicts; the
    /// view asks and calls again with `overwrite: true`.
    @discardableResult
    func uploadArtifacts(_ files: [PendingArtifactUpload], overwrite: Bool = false) async -> [PendingArtifactUpload] {
        guard !isDraft else {
            error = L("Artifacts exist only once the chat does — send a message first.")
            return []
        }
        guard !files.isEmpty else { return [] }
        artifactUploading = true
        var conflicts: [PendingArtifactUpload] = []
        for file in files {
            do {
                _ = try await client.uploadArtifact(chatId: chat.id, path: file.name, data: file.data, overwrite: overwrite)
            } catch let failure as APIError where failure.status == 409 && !overwrite {
                conflicts.append(file)
            } catch {
                self.error = error.localizedDescription
            }
        }
        artifactUploading = false
        await loadArtifacts()
        return conflicts
    }

    /// Shared artifacts (chat folder) belong to ANOTHER chat. They are still read through the own chat — the server
    /// checks via the folder whether it may hand them out. Without `chatId` it would search the own chat and find nothing.
    private func ownerQuery(_ artifact: ChatArtifact) -> [URLQueryItem] {
        guard let owner = artifact.chatId, owner != chat.id else { return [] }
        return [URLQueryItem(name: "chatId", value: owner)]
    }

    func artifactContent(_ artifact: ChatArtifact) async throws -> ChatArtifactContent {
        try await client.get(
            "/api/chats/\(chat.id)/artifacts/file",
            query: [
                URLQueryItem(name: "path", value: artifact.path),
                URLQueryItem(name: "maxBytes", value: "1048576"),
            ] + ownerQuery(artifact)
        )
    }

    /// Image preview of an artifact. Takes the same path as reading (with the owner's `chatId`) — without it the
    /// server would not find a shared image and the preview would stay empty.
    func artifactImageData(_ artifact: ChatArtifact) async throws -> Data {
        try await client.data(
            "/api/chats/\(chat.id)/artifacts/download",
            query: [
                URLQueryItem(name: "path", value: artifact.path),
                URLQueryItem(name: "inline", value: "1"),
            ] + ownerQuery(artifact)
        )
    }

    /// Edit an artifact BY HAND. The target is ALWAYS this chat — files of neighbouring chats of the same folder stay
    /// read-only (the server rejects them, and an editor that fails on save would be a promise nobody keeps). Returns
    /// the new state so the open preview is right without a detour.
    ///
    /// The list is NOT reloaded; the one row is patched in place: reloading woke `.task(id: sha256)` of the open
    /// preview, which rebuilt the editor — cursor, scroll position and undo were gone after every save. The server's
    /// "artifact_changed" reloads the list anyway; the preview then fetches nothing, because its content already
    /// carries this sha256.
    func saveArtifact(_ artifact: ChatArtifact, text: String, expectedSha256: String) async throws -> ChatArtifact {
        let saved: ChatArtifact = try await client.put(
            "/api/chats/\(chat.id)/artifacts/file",
            body: ArtifactWrite(path: artifact.path, content: text, expectedSha256: expectedSha256)
        )
        if let index = artifacts.firstIndex(where: { $0.id == artifact.id }) {
            artifacts[index] = artifacts[index].afterTheSave(saved)
        }
        return saved
    }

    func downloadArtifact(_ artifact: ChatArtifact) async throws -> URL {
        try await client.downloadToTemporaryFile(
            "/api/chats/\(chat.id)/artifacts/download",
            query: [URLQueryItem(name: "path", value: artifact.path)] + ownerQuery(artifact),
            fallbackName: artifact.name
        )
    }
}
