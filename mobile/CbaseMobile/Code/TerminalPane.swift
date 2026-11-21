import SwiftUI
import UIKit

// Terminal tab: several PTY sessions per scope. Output arrives over SSE, input by POST, same as the desktop client. The PTY is NOT
// ended on leaving: running commands keep working in the background, and on return the server replays the buffer: a new session the
// whole buffer, an existing one after an interruption only the rest from `until`.
//
// Surfaces and colors only: header, output and key bar sit directly on `CbColor.grund`; the output takes the page background color
// (light and dark, the role is dynamic) instead of standing in front as a raised box. A `CbHairline` between header and output and
// between output and key bar, as an overlay so that the PTY's character grid (`applyGrid`) measures the same height as before.

/// A very compact ANSI interpreter: enough for prompts, progress lines and `clear`.
/// Deliberately not a full VT100: control sequences we do not map are discarded cleanly instead of shown as garbage.
final class AnsiTerminalBuffer {
    private(set) var lines: [String] = [""]
    private var row = 0
    private var col = 0
    private var pending = ""
    private let maxLines = 1500

    var text: String { lines.joined(separator: "\n") }

    func reset() {
        lines = [""]
        row = 0
        col = 0
        pending = ""
    }

    func feed(_ chunk: String) {
        let input = Array(pending + chunk)
        pending = ""
        var index = 0

        while index < input.count {
            let character = input[index]
            switch character {
            case "\u{1B}":
                // Sequence possibly incomplete → keep the rest for the next chunk.
                guard let consumed = handleEscape(input, from: index) else {
                    pending = String(input[index...])
                    return
                }
                index += consumed
                continue
            case "\r":
                col = 0
            case "\n":
                row += 1
                if row >= lines.count { lines.append("") }
                col = 0
                trim()
            case "\u{8}":
                col = max(0, col - 1)
            case "\t":
                let spaces = 8 - (col % 8)
                write(String(repeating: " ", count: spaces))
            case "\u{7}":
                break // ignore bell
            default:
                if character.isNewline {
                    row += 1
                    if row >= lines.count { lines.append("") }
                    col = 0
                    trim()
                } else {
                    write(String(character))
                }
            }
            index += 1
        }
    }

    /// Returns the number of consumed characters, or nil for an incomplete sequence.
    private func handleEscape(_ input: [Character], from start: Int) -> Int? {
        guard start + 1 < input.count else { return nil }
        let next = input[start + 1]

        if next == "[" {
            var cursor = start + 2
            var params = ""
            while cursor < input.count {
                let character = input[cursor]
                if character.isNumber || character == ";" || character == "?" || character == ">" {
                    params.append(character)
                    cursor += 1
                    continue
                }
                applyCSI(final: character, params: params)
                return cursor - start + 1
            }
            return nil
        }

        if next == "]" {
            // Discard OSC up to BEL or ST.
            var cursor = start + 2
            while cursor < input.count {
                if input[cursor] == "\u{7}" { return cursor - start + 1 }
                if input[cursor] == "\u{1B}", cursor + 1 < input.count, input[cursor + 1] == "\\" {
                    return cursor - start + 2
                }
                cursor += 1
            }
            return nil
        }

        if next == "(" || next == ")" {
            return start + 2 < input.count ? 3 : nil
        }

        return 2 // discard a simple escape sequence
    }

    private func applyCSI(final: Character, params: String) {
        let numbers = params.split(separator: ";").compactMap { Int($0) }
        let first = numbers.first ?? 0
        switch final {
        case "m", "h", "l", "s", "u", "n", "r", "t", "q":
            break // colors/modes/queries: ignore
        case "A":
            row = max(0, row - max(1, first))
        case "B":
            row = min(lines.count - 1, row + max(1, first))
        case "C":
            col += max(1, first)
        case "D":
            col = max(0, col - max(1, first))
        case "G":
            col = max(0, first - 1)
        case "H", "f":
            // Only the column share can be mapped sensibly (no fixed window).
            col = max(0, (numbers.count > 1 ? numbers[1] : 1) - 1)
        case "K":
            eraseInLine(mode: first)
        case "J":
            if first == 2 || first == 3 {
                lines = [""]
                row = 0
                col = 0
            } else {
                lines = Array(lines.prefix(row + 1))
                eraseInLine(mode: 0)
            }
        case "P":
            deleteCharacters(max(1, first))
        default:
            break
        }
    }

