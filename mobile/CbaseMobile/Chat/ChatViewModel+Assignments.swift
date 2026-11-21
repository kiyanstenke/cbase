// Chat actions of ChatViewModel: stop, steer, queue, attachments, compact, clear.
import Foundation
import UniformTypeIdentifiers

extension ChatViewModel {

    func stopRun() async {
        guard busy, !stopping else { return }
        stopping = true
        do {
            let _: OKResponse = try await client.post("/api/chats/\(chat.id)/stop")
        } catch {
            stopping = false
            addError(error.localizedDescription)
        }
    }

    /// "Steer": abort the running turn and send ALL queued user messages at once — each as its own row, together ONE
    /// run. No confirmation, as in the Codex app.
    ///
    /// The queue is NOT cleared up front: the server clears it and sends `message_queue: []`. Clearing as well would
    /// make the strips vanish before the abort is through — and a failure would leave us with neither display nor text.
    func control() async {
        guard !controlRunning, queued.contains(where: { $0.controllable ?? true }) else { return }
        controlRunning = true
        defer { controlRunning = false }
        do {
            struct Response: Decodable { let ok: Bool; let queue: [QueuedMessage]? }
            let response: Response = try await client.post("/api/chats/\(chat.id)/control")
            if let queue = response.queue { queued = queue }
        } catch {
            addError(error.localizedDescription)
        }
    }

    func cancelQueued(_ item: QueuedMessage) async {
        queued.removeAll { $0.id == item.id }
        do {
            struct Response: Decodable { let ok: Bool; let queue: [QueuedMessage]? }
            let response: Response = try await client.delete("/api/chats/\(chat.id)/message/queue/\(item.id)")
            if let queue = response.queue { queued = queue }
            if input.isEmpty { input = item.text }
        } catch {
            await reloadQueueFromStreamState()
        }
    }

    func upload(name: String, data: Data) async {
        guard !data.isEmpty else { return }
        if isDraft {
            let file = "draft-\(UUID().uuidString)"
            pendingUploads[file] = (name, data)
            attachments.append(Attachment(
                name: name,
                file: file,
                mime: Self.localMimeType(for: name),
                size: data.count
            ))
            return
        }
        uploading = true
        defer { uploading = false }
        do {
            let attachment = try await client.upload(
                "/api/chats/\(chat.id)/attachments",
                name: name,
                data: data,
                asArtifact: !PastedText.matches(name: name)
            )
            attachments.append(attachment)
        } catch {
            addError(L("Upload failed: {msg}", ["msg": error.localizedDescription]))
        }
    }

    /// An image as an attachment — the ONE path for the photos picker and the clipboard: name
    /// "<source>-<seconds>-<number>.<extension>", extension from the type (without a type "jpg"), uploaded via `upload`
    /// (chip, progress, draft before the first send, error line).
    func uploadImage(data: Data, type: UTType?, source: String, number: Int) async {
        let suffix = type?.preferredFilenameExtension ?? "jpg"
        await upload(name: "\(source)-\(Int(Date().timeIntervalSince1970))-\(number).\(suffix)", data: data)
    }

    /// Images from the clipboard ("Paste" in the input field, `ClipboardImages`) — one after another, in the order of
    /// the items. An item without a readable image reports as an error line; the others go out anyway.
    func uploadClipboard(_ images: [NSItemProvider]) async {
        for (index, provider) in images.enumerated() {
            guard let image = await ClipboardImages.load(provider) else {
                addError(L("Could not read the image from the clipboard."))
                continue
            }
            await uploadImage(data: image.data, type: image.type, source: "Bild", number: index + 1)
        }
    }

    /// Store a large paste as an attachment instead of writing it into the input field (see `PastedText`).
    /// The text is known here — so the preview is stored at once, without reloading.
    func uploadPastedText(_ text: String) async {
        let before = attachments.count
        await upload(name: PastedText.fileName(), data: Data(text.utf8))
        if attachments.count > before, let added = attachments.last {
            let preview = PastedText.preview(text)
            pastedPreviews[added.file] = preview
            // Remember it for the timeline too: the card in the message then does not have to fetch the text
            // from the server again.
            PastedPreviewCache.byFile[added.file] = preview
        }
    }

    func removeAttachment(_ attachment: Attachment) {
        attachments.removeAll { $0.id == attachment.id }
        pendingUploads.removeValue(forKey: attachment.file)
        pastedPreviews.removeValue(forKey: attachment.file)
    }

    /// `/compact <instruction>`: appended to the summary task, as in Claude Code (server runs/compaction-baseline.js).
    func compact(instruction: String = "") async throws {
        guard !isDraft else { return }
        guard !busy, !compacting else { return }
        compacting = true
        defer { compacting = false }
        let response: CompactResponse = try await client.post("/api/chats/\(chat.id)/compact", body: ["instruction": instruction])
        if response.ok {
            contextTokens = 0
            chat.contextTokens = 0
        } else if let note = response.note {
            pushInfo(title: "Context", body: note)
        }
    }

    func clearContext() async throws {
        guard !isDraft else {
            pushInfo(title: L("Note"), body: L("There is no history to clear yet."))
            return
        }
        guard !busy, !compacting else {
            pushInfo(title: L("Note"), body: L("The current run must finish before /clear."))
            return
        }
        let response: ClearChatResponse = try await client.post("/api/chats/\(chat.id)/clear")
        applyClear(at: response.at)
    }

    func applyClear(at: Double) { // internal, for extensions
        guard at > lastClearAt else { return }
        lastClearAt = at
        closeOpenAsks()
        for index in timeline.indices { timeline[index].dimmed = true }
        timeline.append(TimelineItem(role: .clear, label: "Chat cleared up to here"))
        contextTokens = 0
        chat.contextTokens = 0
    }
}
