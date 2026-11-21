import SwiftUI

// Node debugger of the Code tab (docked at the bottom as on the desktop): start a file, stop at
// breakpoints, step controls, call stack, variables, watch and console.
@MainActor
final class DebugModel: ObservableObject {
    enum Status: String { case terminated, starting, running, paused }

    @Published var status: Status = .terminated
    @Published var paused: DebugPaused?
    @Published var output: [String] = []
    @Published var breakpoints: [String: Set<Int>] = [:]
    @Published var watches: [Watch] = []
    @Published var error = ""

    struct Watch: Identifiable, Hashable {
        var id: String { expression }
        let expression: String
        var value: String?
        var failure: String?
    }

    private let client: APIClient
    private let apiBase: String
    /// The Code tab's chosen copy — the debugger then starts in its container (nil = main).
    private let instance: String?
    private var sessionId: String?
    private var streamTask: Task<Void, Never>?

    init(client: APIClient, apiBase: String, instance: String? = nil) {
        self.client = client
        self.apiBase = apiBase
        self.instance = instance
    }

    deinit { streamTask?.cancel() }

    var isPaused: Bool { status == .paused }
    var isActive: Bool { status != .terminated }

    /// After a taken-over layout the breakpoints move along; those of a deleted file drop (as on the web).
    func afterLayout(_ end: LayoutEnd, prefix: String) {
        guard instance == nil else { return }
        var fresh: [String: Set<Int>] = [:]
        for (file, rows) in breakpoints {
            if let n = LayoutPaths.newPath(file, end, prefix: prefix) { fresh[n, default: []].formUnion(rows) }
        }
        if fresh != breakpoints { breakpoints = fresh }
    }

    func toggleBreakpoint(file: String, line: Int) {
        var lines = breakpoints[file] ?? []
        if lines.contains(line) { lines.remove(line) } else { lines.insert(line) }
        breakpoints[file] = lines
        guard let sessionId else { return }
        struct Body: Encodable { let file: String; let lines: [Int] }
        Task {
            _ = try? await client.send(
                "/api/debug/\(sessionId)/breakpoints",
                body: Body(file: file, lines: lines.sorted())
            )
        }
    }

    func launch(file: String) async {
        guard !file.isEmpty else {
            error = L("No file open")
            return
        }
        await stop()
        output = []
        paused = nil
        error = ""
        status = .starting
        struct Body: Encodable { let file: String; let breakpoints: [BreakpointBody] }
        struct BreakpointBody: Encodable { let file: String; let lines: [Int] }
        let all = breakpoints.compactMap { entry -> BreakpointBody? in
            entry.value.isEmpty ? nil : BreakpointBody(file: entry.key, lines: entry.value.sorted())
        }
        do {
            let response: DebugLaunchResponse = try await client.post(
                "\(apiBase)/debug/launch",
                query: CodeInstance.query(instance),
                body: Body(file: file, breakpoints: all)
            )
            guard response.available else {
                error = L("Debugger not available: {msg}", ["msg": response.error ?? ""])
                status = .terminated
                return
            }
            sessionId = response.id
            status = .running
            listen(response.id)
        } catch {
            self.error = L("Start failed: {msg}", ["msg": error.localizedDescription])
            status = .terminated
        }
    }

    func command(_ cmd: String) {
        guard let sessionId else { return }
        struct Body: Encodable { let cmd: String }
        Task { _ = try? await client.send("/api/debug/\(sessionId)/command", body: Body(cmd: cmd)) }
    }

    func stop() async {
        streamTask?.cancel()
        streamTask = nil
        if let sessionId {
            _ = try? await client.send("/api/debug/\(sessionId)", method: .delete)
        }
        sessionId = nil
        status = .terminated
        paused = nil
    }

    func addWatch(_ expression: String) {
        let trimmed = expression.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !watches.contains(where: { $0.expression == trimmed }) else { return }
        watches.append(Watch(expression: trimmed))
        Task { await evaluateWatches() }
    }

    func removeWatch(_ expression: String) {
        watches.removeAll { $0.expression == expression }
    }

    func evaluateWatches() async {
        guard let sessionId, status == .paused, !watches.isEmpty else { return }
        struct Body: Encodable { let expr: String }
        for index in watches.indices {
            let expression = watches[index].expression
            if let response: DebugEvaluateResponse = try? await client.post(
                "/api/debug/\(sessionId)/evaluate",
                body: Body(expr: expression)
            ) {
                watches[index].value = response.value
                watches[index].failure = response.error
            } else {
                watches[index].failure = L("Error")
            }
        }
    }