    private func eraseInLine(mode: Int) {
        guard row < lines.count else { return }
        var line = Array(lines[row])
        switch mode {
        case 1:
            for index in 0..<min(col, line.count) { line[index] = " " }
        case 2:
            line = []
            col = 0
        default:
            if col < line.count { line = Array(line.prefix(col)) }
        }
        lines[row] = String(line)
    }

    private func deleteCharacters(_ count: Int) {
        guard row < lines.count else { return }
        var line = Array(lines[row])
        guard col < line.count else { return }
        let end = min(line.count, col + count)
        line.removeSubrange(col..<end)
        lines[row] = String(line)
    }

    private func write(_ text: String) {
        while row >= lines.count { lines.append("") }
        var line = Array(lines[row])
        for character in text {
            if col < line.count {
                line[col] = character
            } else {
                while line.count < col { line.append(" ") }
                line.append(character)
            }
            col += 1
        }
        lines[row] = String(line)
    }

    private func trim() {
        if lines.count > maxLines {
            let drop = lines.count - maxLines
            lines.removeFirst(drop)
            row = max(0, row - drop)
        }
    }
}

@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id: String
    @Published var title: String
    @Published var output = ""
    @Published var status: Status = .idle
    @Published var error = ""
    @Published var termId: String?

    enum Status: Equatable { case idle, connecting, ready, exited, unavailable }

    private let buffer = AnsiTerminalBuffer()
    private let client: APIClient
    private let apiBase: String
    /// The copy chosen in the code tab: the terminal starts in its container (nil = main).
    private let instance: String?
    private var streamTask: Task<Void, Never>?
    /// The server's position after the last data event (`until`): on reconnect it goes back as `?from=` and the server sends only
    /// the rest instead of the whole buffer (server/backend/electron/server/terminal.js). nil = nothing seen from this PTY yet ⇒
    /// first fetch, the whole buffer. Never counted here: Swift counts characters differently from the server (JS).
    private var until: Int?

    init(id: String, title: String, termId: String?, client: APIClient, apiBase: String, instance: String? = nil) {
        self.id = id
        self.title = title
        self.termId = termId
        self.client = client
        self.apiBase = apiBase
        self.instance = instance
    }

    deinit { streamTask?.cancel() }

    func start() async {
        // If the session exists but no longer listens (after `detach()`), attach again with `?from=`, so only the new part arrives.
        if status == .ready { listen(); return }
        // `.unavailable` is no end state: whoever reopens the tab tries once more (the stream stops on a 4xx instead of knocking
        // forever, see `listen()`; after a new sign-in the terminal must not stay dead for good).
        guard status == .idle || status == .exited || status == .unavailable else { return }
        status = .connecting
        var tid = termId ?? ""
        if !tid.isEmpty {
            let exists: TerminalExistsResponse? = try? await client.get("/api/terminal/\(tid)/exists")
            if exists?.exists != true { tid = "" }
        }
        if tid.isEmpty {
            struct Body: Encodable { let cols: Int; let rows: Int }
            do {
                let session: TerminalSessionResponse = try await client.post(
                    "\(apiBase)/terminal",
                    query: CodeInstance.query(instance),
                    body: Body(cols: 80, rows: 24)
                )
                guard session.available else {
                    error = session.error ?? L("Terminal not available")
                    status = .unavailable
                    return
                }
                tid = session.id
            } catch {
                self.error = error.localizedDescription
                status = .unavailable
                return
            }
        }
        if tid != termId { until = nil } // a new PTY counts from the start
        termId = tid
        status = .ready
        listen()
    }

    /// Listens to the PTY's stream and reconnects after an UNEXPECTED end. Without that, an interruption ended it silently: the status
    /// stayed `.ready`, `start()` returned at once, the terminal was deaf; an idle stream also ended regularly at URLSession's 45 s
    /// deadline (the server had no heartbeat). Reconnects with `?from=<until>`, after a short wait (1, 2, 4, 8, then 15 s; every event
    /// resets). Not after `exit` (the PTY is gone), not after `detach()`/`kill()`, not after the task was cancelled and not after a
    /// 4xx: the next try would fail the same way (signed out, wrong address); then "Terminal unavailable" shows with the reason
    /// instead of knocking every 15 s. Between two events the task does NOT hold the session: if it drops out of the model (a scope
    /// or instance change rebuilds `terminals`), `deinit` ends the stream; with the heartbeat a forgotten stream would never end and
    /// would occupy one of the eight connections per host (APIClient).
    /// Without a resume point the FIRST data event is the server's whole buffer: it replaces what is here, even if an old server
    /// (without `until`/`replaced`) does not mark it; otherwise iOS would append the history again after every interruption.
    private func listen() {
        guard let tid = termId, streamTask == nil else { return }
        let client = self.client
        streamTask = Task { [weak self] in
            var failedAttempts = 0
            while !Task.isCancelled {
                guard let query = self?.resumption() else { return }
                var replaceFirst = query.isEmpty
                var ended = false
                var denied: APIError?
                do {
                    for try await (event, payload) in client.namedStream("/api/terminal/\(tid)/stream", query: query) {
                        guard let self else { return }
                        failedAttempts = 0
                        if event == "exit" {
                            self.status = .exited
                            ended = true
                            break
                        }
                        if self.take(payload, replace: replaceFirst) { replaceFirst = false }
                    }
                } catch let error as APIError where (400..<500).contains(error.status) {
                    denied = error
                } catch {
                    // Connection dropped: reconnect below.
                }
                if let denied {
                    self?.error = denied.localizedDescription
                    self?.status = .unavailable
                    break
                }
                if ended || Task.isCancelled { break }
                failedAttempts += 1
                let seconds = min(15, 1 << min(failedAttempts - 1, 4))
                try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            }
            // After `detach()`/`kill()` a new task may already stand there; only the own, undisturbed end clears.
            if !Task.isCancelled { self?.streamTask = nil }
        }
    }

    /// The resume point as a query; empty while nothing came from this PTY (first fetch: the whole buffer).
    private func resumption() -> [URLQueryItem] {
        until.map { [URLQueryItem(name: "from", value: String($0))] } ?? []
    }

    /// A data event: remember `until`; `replaced` (from the server, or `replace` for the first piece of a fetch without a point) ⇒
    /// clear the buffer first: the server sends everything it has, appended the history would show twice; feed `d`. An empty `d`
    /// only sets the position. Returns whether it was a data event (the heartbeat `{}` has no `d` and does not count).
    @discardableResult
    private func take(_ payload: JSONValue, replace: Bool = false) -> Bool {
        guard let data = payload["d"]?.stringValue else { return false }
        let replaced = replace || payload["replaced"]?.boolValue == true
        if let fresh = payload["until"]?.intValue { until = fresh }
        if replaced { buffer.reset() }
        if !data.isEmpty { buffer.feed(data) }
        if replaced || !data.isEmpty { output = buffer.text }
        return true
    }

    func send(_ data: String) {
        guard let tid = termId else { return }
        struct Body: Encodable { let data: String }
        Task { _ = try? await client.send("/api/terminal/\(tid)/input", body: Body(data: data)) }
    }

    func resize(cols: Int, rows: Int) {
        guard let tid = termId else { return }
        struct Body: Encodable { let cols: Int; let rows: Int }
        Task { _ = try? await client.send("/api/terminal/\(tid)/resize", body: Body(cols: cols, rows: rows)) }
    }

    func clearBuffer() {
        buffer.reset()
        output = ""
    }

    /// End the PTY for good (only when the session is closed).
    func kill() {
        streamTask?.cancel()
        streamTask = nil
        guard let tid = termId else { return }
        Task { _ = try? await client.send("/api/terminal/\(tid)", method: .delete) }
    }

    /// Release the stream, the PTY keeps running (from `activate`/`newSession` for the previously active session and on leaving
    /// the tab). Since the heartbeat a stream no longer ends by itself; without this EVERY session ever opened would permanently hold
    /// one of the eight connections per host. `start()` reattaches with `?from=`, only the new part arrives.
    func detach() {
        streamTask?.cancel()
        streamTask = nil
    }
}

