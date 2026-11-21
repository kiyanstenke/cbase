import Foundation

extension ChatViewModel {

    func loadDraftOptions() async { // internal, for extensions
        do {
            let providerResponse: ProvidersResponse = try await client.get("/api/providers")
            providers = providerResponse.providers
            activeProvider = providerResponse.active

            let provider = providers.first(where: { $0.id == chat.provider && $0.connected })
                ?? providers.first(where: { $0.id == providerResponse.active && $0.connected })
                ?? providers.first(where: \.connected)
            if chat.provider.isEmpty {
                chat.provider = provider?.id ?? ""
            }
            if chat.model.isEmpty {
                chat.model = provider?.defaultModel ?? provider?.models.first?.id ?? ""
            }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    func ensureServerChat() async throws { // internal, for extensions
        guard isDraft else { return }
        // ONE creation per draft. A second send (or a change, see `updateSettings`) during
        // the `POST` waits for the same job and then goes to the created chat — otherwise it would create a second one.
        if let running = creationJob {
            try await running.value
            return
        }
        let job = Task { try await self.createDraftNow() }
        creationJob = job
        defer { creationJob = nil }
        try await job.value
    }

    /// Waits for a running creation: a change that arrives meanwhile applies to the CREATED chat — on the draft
    /// it would be lost, because the `POST` response replaces it. If the creation fails the draft stays; then the
    /// change applies to it, and the error is already shown at the send that triggered it.
    func waitForCreation() async { // internal, for extensions
        guard let running = creationJob else { return }
        _ = try? await running.value
    }

    /// The creation itself — only via `ensureServerChat` (one job per draft).
    private func createDraftNow() async throws {
        let draft = chat
        let created = try await createChatNow(draft)

        chat = created
        contextTokens = created.contextTokens
        isDraft = false
        // A freshly created chat has an EMPTY history — known, not unknown. Without this line the first `connected` would fetch
        // the whole history (`logLoaded` false) and sweep away the optimistically shown first message with it
        // (`ChatViewModel+Reconcile.swift`).
        logRows = []
        logLoaded = true
        // The draft moves from the new key to the chat id: whatever still lies there belongs
        // to this chat from now on, and the next draft in the same folder starts empty.
        let newKey = draftKey
        draftKey = Self.draftKey(chatId: created.id)
        if let rest = UserDefaults.standard.string(forKey: newKey) {
            UserDefaults.standard.set(rest, forKey: draftKey)
        }
        UserDefaults.standard.removeObject(forKey: newKey)
        // Waiting quotes (in app memory, `quoteDeposit`) move along.
        if let waiting = Self.quoteDeposit.removeValue(forKey: newKey) { Self.quoteDeposit[draftKey] = waiting }
        onCreated(created)
        onChanged()
        // The view keeps the chat open; the list leads it only from the first message (`afterFirstMessage` in `send`).
        firstMessagePending = true
        atCreation?(created)
        startListening()

        if !draft.goal.isEmpty {
            // Goal and pause in ONE step: the server takes both fields together (with both, both apply,
            // `goal` alone withdraws the pause). Two PATCHes would leave a goal paused in the draft
            // unpaused from the first turn if the second failed.
            struct GoalBody: Encodable { let goal: String; let goalPaused: Bool }
            chat = try await client.patch(
                "/api/chats/\(created.id)",
                body: GoalBody(goal: draft.goal, goalPaused: draft.goalPaused)
            )
            onCreated(chat)
        }

        for _ in 0..<40 where !eventStreamConnected {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    /// Create a Coding chat with the draft's values (`POST /api/chats`) — EXACTLY what the entry and the composer
    /// chose.
    private func createChatNow(_ draft: Chat) async throws -> Chat {
        struct Body: Encodable {
            let workspaceId: String
            let projectId: String?
            // A draft begun from a chat folder lands there too.
            let folderId: String?
            let model: String
            let permissionMode: String
            let effort: String
            let provider: String?
            let browserMode: String
            /// Ultracode: only sent if the draft carries it — creating with it acts like switching it on.
            let ultracode: Bool?
            /// The copy chosen in the composer — only a copy goes along, main is the server's default.
            let instance: String?
        }

        do {
            return try await client.post("/api/chats", body: Body(
                workspaceId: workspace.id,
                projectId: draft.projectId,
                folderId: draft.folderId,
                model: draft.model,
                permissionMode: draft.permissionMode,
                // No level chosen ⇒ the provider's default level, clamped.
                effort: draft.effort.isEmpty
                    ? EffortLevels.standard(providers, provider: EffortLevels.effectiveProvider(draft.provider, active: activeProvider), model: draft.model)
                    : draft.effort,
                provider: draft.provider.isEmpty ? nil : draft.provider,
                browserMode: draft.browserMode,
                ultracode: draft.ultracode ? true : nil,
                instance: InstancesTree.copyName(draft.instance ?? "") != nil && draft.projectId != nil ? draft.instance : nil
            ))
        } catch let e as APIError where e.code == "UNKNOWN_INSTANCE" && draft.instance != nil {
            // The chosen copy no longer exists (the list had not reported it yet). The choice falls back
            // to main, the error is shown, and the next send creates the chat in main — otherwise every attempt failed immediately.
            chat.instance = nil
            throw e
        }
    }

    func resolvePendingUploads(_ selected: [Attachment]) async throws -> [Attachment] { // internal, for extensions
        var resolved: [Attachment] = []
        for attachment in selected {
            if let pending = pendingUploads[attachment.file] {
                let uploaded = try await client.upload(
                    "/api/chats/\(chat.id)/attachments",
                    name: pending.name,
                    data: pending.data,
                    asArtifact: !PastedText.matches(name: pending.name)
                )
                // The draft had its own id (`draft-…`) — re-key the preview,
                // otherwise the card shows in the history without text.
                if let preview = pastedPreviews.removeValue(forKey: attachment.file) {
                    pastedPreviews[uploaded.file] = preview
                    PastedPreviewCache.byFile[uploaded.file] = preview
                }
                resolved.append(uploaded)
            } else {
                resolved.append(attachment)
            }
        }
        return resolved
    }

    static func localMimeType(for name: String) -> String { // internal, for extensions
        switch URL(fileURLWithPath: name).pathExtension.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "heic": return "image/heic"
        case "webp": return "image/webp"
        case "pdf": return "application/pdf"
        case "json": return "application/json"
        case "txt", "md": return "text/plain"
        default: return "application/octet-stream"
        }
    }

    func totalInputTokens(_ usage: JSONValue) -> Int { // internal, for extensions
        (usage["input_tokens"]?.intValue ?? 0)
            + (usage["cache_read_input_tokens"]?.intValue ?? 0)
            + (usage["cache_creation_input_tokens"]?.intValue ?? 0)
    }

    func resultText(_ value: JSONValue?) -> String { // internal, for extensions
        guard let value else { return "" }
        if let text = value.stringValue { return text }
        if let array = value.arrayValue {
            return array.compactMap {
                $0["text"]?.stringValue
                    ?? ($0["type"]?.stringValue == "image" ? L("[Image]") : nil)
                    ?? $0.stringValue
            }.joined(separator: "\n")
        }
        return value.prettyPrinted
    }

    func deriveDetail(_ input: JSONValue?) -> String { // internal, for extensions
        guard let input else { return "" }
        for key in ["command", "file_path", "path", "pattern", "url", "query", "notebook_path", "bash_id", "shell_id", "description"] {
            if let value = input[key]?.stringValue, !value.isEmpty {
                return String(value.replacingOccurrences(of: "\n", with: " ").prefix(100))
            }
        }
        return ""
    }

    func decodeArray<T: Decodable>(_ value: JSONValue?, as type: T.Type) -> [T]? { // internal, for extensions
        guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode([T].self, from: data)
    }

    private static func append(_ block: ChatBlock, toChildrenOf id: String, in blocks: inout [ChatBlock]) -> Bool {
        for index in blocks.indices where blocks[index].kind == .tool {
            if blocks[index].toolUseId == id {
                blocks[index].children.append(block)
                return true
            }
            if append(block, toChildrenOf: id, in: &blocks[index].children) { return true }
        }
        return false
    }

    /// On REBUILD the same as `mutateUnderParent` in the live stream: backwards through all
    /// assistant bubbles. Without a hit nothing happens — the caller then discards the block.
    /// Only the CURRENTLY open bubble used to be searched.
    static func attachUnderParent(_ block: ChatBlock, parent: String, in items: inout [TimelineItem]) -> Bool { // internal, for extensions
        for index in items.indices.reversed() where items[index].role == .assistant {
            if append(block, toChildrenOf: parent, in: &items[index].blocks) { return true }
        }
        return false
    }

    static func mutateChildren( // internal, for extensions
        of id: String,
        in blocks: inout [ChatBlock],
        mutate: (inout [ChatBlock]) -> Void
    ) -> Bool {
        for index in blocks.indices where blocks[index].kind == .tool {
            if blocks[index].toolUseId == id {
                mutate(&blocks[index].children)
                return true
            }
            if mutateChildren(of: id, in: &blocks[index].children, mutate: mutate) { return true }
        }
        return false
    }

    /// `onlyOpen`: only hit a block that carries no input and no result yet (that is how
    /// content_block_start alone creates it, input `{}`). Codex counts its item ids anew per process (item_0, item_1, … in every turn
    /// and every subagent) — a finished or already filled block with the same id is a DIFFERENT call
    /// (twin of `web/src/lib/tool-result.ts:applyToolInput`).
    static func updateTool( // internal, for extensions
        id: String,
        in blocks: inout [ChatBlock],
        onlyOpen: Bool = false,
        mutate: (inout ChatBlock) -> Void
    ) -> Bool {
        for index in blocks.indices where blocks[index].kind == .tool {
            if blocks[index].toolUseId == id, !onlyOpen || isOpen(blocks[index]) {
                mutate(&blocks[index])
                return true
            }
            if updateTool(id: id, in: &blocks[index].children, onlyOpen: onlyOpen, mutate: mutate) { return true }
        }
        return false
    }

    private static func isOpen(_ block: ChatBlock) -> Bool {
        if block.done || block.result != nil { return false }
        switch block.input {
        case nil, .null?: return true
        case .object(let o)?: return o.isEmpty
        default: return false
        }
    }

    /// Label of the compaction marker, the same for event stream and meta row: both
    /// carry `auto`, and whoever typed `/compact` themselves should be able to tell it from the level.
    /// Untranslated — the separator row localizes when rendering.
    static func compactedLabel(auto: Bool?) -> String { // internal, for extensions
        auto == true ? "Context compacted automatically" : "Context compacted"
    }
}