    private func listen(_ id: String) {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await (event, payload) in client.namedStream("/api/debug/\(id)/stream") {
                    switch event {
                    case "started":
                        self.status = .running
                    case "resumed":
                        self.status = .running
                        self.paused = nil
                    case "paused":
                        if let data = try? JSONEncoder().encode(payload),
                           let decoded = try? JSONDecoder().decode(DebugPaused.self, from: data) {
                            self.paused = decoded
                        }
                        self.status = .paused
                        await self.evaluateWatches()
                    case "terminated":
                        self.status = .terminated
                        self.paused = nil
                    case "output":
                        let text = payload["text"]?.stringValue ?? ""
                        self.output.append(text.trimmingCharacters(in: .newlines))
                        if self.output.count > 500 { self.output.removeFirst(self.output.count - 500) }
                    default:
                        break
                    }
                }
            } catch {
                // The stream ends with the session.
            }
        }
    }
}

struct DebugPane: View {
    @ObservedObject var model: DebugModel
    let openFile: String?
    @State private var watchDraft = ""
    @State private var breakpointDraft = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("Debug").cbFont(11, weight: .semibold).foregroundStyle(.secondary)
                stepButton(L("Resume"), "play.fill", "continue")
                stepButton(L("Step over"), "arrow.turn.down.right", "stepOver")
                stepButton(L("Step into"), "arrow.down.to.line", "stepInto")
                stepButton(L("Step out"), "arrow.up.to.line", "stepOut")
                Button {
                    Task { await model.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.symbol(11))
                        .foregroundStyle(.red)
                        .frame(width: 26, height: 26)
                }
                .buttonStyle(.plain)
                .disabled(!model.isActive)
                Spacer()
                Text(statusLabel)
                    .cbFont(9.5, weight: .semibold)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(statusColor.opacity(0.16), in: Capsule())
                    .foregroundStyle(statusColor)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(CbColor.surface)

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    InlineError(message: model.error)