@MainActor
final class TerminalSessionsModel: ObservableObject {
    @Published var sessions: [TerminalSession] = []
    @Published var activeId: String?

    private let client: APIClient
    private let apiBase: String
    private let scopeKey: String
    /// The copy chosen in the code tab and its name: sessions then exist per instance (own storage key), the view names the copy.
    /// nil = main, key and addresses as before.
    let instance: String?
    let copy: String?

    var active: TerminalSession? {
        sessions.first(where: { $0.id == activeId }) ?? sessions.first
    }

    init(client: APIClient, apiBase: String, scopeKey: String, instance: String? = nil, copy: String? = nil) {
        self.client = client
        self.apiBase = apiBase
        self.scopeKey = scopeKey
        self.instance = instance
        self.copy = copy
        restore()
    }

    private var storageKey: String { "cbase.mobile.terms:\(scopeKey)" + (instance.map { "@\($0)" } ?? "") }

    private func restore() {
        guard let raw = UserDefaults.standard.array(forKey: storageKey) as? [[String: String]] else { return }
        sessions = raw.compactMap { entry in
            guard let id = entry["id"], let title = entry["title"] else { return nil }
            return TerminalSession(id: id, title: title, termId: entry["termId"], client: client, apiBase: apiBase, instance: instance)
        }
        activeId = sessions.first?.id
    }

