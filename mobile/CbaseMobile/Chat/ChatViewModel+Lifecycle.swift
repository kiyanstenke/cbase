import Foundation

extension ChatViewModel {

    /// A quote alone is also a message (`quotes`, "Reply" on the text marker).
    var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || !quotes.isEmpty
    }

    var project: Project? {
        workspace.projects.first(where: { $0.id == chat.projectId })
    }

    /// Is a subagent working right now? Drives the dot on the header button. Two kinds:
    /// FOREGROUND is a subagent call in the history without a result; BACKGROUND
    /// (run_in_background) gets its result IMMEDIATELY ("Async agent launched") and never shows up
    /// as running in the history — the event stream reports it instead (`waitAgentsLive`).
    ///
    /// Detection goes through `ChatBlock.isAgentCall` (i.e. `agentToolNames`), not literal
    /// "Task"/"Agent" names: the provider-neutral path uses `mcp__cbase__cbase_agent`.
    ///
    /// Deliberately a QUESTION and not a count: a count would have to merge live-reported agents
    /// with ones open in the history (`subagents`), unpacking every report on each access — for a
    /// dot that only says "yes" or "no". `contains` stops at the first hit.
    var hasRunningSubagents: Bool {
        if !waitAgentsLive.isEmpty { return true }
        guard busy else { return false }
        return timeline.contains { item in
            item.role == .assistant && item.blocks.contains { $0.kind == .tool && $0.isAgentCall && !$0.done }
        }
    }

    /// History and stream start TOGETHER. Running `loadInitial` first and the stream AFTER would lose whatever
    /// happens in between (turn end, a message from another device, completion notice, channel …) until the
    /// next open, because the first `connected` never reconciled. Now EVERY `connected` reconciles against the own state
    /// (`ChatViewModel+Reconcile.swift`); for that it waits for the fetch started here.
    func start() async {
        guard !isDraft else {
            await loadInitial()
            return
        }
        // Create the job first, then the stream: the first `connected` is then guaranteed to find it.
        loadHistory()
        if streamTask == nil { startListening() }
        await loadInitial()
    }

    func startListening() { // internal, for extensions
        guard !isDraft, streamTask == nil else { return }
        eventStreamConnected = false
        streamTask = Task { [weak self] in
            await self?.listen()
        }
    }

    func stopListening() {
        streamTask?.cancel()
        streamTask = nil
        eventStreamConnected = false
    }

    /// Not everything-or-nothing: chat, history and provider must not hang on ONE tuple `await` — if a side
    /// fetch failed, the already loaded history would be discarded and the chat stay empty. The history stands on its
    /// own (`loadHistory`, as soon as `/log` is there — it does not wait for the providers), a
    /// failed side fetch leaves the old value, and the artifacts load outside the path to the history.
    func loadInitial() async {
        if isDraft {
            loadingLog = false
            await loadDraftOptions()
            return
        }
        // `start` has already created the job; any other caller gets its own here.
        if logJob == nil { loadHistory() }
        let id = chat.id
        // The artifacts are a bonus: silent, and a failure leaves the old state (like `try?`).
        Task { [weak self] in
            guard let self else { return }
            if let list: [ChatArtifact] = try? await self.client.get("/api/chats/\(id)/artifacts"), self.chat.id == id {
                self.artifacts = list
            }
        }
        async let freshChat: Chat? = try? client.get("/api/chats/\(id)")
        async let providerData: ProvidersResponse? = try? client.get("/api/providers")
        if let updated = await freshChat, updated.id == chat.id {
            chat = updated
            // A running turn tracks its own context state (`connected`, usage events) — only without one does the number
            // from the chat row apply.
            if !busy { contextTokens = updated.contextTokens }
        }
        if let providerResponse = await providerData {
            providers = providerResponse.providers
            activeProvider = providerResponse.active
        }
        await logJob?.value
        // Afterwards — a bonus that must not hold up the history.
        Task { await loadAutocompact() }
    }

    /// Adopt a newly built history — but ONLY if it really differs.
    /// Reconciling with the server mostly returns exactly the same; every assignment would
    /// still publish and make the list recompute. With stable row ids the comparison is
    /// reliable.
    func applyTimeline(_ rebuilt: [TimelineItem]) { // internal, for extensions
        // The freshly loaded history is the truth: whatever was shown optimistically is
        // either contained in it or never arrived. Keeping a pending echo would be
        // dangerous — it would later swallow an identical new message.
        pendingEchoes = []
        guard rebuilt != timeline else { return }
        timeline = rebuilt
    }

    func reloadChatAndLog() async {
        guard !isDraft else {
            await loadDraftOptions()
            return
        }
        do {
            async let freshChat: Chat = client.get("/api/chats/\(chat.id)")
            // Same range as before (window, `ChatViewModel+Window.swift`): from the first held row to the end.
            async let log: LogWindow = loadWindow(start: logLoaded ? logRows.first?.id : nil)
            let (updated, window) = try await (freshChat, log)
            chat = updated
            contextTokens = updated.contextTokens
            // The state the next `connected` reconciles against (`ChatViewModel+Reconcile.swift`). Called here only without a
            // running turn (run end, instance switch) — there is no open bubble then.
            takeOverHistory(window.rows, beforeWindow: window.beforeWindow, older: window.older)
            artifacts = (try? await client.get("/api/chats/\(chat.id)/artifacts")) ?? artifacts
            onChanged()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func send() async {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // Waiting quotes go FIRST (`withQuotes`) — with them the text never starts with "/", so it is no command.
        // Same computation as on the web (lib/quotes.ts, ChatPane.send).
        let quoteList = quotes
        var text = Self.withQuotes(quoteList, trimmed)
        var display: String?
        let selectedAttachments = attachments
        guard !text.isEmpty || !selectedAttachments.isEmpty else { return }

        // Known commands ALWAYS run locally — with or without an attachment. Without that, a "/goal …"
        // with a large paste (from 1,200 characters it becomes an attachment) would go verbatim to the CLI, and `claude -p` would set ITS
        // goal ("Goal set: …") — one cbase does not know and the next compaction
        // discards. A command handled locally leaves the attachments: they belong to the
        // next message, not the command. Same rule as on the web (ChatPane.send).
        if text.hasPrefix("/") {
            do {
                let command = try await runSlash(text, attachments: selectedAttachments)
                switch command {
                case .handled:
                    input = ""
                    dismissDraft()
                    return
                case .send(let actual, let shown):
                    text = actual
                    display = shown
                case .notCommand:
                    break
                }
            } catch {
                addError(error.localizedDescription)
                return
            }
        }

        input = ""
        dismissDraft()
        attachments = []
        quotes = []
        // If a turn was already running, this message is QUEUED — it then appears in the
        // queue strip above the composer and in the history only once adopted.
        let wasRunning = busy
        busy = true
        // Show the own message IMMEDIATELY — in the same pass as `busy = true`. Otherwise
        // it only appeared once the server echoed it back via SSE: the run indicator
        // showed up noticeably BEFORE the own message, and the two rows pushed the
        // history up in two separate jolts. Together in one pass it is ONE slide-in
        // (see ChatTimelineStage.Coordinator.apply). `/workflow:<shortname>` of the graph workflows
        // is also an ordinary message: the bubble shows the typed line, the server rewrites it for the model.
        let echo = !wasRunning
            ? echoUserMessage(text: display ?? text, attachments: selectedAttachments)
            : nil
        do {
            try await ensureServerChat()
            let resolvedAttachments = try await resolvePendingUploads(selectedAttachments)
            struct Body: Encodable {
                let text: String
                let display: String?
                let attachments: [Attachment]
            }
            // A rejection by the server (e.g. "/workflow:x" unknown, foreign or a workflow already open — 4xx
            // with `{ error, reason }`) runs through the `catch` below: error row, text and attachments back into the field.
            let response: APIMessageResponse = try await client.post(
                "/api/chats/\(chat.id)/message",
                body: Body(text: text, display: display, attachments: resolvedAttachments)
            )
            for attachment in selectedAttachments {
                pendingUploads.removeValue(forKey: attachment.file)
            }
            // The first message of a freshly created draft has arrived — from now on the list
            // leads it (the server shows empty chats in none), and it reloads.
            if firstMessagePending {
                firstMessagePending = false
                afterFirstMessage?(chat)
            }
            if let serverQueue = response.queue { queued = serverQueue }
            // QUEUED or INJECTED instead of started: between the check above and the
            // POST a run may have begun (another client, auto-continue). Then the message
            // belongs in the queue strip or at the end of the running turn — the server handles
            // both, including the event. So take the bubble away.
            if let echo, response.queued == true || response.injected == true { dropEcho(echo) }
            // PARKED: the chat waits at the usage limit or the credit gate, the message sits BEHIND the parked
            // continuation in the queue — nobody is working on it, and `busy` would be a lie: the hexagon
            // would spin for nothing, since a `run_started` only comes with the reset. The stream
            // has no objection — it reports `running: false` for a parked chat, and a
            // reply bubble (`streamOpen`) does not exist without a process. The limit strip and the
            // queue strip show the state. Same rule as on the web (ChatPane.send).
            if response.parked == true { busy = false }
        } catch {
            // With quotes back into their card and the typed text into the field — not the composed one.
            if quoteList.isEmpty {
                input = display ?? text
            } else {
                input = trimmed
                quotes = quoteList
            }
            attachments = selectedAttachments
            if let echo { dropEcho(echo) }
            addError(error.localizedDescription)
            if !streamOpen { busy = false }
        }
    }

    /// Put the own message optimistically into the history and remember its echo. Returns
    /// the row id — with it the bubble can be taken away again if the server
    /// queued the message after all or the POST fails.
    private func echoUserMessage(text: String, attachments: [Attachment]) -> String {
        closeOpenAsksOnUserText()
        let item = TimelineItem(
            role: .user,
            blocks: [ChatBlock(kind: .text, text: text)],
            attachments: attachments
        )
        timeline.append(item)
        pendingEchoes.append(PendingEcho(id: item.id, text: text))
        return item.id
    }

    /// Redeem a remembered echo: if the own message comes back as SSE it is already in the
    /// history — then it must NOT be appended a second time. Returns whether the row
    /// is already there. The displayed text is compared; a slash command sends
    /// its replacement text, the typed form is displayed (and stored).
    func claimEcho(_ text: String) -> Bool { // internal, for extensions
        guard let index = pendingEchoes.firstIndex(where: { $0.text == text }) else { return false }
        pendingEchoes.remove(at: index)
        return true
    }

    private func dropEcho(_ id: String) {
        pendingEchoes.removeAll { $0.id == id }
        timeline.removeAll { $0.id == id }
    }
}
