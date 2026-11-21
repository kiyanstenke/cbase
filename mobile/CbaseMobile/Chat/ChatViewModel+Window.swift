// The history in a WINDOW — the iOS part of the contract in server/backend/electron/server/chats/log-window.js (window
// size, bubble boundary, truncation and the parameters live there; the names here are bound by the guard server/backend/test/log-window.test.js).
// The full history used to be loaded, decoded and built entirely at every open (tens of MB in thousands of rows). Now:
//   - `loadWindow` fetches the end (`?window=1`), an older page (`before`) or everything from a row (`start`, reloading the same
//     range). A server without the window answers with the full list — then it counts as a complete window.
//   - `loadOlder` prepends the next older page to the timeline — called by the stage when the reader
//     scrolls to the start (`ChatTimelineStage.Coordinator.scrollViewDidScroll`). The list is mirrored: older rows grow on the side
//     that is not visible, and the stage holds the anchor (`visibleAnchor`/`restore`) — the scroll position stays.
//   - `resolveTruncation` fetches a row truncated in the window in full (`GET …/log/row/<id>`) and inserts the result at the block
//     (button "Load in full" on the tool page, `ChatDetailSheet.swift`).
// Reconciliation against `connected` computes `logRows.count + logBeforeWindow` against `total` (`ChatViewModel+Reconcile.swift`).
import Foundation

/// Answer of `GET /api/chats/:id/log?window=1` — the rows, whether older ones exist, and the server state (as with the delta).
struct LogWindow: Decodable, Sendable {
    let total: Int
    let lastId: Int
    let older: Bool
    let rows: [LogEntry]

    init(total: Int, lastId: Int, older: Bool, rows: [LogEntry]) {
        self.total = total
        self.lastId = lastId
        self.older = older
        self.rows = rows
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = c.int(.total)
        lastId = c.int(.lastId)
        older = (try? c.decodeIfPresent(Bool.self, forKey: .older)) ?? false
        rows = c.list(.rows, LogEntry.self)
    }

    enum CodingKeys: String, CodingKey { case total, lastId, older, rows }

    /// How many server rows lie BEFORE these (only for a window that reaches to the end).
    var beforeWindow: Int { max(0, total - rows.count) }
}

/// A history state for reconciliation: the rows, how many server rows lie before them, and whether they exist.
struct HistoryStatus: Sendable {
    let rows: [LogEntry]
    let beforeWindow: Int
    let older: Bool
}

extension ChatViewModel {
    /// The parameter names — the same as `WINDOW_PARAM` on the server.
    enum WindowParam {
        static let window = "window"
        static let before = "before"
        static let from = "from"
        static let truncate = "truncate"
    }

    /// The history window; `before`: only rows before (older page), `start`: everything from the boundary at or before this row.
    func loadWindow(before: Int? = nil, start: Int? = nil) async throws -> LogWindow { // internal, for extensions
        var query = [URLQueryItem(name: WindowParam.window, value: "1")]
        if let before, before > 0 { query.append(URLQueryItem(name: WindowParam.before, value: String(before))) }
        if let start, start > 0 { query.append(URLQueryItem(name: WindowParam.from, value: String(start))) }
        let path = "/api/chats/\(chat.id)/log"
        do {
            return try await client.get(path, query: query)
        } catch is DecodingError {
            // A server without the window does not know the parameter and returns the full list.
            let full: [LogEntry] = try await client.get(path)
            return LogWindow(total: full.count, lastId: full.last?.id ?? 0, older: false, rows: full)
        }
    }

    /// Append the next older page at the front. Not while a reply is open (its rebuild belongs to the run end) and never
    /// twice at once.
    func loadOlder() {
        guard logLoaded, logOlder, !loadingOlder, openBubble == nil, let first = logRows.first?.id else { return }
        loadingOlder = true
        let id = chat.id
        Task { [weak self] in
            guard let self else { return }
            defer { self.loadingOlder = false }
            guard let page = try? await self.loadWindow(before: first),
                  self.chat.id == id, self.logRows.first?.id == first else { return }
            self.logRows = page.rows + self.logRows
            self.logBeforeWindow = max(0, self.logBeforeWindow - page.rows.count)
            self.logOlder = page.older
            // The older page is built on its own and put BEFORE the timeline — a rebuild from `logRows` would lose what came in live
            // (`row` events, the open reply). `buildTimeline` sets `lastClearAt`; an older page must not take it back.
            let remembered = self.lastClearAt
            let old = self.buildTimeline(page.rows)
            self.lastClearAt = max(remembered, self.lastClearAt)
            let existing = Set(self.timeline.map(\.id))
            self.timeline = old.filter { !existing.contains($0.id) } + self.timeline
        }
    }

    /// Fetch a row truncated in the window in full and insert its result at the tool block.
    func resolveTruncation(row: Int) async {
        guard let full: LogEntry = try? await client.get("/api/chats/\(chat.id)/log/row/\(row)") else { return }
        if let i = logRows.firstIndex(where: { $0.id == row }) { logRows[i] = full }
        guard let object = parseJSON(full.text), let toolId = object["id"]?.stringValue else { return }
        for index in timeline.indices.reversed() where timeline[index].role == .assistant {
            let hit = Self.updateTool(id: toolId, in: &timeline[index].blocks) { tool in
                tool.result = object["result"]?.stringValue ?? ""
                tool.truncated = nil
            }
            if hit { break }
        }
    }
}