    func persist() {
        let raw: [[String: String]] = sessions.map { session in
            var entry = ["id": session.id, "title": session.title]
            if let termId = session.termId { entry["termId"] = termId }
            return entry
        }
        UserDefaults.standard.set(raw, forKey: storageKey)
    }

    func newSession() {
        let number = nextNumber()
        let session = TerminalSession(
            id: UUID().uuidString,
            title: L("Terminal {n}", ["n": number]),
            termId: nil,
            client: client,
            apiBase: apiBase,
            instance: instance
        )
        releaseActive(except: session)
        sessions.append(session)
        activeId = session.id
        persist()
        Task {
            await session.start()
            persist()
        }
    }

    func close(_ session: TerminalSession) {
        session.kill()
        sessions.removeAll { $0.id == session.id }
        if activeId == session.id { activeId = sessions.last?.id }
        persist()
    }

    func activate(_ session: TerminalSession) {
        releaseActive(except: session)
        activeId = session.id
        Task {
            await session.start()
            persist()
        }
    }

    func ensureSession() {
        if sessions.isEmpty { return }
        if let active { Task { await active.start() } }
    }

    /// On leaving the terminal tab (TerminalsPane `.onDisappear`): release all streams. Back in the tab `ensureSession` reattaches the
    /// active session with `?from=`. A scope or instance change discards the whole model; there the stream ends via `deinit`,
    /// because the task does not hold the session between two events.
    func detachAll() {
        for session in sessions { session.detach() }
    }

    /// Only the shown session holds a stream: the previously active one is released, its PTY keeps running. With N tabs N streams
    /// would otherwise stay open; with chat, /api/events and browser the window of eight connections per host fills quickly, and
    /// the next ordinary request waits.
    private func releaseActive(except fresh: TerminalSession) {
        if let prior = active, prior !== fresh { prior.detach() }
    }

    private func nextNumber() -> Int {
        var used = Set<Int>()
        for session in sessions {
            if let match = session.title.split(separator: " ").last, let value = Int(match) { used.insert(value) }
        }
        var candidate = 1
        while used.contains(candidate) { candidate += 1 }
        return candidate
    }
}