                    PaneCard {
                        HStack {
                            Text(openFile ?? L("No file open"))
                                .cbFont(11.5, design: .monospaced)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer()
                            PillButton(
                                title: L("Debug"),
                                systemImage: "play.fill",
                                prominent: true,
                                disabled: openFile == nil || model.status == .starting
                            ) {
                                Task { await model.launch(file: openFile ?? "") }
                            }
                            .accessibilityIdentifier("debug-launch")
                        }
                        Text(L("Stops at breakpoints. You set breakpoints below, per line number."))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    if let file = openFile {
                        PaneCard {
                            SectionLabel(text: L("Breakpoints"))
                            HStack(spacing: 6) {
                                TextField(L("Line"), text: $breakpointDraft)
                                    .keyboardType(.numberPad)
                                    .cbFont(12, design: .monospaced)
                                    .frame(width: 70)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 5)
                                    .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
                                PillButton(title: L("Set")) {
                                    if let line = Int(breakpointDraft) {
                                        model.toggleBreakpoint(file: file, line: line)
                                        breakpointDraft = ""
                                    }
                                }
                                .accessibilityIdentifier("debug-add-breakpoint")
                                Spacer()
                            }
                            let lines = (model.breakpoints[file] ?? []).sorted()
                            if lines.isEmpty {
                                Text(L("No breakpoints in this file."))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            HStack(spacing: 5) {
                                ForEach(lines, id: \.self) { line in
                                    Button {
                                        model.toggleBreakpoint(file: file, line: line)
                                    } label: {
                                        HStack(spacing: 3) {
                                            Circle().fill(Color.red).frame(width: 6, height: 6)
                                            Text(verbatim: "\(line)").cbFont(11, design: .monospaced)
                                            Image(systemName: "xmark").font(.symbol(7, weight: .bold))
                                        }
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 3)
                                        .background(Color.secondary.opacity(0.1), in: Capsule())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    if let paused = model.paused {
                        PaneCard {
                            SectionLabel(text: L("Call stack"))
                            ForEach(paused.frames) { frame in
                                HStack(spacing: 6) {
                                    Text(frame.name).cbFont(12, weight: .medium)
                                    Text(verbatim: "\(frame.file):\(frame.line)")
                                        .cbFont(10, design: .monospaced)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                    Spacer()
                                }
                            }
                        }
                        ForEach(paused.scopes) { scope in
                            PaneCard {
                                SectionLabel(text: scope.name.isEmpty ? scope.type : "\(scope.type) · \(scope.name)")
                                ForEach(scope.vars) { variable in
                                    HStack(alignment: .top, spacing: 6) {
                                        Text(variable.name)
                                            .cbFont(11, weight: .semibold, design: .monospaced)
                                        Text(variable.value)
                                            .cbFont(11, design: .monospaced)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(3)
                                        Spacer()
                                    }
                                }
                            }
                        }
                    }

                    PaneCard {
                        SectionLabel(text: "Watch")
                        HStack(spacing: 6) {
                            TextField(L("Expression"), text: $watchDraft)
                                .cbFont(12, design: .monospaced)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.done)
                                .onSubmit {
                                    model.addWatch(watchDraft)
                                    watchDraft = ""
                                }
                            PillButton(title: L("Add")) {
                                model.addWatch(watchDraft)
                                watchDraft = ""
                            }
                        }
                        ForEach(model.watches) { watch in
                            HStack(spacing: 6) {
                                Text(watch.expression)
                                    .cbFont(11, weight: .semibold, design: .monospaced)
                                Text(watch.failure ?? watch.value ?? "—")
                                    .cbFont(11, design: .monospaced)
                                    .foregroundStyle(watch.failure != nil ? Color.red : Color.secondary)
                                    .lineLimit(2)
                                Spacer()
                                Button {
                                    model.removeWatch(watch.expression)
                                } label: {
                                    Image(systemName: "xmark").font(.symbol(9, weight: .bold)).foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    PaneCard {
                        SectionLabel(text: L("Console"))
                        if model.output.isEmpty {
                            Text(L("No output.")).font(.caption2).foregroundStyle(.secondary)
                        }
                        ForEach(Array(model.output.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .cbFont(10.5, design: .monospaced)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        }
        .background(CbColor.ground)
    }

    private var statusLabel: String {
        switch model.status {
        case .paused: return L("paused")
        case .terminated: return L("terminated")
        case .starting: return L("starting…")
        case .running: return L("running")
        }
    }

    private var statusColor: Color {
        switch model.status {
        case .paused: return .orange
        case .terminated: return .secondary
        default: return .green
        }
    }

    private func stepButton(_ title: String, _ symbol: String, _ command: String) -> some View {
        Button {
            model.command(command)
        } label: {
            Image(systemName: symbol)
                .font(.symbol(11))
                .frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
        .disabled(!model.isPaused)
        .accessibilityLabel(title)
        .accessibilityIdentifier("debug-\(command)")
    }
}

// ── Problems (language-service diagnostics for the open file) ────────────
// Via `POST <apiBase>/lsp/diagnostics` — the language server runs in the instance (main OR copy); the copy is addressed
// via `instance=` like every call of the model.
struct ProblemsPane: View {
    @ObservedObject var model: CodeBrowserModel
    @State private var diagnostics: [LspDiagnostic] = []
    @State private var withoutService = ""
    /// This buffer's identifier: a random id per view, `version` counts the checks — B compares against the
    /// text sent along as soon as the version changes.
    @State private var buffer = UUID().uuidString
    @State private var version = 0
    @State private var loading = false
    @State private var error = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(model.openPath ?? L("No file open"))
                    .cbFont(11.5, design: .monospaced)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer()
                PillButton(
                    title: loading ? "…" : L("Check"),
                    systemImage: "checkmark.seal",
                    prominent: true,
                    disabled: model.openPath == nil || loading
                ) {
                    Task { await check() }
                }
                .accessibilityIdentifier("problems-check")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(CbColor.surface)

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    InlineError(message: error)
                    // Without a language service (no language, no project, server missing) this shows instead of a silent "no problems".
                    if !withoutService.isEmpty {
                        Text(withoutService)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("code-without-language-service")
                    } else if diagnostics.isEmpty && !loading {
                        EmptyPaneState(
                            title: model.openPath == nil ? L("No file open") : L("No problems found."),
                            systemImage: "checkmark.seal"
                        )
                    }
                    ForEach(diagnostics) { diagnostic in
                        PaneCard(padding: 11) {
                            HStack(spacing: 7) {
                                Image(systemName: symbol(diagnostic.severity))
                                    .font(.symbol(11))
                                    .foregroundStyle(color(diagnostic.severity))
                                Text(L("Line {line}", ["line": diagnostic.line]))
                                    .cbFont(11, weight: .semibold, design: .monospaced)
                                Spacer()
                            }
                            Text(diagnostic.message)
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 24)
            }
        }
        .background(CbColor.ground)
        .task { await check() }
    }

    private func symbol(_ severity: String) -> String {
        severity == "error" ? "xmark.octagon.fill" : severity == "warning" ? "exclamationmark.triangle.fill" : "info.circle"
    }

    private func color(_ severity: String) -> Color {
        severity == "error" ? .red : severity == "warning" ? .orange : .accentColor
    }

    private func check() async {
        guard let path = model.openPath else {
            diagnostics = []
            withoutService = ""
            return
        }
        struct Body: Encodable { let file: String; let buffer: String; let version: Int; let text: String }
        loading = true
        defer { loading = false }
        version += 1
        do {
            let response: LspDiagnosticsResponse = try await model.client.post(
                "\(model.apiBase)/lsp/diagnostics",
                query: CodeInstance.query(model.instance),
                body: Body(file: path, buffer: buffer, version: version, text: model.content)
            )
            diagnostics = response.diagnostics
            withoutService = response.supported ? "" : (response.error ?? L("This file has no language service."))
            error = ""
        } catch {
            diagnostics = []
            withoutService = ""
            self.error = error.localizedDescription
        }
    }
}
