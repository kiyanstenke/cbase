// Reconciling the own history with the server — on open, after every stream gap and after returning from the
// background. The web counterparts are `web/src/components/chat/chatCache.ts` and `chatStream.ts`; the contract with the server is
// `connected` with `lastId`/`total` (`server/backend/electron/server/chats/routes.js`) and the `row` event.
import Foundation

extension ChatViewModel {

    /// The open reply bubble of the running turn — the LAST row, a reply, `streaming`. The truth is the bubble
    /// itself, not `streamOpen`: that flag survived the bubble being cleared away, and the next delta then wrote into a
    /// stored reply.
    var openBubble: Int? {
        guard let index = timeline.indices.last, timeline[index].role == .assistant, timeline[index].streaming else { return nil }
        return index
    }

    /// Fetch the history (`GET /log`) and adopt it as soon as it is there — without waiting for chat, provider or artifacts.
    /// Three attempts with a growing pause; if none succeeds the error is shown and the next `connected` fetches the
    /// whole history (`logLoaded` stays false). An older job is cancelled: its answer would be older than this one.
    @discardableResult
    func loadHistory() -> Task<Void, Never> {
        logJob?.cancel()
        let id = chat.id
        let job = Task { [weak self] in
            var pause: UInt64 = 500_000_000
            for attempt in 1...3 {
                guard let self, !Task.isCancelled else { return }
                do {
                    // Only the end (window, `ChatViewModel+Window.swift`); older rows load on scrolling up.
                    let window = try await self.loadWindow()
                    guard !Task.isCancelled, self.chat.id == id else { return }
                    self.takeOverHistory(window.rows, beforeWindow: window.beforeWindow, older: window.older)
                    self.error = ""
                    self.reconcileError = ""
                    self.loadingLog = false
                    return
                } catch {
                    if Task.isCancelled { return }
                    if attempt == 3 {
                        self.error = error.localizedDescription
                        // Curable: if the next `connected` fetches the history, it takes the error back (`connected`).
                        self.reconcileError = self.error
                        self.loadingLog = false
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: pause)
                pause *= 2
            }
        }
        logJob = job
        return job
    }

    /// Make a freshly read history the truth: `logRows` and `timeline` in ONE step. If a bubble of the running
    /// turn is open it is NOT replaced: its text is partly not stored yet, and the following deltas would otherwise attach
    /// to the last stored reply. Then the run end fetches the history (`joinedMidRun`), and `logRows` stays
    /// what it was — it describes the history `timeline` was built from.
    /// `beforeWindow`/`older`: how many server rows lie before the window and whether they exist — without them `rows` is the
    /// whole history.
    func takeOverHistory(_ rows: [LogEntry], beforeWindow: Int = 0, older: Bool = false) { // internal, for extensions
        if openBubble != nil {
            joinedMidRun = true
            return
        }
        streamOpen = false
        streamGotText = false
        logRows = rows
        logBeforeWindow = beforeWindow
        logOlder = older
        logLoaded = true
        applyTimeline(buildTimeline(rows))
    }

    /// The reconciliation of a `connected` (called from `connected`, AWAITED — the events behind it wait in the stream).
    ///
    /// The server reports its state at connection time: `lastId` (highest row id) and `total` (row count). The
    /// right history is exactly "all rows up to `lastId`" — what is written afterwards arrives as an event on THIS stream
    /// (taking a row above `lastId` along here would append it a second time with its event). Below it sits the
    /// streamed, not yet stored text of the running turn (`streamText`) as an open bubble — together that is
    /// the server state, without gap and without duplicate.
    func reconcileHistory(_ event: JSONValue, running: Bool) async { // internal, for extensions
        // The first fetch runs in parallel to the stream (`start`) — reconciling against a half state would mean fetching everything twice.
        if let job = logJob { await job.value }
        if Task.isCancelled { return }
        let streamText = event["streamText"]?.stringValue ?? ""
        let truncated = event["streamTextTruncated"]?.boolValue == true
        // A turn is running and its bubble is open here (return from the background, stream gap). If it matches the server's
        // buffer, at most its end is missing: patch it, the run end fetches the rest (`joinedMidRun`, set by `connected`).
        if running, openBubble != nil {
            if supplementOpenBubble(streamText, truncated: truncated) { return }
            // If it does NOT match, it is not the bubble of this buffer — a turn ended in the gap and a follow-up turn is
            // running (graph workflow, goal, queued message), or its block has been stored meanwhile and a new one began.
            // Doing nothing then would let the deltas of the new block attach to its old text
            // ("I read the FiThe file contains …") and the rows from the gap would be missing until the run end. So the full reconciliation —
            // "rows up to `lastId` + `streamText`" is the whole state by the definition above. Without a state (network, server without
            // `lastId`) the bubble stays: nothing would replace it, and the next `connected` tries again.
            guard let lastId = event["lastId"]?.intValue, let total = event["total"]?.intValue,
                  let history = await historyUntil(lastId: lastId, total: total) else { return }
            if Task.isCancelled { return }
            closeOpenBubble()
            takeOverHistory(history.rows, beforeWindow: history.beforeWindow, older: history.older)
            takeOverStreamText(streamText, truncated: truncated)
            return
        }
        // The turn ended in the gap: close its bubble, the history below brings the stored version.
        if !running, streamOpen || openBubble != nil { finishAssistant() }
        let history: HistoryStatus?
        if let lastId = event["lastId"]?.intValue, let total = event["total"]?.intValue {
            history = await historyUntil(lastId: lastId, total: total)
        } else if !running {
            // A server without `lastId`: without a running turn the whole history (also heals the first open); with a turn nothing —
            // without `lastId` there is no telling what arrives afterwards as an event.
            let full: [LogEntry]? = try? await client.get("/api/chats/\(chat.id)/log")
            history = full.map { HistoryStatus(rows: $0, beforeWindow: 0, older: false) }
        } else {
            history = nil
        }
        if Task.isCancelled { return }
        if let history, !(logLoaded && history.rows == logRows && history.beforeWindow == logBeforeWindow) {
            takeOverHistory(history.rows, beforeWindow: history.beforeWindow, older: history.older)
        }
        if running {
            takeOverStreamText(streamText, truncated: truncated)
        }
    }

    /// All rows up to `lastId` — from the own state where it suffices, else via the delta, else the window anew. The cross-check
    /// is the total count (as on the web, `deltaAddsUp`): the held rows PLUS those before them (`logBeforeWindow`, window)
    /// — if a row is missing or one was deleted (cleaned-up partial output of an aborted run), the count
    /// does not add up, and the same range is reloaded (`start` = first held row). `nil` means: nothing could be fetched (network) —
    /// then the own state stays, and the next `connected` tries again.
    private func historyUntil(lastId: Int, total: Int) async -> HistoryStatus? {
        let id = chat.id
        if logLoaded {
            let have = logRows.filter { $0.id <= lastId }
            // The most common case: nothing new — no fetch.
            if have.count + logBeforeWindow == total, (have.last?.id ?? 0) == lastId {
                return HistoryStatus(rows: have, beforeWindow: logBeforeWindow, older: logOlder)
            }
            let since = have.last?.id ?? 0
            if let delta: LogDelta = try? await client.get(
                "/api/chats/\(id)/log/delta",
                query: [URLQueryItem(name: "since", value: String(since)), URLQueryItem(name: WindowParam.truncate, value: "1")]
            ) {
                let together = have + delta.rows.filter { $0.id > since && $0.id <= lastId }
                if together.count + logBeforeWindow == total {
                    return HistoryStatus(rows: together, beforeWindow: logBeforeWindow, older: logOlder)
                }
            }
            if Task.isCancelled { return nil }
        }
        guard let window = try? await loadWindow(start: logLoaded ? logRows.first?.id : nil) else { return nil }
        return HistoryStatus(rows: window.rows.filter { $0.id <= lastId }, beforeWindow: window.beforeWindow, older: window.older)
    }

    /// The end the open bubble is missing — the text the turn wrote while this stream was dead. `streamText` is
    /// the not yet stored text of the running turn; if the bubble's last text block carries exactly its beginning, only
    /// the end is missing. → `true`: the bubble belongs to this buffer (patched where needed). `false`: it does not fit (a block was
    /// stored meanwhile, a follow-up turn is running, the bubble ends with a tool or is empty, the buffer is empty) — then
    /// the full reconciliation decides (`reconcileHistory`); never patch across a seam that does not join (same rule
    /// as `web/src/lib/stream.ts`). Remains open: a bubble of ANOTHER turn whose text happens to be the beginning of the buffer —
    /// not separable without a turn id in `connected`.
    ///
    /// Truncated (`streamTextTruncated`, the server buffer stopped at 200,000 characters): what was written beyond the cap
    /// is missing between this bubble and the next delta — the marker says so, as in `takeOverStreamText`; without it the deltas
    /// would join without a word and up to 100,000 characters would be missing mid-sentence. If the bubble has more
    /// than the truncated buffer, its text stays (it is correct, just not complete) — with the same marker.
    private func supplementOpenBubble(_ server: String, truncated: Bool) -> Bool {
        guard !server.isEmpty, let index = openBubble, let last = timeline[index].blocks.indices.last,
              timeline[index].blocks[last].kind == .text else { return false }
        let have = timeline[index].blocks[last].text
        if server.hasPrefix(have) {
            if server.count > have.count {
                timeline[index].blocks[last].text = have + server.dropFirst(have.count)
            }
        } else if !(truncated && have.hasPrefix(server)) {
            return false
        }
        streamOpen = true
        streamGotText = true
        if truncated { appendText(Self.bufferGapMarker, parentId: nil) }
        return true
    }

    /// Close the open reply bubble without touching `busy` (unlike `finishAssistant`): an empty one is removed, one with
    /// content stays as a finished row. For a row that falls between the parts of the turn (`rowFromStream`), and for the
    /// full reconciliation mid-run — there the history replaces it right afterwards.
    func closeOpenBubble() { // internal, for extensions
        guard let index = openBubble else { return }
        if timeline[index].blocks.isEmpty { timeline.remove(at: index) } else { timeline[index].streaming = false }
        streamOpen = false
        streamingText = false
    }

    /// Server `row` event: a row written into this chat outside the own turn stream (role `hint`) — in
    /// the same form as a row from `GET /log`. Appended only above the own state (`logRows` and earlier `row`
    /// events); below it, it is already there. Like a card (`pushCapture`) it closes an open reply bubble — in the stored
    /// history it likewise sits between the parts of the turn.
    func rowFromStream(_ event: JSONValue) { // internal, for extensions
        guard let raw = event["row"], let data = try? JSONEncoder().encode(raw),
              let row = try? JSONDecoder().decode(LogEntry.self, from: data), row.id > 0 else { return }
        guard row.id > max(logRows.last?.id ?? 0, streamRowsId) else { return }
        streamRowsId = row.id
        // `buildTimeline` starts with `lastClearAt = 0` — a single row must not erase the state of the whole history.
        let remembered = lastClearAt
        let fresh = buildTimeline([row]).filter { item in !timeline.contains { $0.id == item.id } }
        lastClearAt = max(remembered, lastClearAt)
        guard !fresh.isEmpty else { return }
        closeOpenBubble()
        timeline.append(contentsOf: fresh)
    }

    /// Back from the background (`UIApplication.willEnterForegroundNotification`, registered in init) — only a view that is
    /// currently listening (`streamTask`; `onDisappear` ended it). The old stream is often dead without anyone noticing: drop
    /// it, start a new one with a fresh wait time, and its `connected` reconciles — mid-turn without replacing the open
    /// bubble.
    func reconnect() {
        guard !isDraft, streamTask != nil else { return }
        stopListening()
        startListening()
    }
}