struct TerminalsPane: View {
    @ObservedObject var model: TerminalSessionsModel
    /// Whether the tab is currently visible: only then does the active session hold a stream.
    var active: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            // The terminals run in the copy the code tab chose; shown here.
            if let copy = model.copy {
                Text(L("Copy {name}", ["name": copy]))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                    .accessibilityIdentifier("terminal-instance")
            }
            if let session = model.active {
                TerminalSessionView(session: session, active: active)
            } else {
                VStack(spacing: 12) {
                    EmptyPaneState(title: L("No terminal open yet."), systemImage: "terminal")
                    PillButton(title: L("Open terminal"), systemImage: "plus", prominent: true) {
                        model.newSession()
                    }
                    .accessibilityIdentifier("terminal-open")
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(CbColor.ground)
        .task { if active { model.ensureSession() } }
        // Leaving the tab ⇒ release the streams (the PTYs keep running); back ⇒ `ensureSession` reattaches the active one with `?from=`.
        // CategoryContent keeps the tab mounted HIDDEN (opacity 0) after the first visit, so `.onDisappear` does not fire on a
        // category change; hence `active` (like BrowserPane `active`). `.onDisappear` stays for real teardown.
        .onChange(of: active) { _, now in
            if now { model.ensureSession() } else { model.detachAll() }
        }
        .onDisappear { model.detachAll() }
    }
}

private struct TerminalSessionView: View {
    @ObservedObject var session: TerminalSession
    let active: Bool
    @State private var command = ""
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @FocusState private var focused: Bool
    /// Character grid last reported to the PTY (only resend on change).
    @State private var grid = (cols: 0, rows: 0)

    /// Font size of the output: 11.5 pt at category L, follows the text size (Kit/TextSize.swift) on the `.caption` curve; the same
    /// number sets the text AND computes the PTY's character grid, otherwise the other side would wrap at the wrong column after a step.
    @CbMetric(relativeTo: .caption) private var outputSize: CGFloat = 11.5
    private var outputFont: UIFont { UIFont.monospacedSystemFont(ofSize: outputSize, weight: .regular) }
    private static let padding: CGFloat = 10

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "terminal").font(.symbol(12)).foregroundStyle(.tint)
                Text(session.title).cbFont(12.5, weight: .semibold)
                if session.status == .exited {
                    Text(L("Session ended")).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                PillButton(title: L("Clear buffer")) { session.clearBuffer() }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // On the page background, below it only a hairline: no surface of its own.
            .overlay(alignment: .bottom) { CbHairline() }

            if session.status == .unavailable {
                EmptyPaneState(
                    title: L("Terminal not available"),
                    message: session.error,
                    systemImage: "exclamationmark.triangle"
                )
                Spacer()
            } else {
                // Scrollable VERTICALLY only: the PTY is told the real column count and wraps itself (`resize`), so long lines
                // do not run off the side. Short output starts at the TOP: the window's minimum height with top alignment;
                // a scroll view with both axes would center it otherwise.
                GeometryReader { box in
                    ScrollView(.vertical) {
                        Text(session.output.isEmpty ? " " : session.output)
                            .font(.scaled(_outputSize, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(width: max(0, box.size.width - 2 * Self.padding), alignment: .topLeading)
                            .padding(Self.padding)
                            .frame(minHeight: box.size.height, alignment: .topLeading)
                            .id("terminal-output")
                    }
                    .scrollPosition($scrollPosition)
                    // The page background color, no box of its own.
                    .background(CbColor.ground)
                    .accessibilityIdentifier("terminal-output")
                    .onChange(of: session.output) {
                        scrollPosition.scrollTo(edge: .bottom)
                    }
                    .onChange(of: box.size) { _, size in applyGrid(for: size) }
                    .onChange(of: session.termId) { applyGrid(for: box.size) }
                    .onAppear { applyGrid(for: box.size) }
                    .onChange(of: outputSize) { applyGrid(for: box.size) }
                }

                controlRow

                HStack(spacing: 8) {
                    TextField(L("Enter command…"), text: $command)
                        .cbFont(13, design: .monospaced)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.send)
                        .onSubmit { submit() }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 9)
                        .background(CbColor.ground, in: RoundedRectangle(cornerRadius: 12))
                        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.22)) }
                        .accessibilityIdentifier("terminal-input")
                    Button {
                        submit()
                    } label: {
                        Image(systemName: "return")
                            .font(.symbol(14, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(Circle().fill(Color.accentColor))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("terminal-send")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(CbColor.ground)
            }
        }
        // Per session (`id:`): when the shown session changes (choice in the drawer, one closed, one new), the new one attaches;
        // the previously shown one was released by `activate`/`newSession`. Hidden (`active` false) nothing: TerminalsPane handles the tab.
        .task(id: session.id) { if active { await session.start() } }
    }

    private var controlRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                controlKey("Ctrl+C", "\u{3}")
                controlKey("Ctrl+D", "\u{4}")
                controlKey("Ctrl+Z", "\u{1A}")
                controlKey("Tab", "\t")
                controlKey("Esc", "\u{1B}")
                controlKey("↑", "\u{1B}[A")
                controlKey("↓", "\u{1B}[B")
                controlKey("←", "\u{1B}[D")
                controlKey("→", "\u{1B}[C")
                controlKey(L("Word wrap"), "\r")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
        }
        // On the page background, above it only a hairline to the output: no surface of its own.
        .overlay(alignment: .top) { CbHairline() }
    }

    private func controlKey(_ label: String, _ sequence: String) -> some View {
        Button {
            session.send(sequence)
        } label: {
            Text(label)
                .cbFont(11.5, weight: .medium, design: .monospaced)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(CbColor.elevated, in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
    }

    private func submit() {
        let text = command
        command = ""
        session.send(text + "\r")
    }

    /// Determine the character grid from the real window size and report it to the PTY. Without it the other side wraps at
    /// 80 characters; on a phone 80 do not fit the width and the output would run off the side.
    private func applyGrid(for size: CGSize) {
        // Remember nothing without a PTY: otherwise the grid counts as "reported" although `resize` had no effect, and when the
        // session exists later it is never made up.
        guard session.termId != nil, size.width > 40, size.height > 40 else { return }
        let font = outputFont
        let advance = ("0" as NSString).size(withAttributes: [.font: font]).width
        let cols = max(20, Int(((size.width - 2 * Self.padding) / max(1, advance)).rounded(.down)))
        let rows = max(6, Int(((size.height - 2 * Self.padding) / max(1, font.lineHeight)).rounded(.down)))
        guard cols != grid.cols || rows != grid.rows else { return }
        grid = (cols, rows)
        session.resize(cols: cols, rows: rows)
    }
}

// ── Left drawer: sessions ───────────────────────────────────────────────────
struct TerminalSidebar: View {
    @ObservedObject var model: TerminalSessionsModel
    @EnvironmentObject private var state: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                PillButton(title: L("New terminal"), systemImage: "plus", prominent: true) {
                    model.newSession()
                    state.closeDrawersAfterChoice()
                }
                .accessibilityIdentifier("terminal-new")
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            ScrollView {
                VStack(spacing: 4) {
                    ForEach(model.sessions) { session in
                        HStack(spacing: 8) {
                            Button {
                                model.activate(session)
                                state.closeDrawersAfterChoice()
                            } label: {
                                HStack(spacing: 8) {
                                    // Selected neutral like every drawer row (`LeftDrawerBody.row`).
                                    Image(systemName: "terminal")
                                        .font(.symbol(12))
                                        .foregroundStyle(model.activeId == session.id ? Color.primary : CbColor.textMuted)
                                    Text(session.title)
                                        .cbFont(13, weight: model.activeId == session.id ? .semibold : .regular)
                                        .lineLimit(1)
                                    Spacer()
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            Button {
                                model.close(session)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.symbol(10, weight: .bold))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 22, height: 22)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("Close terminal"))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .cbSelection(model.activeId == session.id, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    if model.sessions.isEmpty {
                        Text(L("No terminal open yet."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 10)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
        }
    }
}
