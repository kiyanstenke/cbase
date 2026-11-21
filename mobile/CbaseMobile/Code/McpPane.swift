import SwiftUI

// MCP servers. Workspace level: own servers (CRUD) + catalog. Project level: own project servers plus adoption of the workspace
// servers. Built-in servers are always active.
//
// Form (tile form of the projects page, `Kit/CbTile.swift` / `Kit/CbRows.swift`):
//  – Order: your own first (that is what you manage), then "Built-in", then "Catalog".
//  – Own servers are a `CbToggleRow` — on/off is the most frequent action. The tile symbol guesses the kind from the name,
//    otherwise from the transport (`mcpSymbol`); its color shows the state (enabled green, off muted; built-in always green —
//    they are connected; catalog calm, already added muted). The short line is command + arguments or the URL in monospace,
//    truncated in the middle — that is WHAT the server is.
//  – Text appears only in the catalog (the description, two lines at most): there you CHOOSE, and that needs the sentence
//    about what the server can do.
//  – Tapping opens the server sheet (`McpDetailSheet`: command or URL, environment with KEYS only — tokens live there); edit and
//    remove there and in the context menu (press and hold).
//  – The subtitle, the sentence at the adopt header, the descriptions of the built-ins and "one tap adds" live in the ⓘ sheet
//    (`infoSheet`).
//  – Above the own list sits the summary ("2 servers · 1 active", identifier `mcp-summary`); section headers with a small tile
//    (`CbTileHeader`: origin, "Built-in", "Catalog"); empty shows one line with a muted tile. In the sheet, the tile in the head
//    and a small tile per field (`ProjectField`). No chevron next to a switch; the catalog keeps its quiet plus (it says what the
//    tap does).
struct McpPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var servers: [McpServer] = []
    @State private var adoptable: [McpServer] = []
    @State private var catalog: [McpCatalogEntry] = []
    @State private var loading = true
    /// True only after a successful response — an error on the first load shows the error, not "No own MCP servers yet." with
    /// "Create" (empty is not unknown; the same flag as `WorkflowsPane.loaded`). One route carries both lists in a project, so
    /// one flag for both.
    @State private var loaded = false
    @State private var error = ""
    @State private var draft: McpDraft?
    @State private var deleting: McpServer?
    @State private var toggling: String?
    @State private var detail: McpDetailTarget?
    /// What should happen after the server sheet closes — a view cannot show two sheets at once, so close first, then (in
    /// `onDismiss`) open the editor or the confirmation (like `AgentsPane`).
    @State private var byDetail: ByDetail?
    @State private var infoOpen = false

    private enum ByDetail {
        case edit(McpServer)
        case remove(McpServer)
    }

    /// The built-in servers — their descriptions are in the ⓘ sheet, their symbol there and in the row's tile.
    private static let builtins: [(name: String, label: String, symbol: String)] = [
        ("cbase", "cbase", "hexagon"),
        ("playwright", "Playwright", "theatermasks"),
    ]

    /// The origin of the OWN list: in a project the project servers, otherwise the workspace's.
    private var ownOrigin: OriginKind { projectId == nil ? .workspace : .project }
    /// In a project with the "Adopt" section (left drawer): only the workspace servers with their switch.
    private var inTakeOver: Bool { projectId != nil && state.itemsSection == .adopt }

    var body: some View {
        PaneScaffold(title: L("MCP servers"), trailing: AnyView(headerButtons)) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)

                    // The origin headers only with a response (or above the skeleton) — after an error the header would
                    // otherwise stand alone under the message.
                    if inTakeOver {
                        if loaded || loading {
                            CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                        }
                        takeOverSection
                    } else {
                        if loaded || loading {
                            CbTileHeader(
                                origin: ownOrigin,
                                name: projectId == nil ? state.activeWorkspace?.name : state.enteredProject?.name,
                                margin: true
                            )
                        }
                        ownSection

                        CbTileHeader(symbol: "cube", title: L("Built-in"), margin: true)
                            .padding(.top, 16)
                        builtinSection

                        if !catalog.isEmpty {
                            CbTileHeader(symbol: "square.grid.2x2", title: L("Catalog"), margin: true)
                                .padding(.top, 16)
                            catalogSection
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await load() }
        }
        .task { await load() }
        .sheet(item: $draft) { current in
            McpEditor(draft: current, isProject: projectId != nil) { saved in try await save(saved) }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { target in
            McpDetailSheet(
                target: target,
                client: client,
                edit: {
                    byDetail = .edit(target.server)
                    detail = nil
                },
                remove: {
                    byDetail = .remove(target.server)
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleting.map { L("Remove MCP server \"{name}\"?", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Remove"), role: .destructive) {
                if let server = deleting { Task { await remove(server) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    /// ⓘ and "New" in the head — the explanation as a sheet instead of a subtitle.
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About MCP servers"), identifier: "mcp-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                draft = McpDraft()
            }
            .accessibilityIdentifier("mcp-new")
        }
    }

    /// The explanations that used to be a subtitle, a sentence at the adopt header and a description on the built-in servers.
    /// The two origin points only in a project — there both lists exist.
    private var infoSheet: some View {
        var points: [CbInfoDot] = []
        if projectId != nil {
            points.append(CbInfoDot(origin: .project, text: L("In chats of this project the agent has its own servers and the workspace servers not hidden here.")))
            points.append(CbInfoDot(origin: .workspace, text: L("Applies in every project — can be hidden here for this project (under “Adopt”). Create and edit them at workspace level.")))
        }
        points.append(CbInfoDot(symbol: "hexagon", word: "cbase",
                                   text: L("Projects, context, artifacts, ports & credentials — cbase's own tools.")))
        points.append(CbInfoDot(symbol: "theatermasks", word: "Playwright",
                                   text: L("Browser automation for debugging (official @playwright/mcp).")))
        points.append(CbInfoDot(symbol: "plus", word: L("Catalog"),
                                   text: L("One tap adds the server with its defaults.")))
        return CbInfoSheet(
            title: L("MCP servers"),
            intro: L("External tool servers for the agents. Enabled servers are available in every chat of this workspace — effective from the next run."),
            points: points,
            footnote: L("Tap to see command and environment. Press and hold to edit or remove.")
        )
    }

    // ── Sections ────────────────────────────────────────────────────────────

    /// The own servers (workspace or project): switch on the right, tapping opens the sheet, press and hold
    /// edit and remove.
    @ViewBuilder
    private var ownSection: some View {
        if !loaded || (loading && servers.isEmpty) {
            // Before the first successful response: the skeleton while loading — afterwards only the error message above.
            if loading { CbRowSkeleton(rows: 2, tile: true) }
        } else if servers.isEmpty {
            CbTileEmpty(symbol: "server.rack", text: L("No own MCP servers yet.")) {
                draft = McpDraft()
            }
        } else {
            CbSummary(parts: summary(servers), identifier: "mcp-summary")
            tileList(servers) { ownRow($0) }
        }
    }

    /// "2 servers · 1 active" — active means switched on (own) or enabled workspace-wide and not hidden in THIS project
    /// (workspace servers, opt-out).
    private func summary(_ list: [McpServer]) -> [String] {
        [list.count == 1 ? L("1 server") : L("{n} servers", ["n": list.count]),
         L("{n} active", ["n": list.filter { $0.enabled && $0.inWorkspaceActive }.count])]
    }

    private func ownRow(_ server: McpServer) -> some View {
        CbToggleRow(
            isOn: server.enabled,
            disabled: toggling == server.id,
            toggleLabel: server.name,
            toggleIdentifier: "mcp-toggle-\(server.id)",
            toggle: { Task { await toggleServer(server) } },
            tap: { detail = McpDetailTarget(server: server, origin: ownOrigin, editable: true) },
            identifier: "mcp-\(server.id)"
        ) {
            serverRow(server)
        }
        // The context menu sits on the WHOLE row (switch included) — the preview takes the shape of the press.
        .contentShape(.contextMenuPreview, CbRowPress.form)
        .contextMenu {
            Button {
                draft = McpDraft(server: server)
            } label: {
                Label(L("Edit"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = server
            } label: {
                Label(L("Remove"), systemImage: "trash")
            }
        }
    }

    /// The workspace servers in a project: the same row, the switch hides the server in THIS project or shows it again (they
    /// apply in every project — opt-out like the credentials). One switched off workspace-wide is missing nonetheless: state
    /// "Off in the workspace". Tapping shows the sheet read-only — creating and editing happen at workspace level.
    @ViewBuilder
    private var takeOverSection: some View {
        if !loaded || (loading && adoptable.isEmpty) {
            if loading { CbRowSkeleton(rows: 2, tile: true) }
        } else if adoptable.isEmpty {
            CbTileEmpty(symbol: "server.rack", text: L("No workspace MCP servers available."))
        } else {
            CbSummary(parts: summary(adoptable), identifier: "mcp-summary")
            tileList(adoptable) { server in
                CbToggleRow(
                    isOn: server.enabled,
                    disabled: toggling == server.id,
                    toggleLabel: server.name,
                    toggleIdentifier: "mcp-adopt-\(server.id)",
                    toggle: { Task { await toggleAdopt(server) } },
                    tap: { detail = McpDetailTarget(server: server, origin: .workspace, editable: false) },
                    identifier: "mcp-\(server.id)"
                ) {
                    serverRow(server, state: !server.enabled ? CbState(L("Hidden"), CbSituation.off.color)
                                : server.inWorkspaceActive ? nil : CbState(L("Off in the workspace"), CbSituation.off.color))
                }
            }
        }
    }

    /// The rows of a section — without hairlines, the tile separates them.
    private func tileList<Entry: Identifiable, Row: View>(
        _ entries: [Entry],
        @ViewBuilder row: @escaping (Entry) -> Row
    ) -> some View {
        VStack(spacing: 2) {
            ForEach(entries) { entry in
                row(entry)
            }
        }
    }

    /// A server row: the tile (`mcpSymbol`, enabled green, off muted), name, command + arguments or URL in monospace. Long
    /// commands are truncated in the middle — start (`npx -y …`) and end (the package) say more than the rest. No chevron: the
    /// switch is on the right.
    private func serverRow(_ server: McpServer, state: CbState? = nil) -> some View {
        let short = server.summary.trimmingCharacters(in: .whitespaces)
        return CbTileRow(
            symbol: mcpSymbol(server.name, transport: server.transport),
            situation: .on,
            title: server.name,
            state: state,
            shortLine: short.isEmpty ? nil : Text(short).monospaced(),
            active: server.enabled && server.inWorkspaceActive
        )
        .truncationMode(.middle)
    }

    /// cbase and Playwright: always there, not tappable, no press area — the tile green (connected or always active) with
    /// the symbol from the ⓘ sheet.
    private var builtinSection: some View {
        VStack(spacing: 2) {
            ForEach(Self.builtins, id: \.name) { builtin in
                CbTileRow(
                    symbol: builtin.symbol,
                    situation: .on,
                    title: builtin.label,
                    shortLine: Text(projectId == nil ? L("connected") : L("always active"))
                )
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The catalog: here the description is text — you CHOOSE. A tap opens the editor with the entry's defaults (it also
    /// says what it needs); already added entries are not tappable.
    private var catalogSection: some View {
        VStack(spacing: 2) {
            ForEach(catalog) { entry in
                let installed = servers.contains { $0.name == entry.key }
                Button {
                    draft = McpDraft(catalog: entry)
                } label: {
                    CbTileRow(
                        symbol: mcpSymbol(entry.key, transport: entry.transport),
                        title: L(entry.label),
                        text: L(entry.description),
                        active: !installed
                    ) {
                        catalogRight(installed)
                    }
                }
                .cbRowPress()
                .disabled(installed)
                .accessibilityIdentifier("mcp-catalog-\(entry.key)")
            }
        }
    }

    /// On the right of the catalog row: a quiet plus, or "added" — centered on the row like a chevron.
    private func catalogRight(_ installed: Bool) -> some View {
        Group {
            if installed {
                Text(L("added"))
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textMuted)
            } else {
                Image(systemName: "plus")
                    .font(.symbol(13, weight: .medium))
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityLabel(L("add"))
            }
        }
        .frame(height: 20)
    }

    private func afterTheDetail() {
        // The tool choice in the sheet saves at once — the rows (counter) show the new state afterwards.
        Task { await load() }
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .edit(let server): draft = McpDraft(server: server)
        case .remove(let server): deleting = server
        }
    }

    // ── Loading and writing ─────────────────────────────────────────────────

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if let projectId {
                let response: ProjectMcpServers = try await client.get("/api/projects/\(projectId)/mcp-servers")
                servers = response.projectServers
                adoptable = response.workspaceServers
            } else {
                servers = try await client.get("/api/workspaces/\(workspaceId)/mcp-servers")
                adoptable = []
            }
            catalog = (try? await client.get("/api/mcp-catalog")) ?? []
            loaded = true
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleServer(_ server: McpServer) async {
        struct Body: Encodable { let enabled: Bool }
        toggling = server.id
        defer { toggling = nil }
        do {
            try await client.send("/api/mcp-servers/\(server.id)", method: .patch, body: Body(enabled: !server.enabled))
            await load()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleAdopt(_ server: McpServer) async {
        guard let projectId else { return }
        struct Body: Encodable { let enabled: Bool }
        toggling = server.id
        defer { toggling = nil }
        do {
            try await client.send(
                "/api/projects/\(projectId)/mcp-servers/\(server.id)/enabled",
                method: .patch,
                body: Body(enabled: !server.enabled)
            )
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func remove(_ server: McpServer) async {
        do {
            let _: OKResponse = try await client.delete("/api/mcp-servers/\(server.id)")
            await load()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ saved: McpDraft) async throws {
        struct StdioBody: Encodable {
            let name: String
            let transport: String
            let command: String
            let args: [String]
            let env: [String: String]
            let enabled: Bool
        }
        struct RemoteBody: Encodable {
            let name: String
            let transport: String
            let url: String
            let enabled: Bool
            /// Only the change (`nil` = key missing = unchanged); a removed name arrives as null.
            let headers: [String: String?]?
        }
        let args = saved.argsText.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var env: [String: String] = [:]
        for line in saved.envText.split(whereSeparator: \.isNewline) {
            let trimmed = String(line).trimmingCharacters(in: .whitespaces)
            guard let index = trimmed.firstIndex(of: "="), index != trimmed.startIndex else { continue }
            env[String(trimmed[trimmed.startIndex..<index]).trimmingCharacters(in: .whitespaces)] =
                String(trimmed[trimmed.index(after: index)...]).trimmingCharacters(in: .whitespaces)
        }

        let target: String
        if let id = saved.editing {
            target = "/api/mcp-servers/\(id)"
        } else if let projectId {
            target = "/api/projects/\(projectId)/mcp-servers"
        } else {
            target = "/api/workspaces/\(workspaceId)/mcp-servers"
        }
        let method: HTTPMethod = saved.editing == nil ? .post : .patch

        if saved.transport == "stdio" {
            try await client.send(target, method: method, body: StdioBody(
                name: saved.name, transport: "stdio", command: saved.command,
                args: args, env: env, enabled: saved.enabled
            ))
        } else {
            try await client.send(target, method: method, body: RemoteBody(
                name: saved.name, transport: saved.transport, url: saved.url, enabled: saved.enabled,
                headers: saved.headerChange
            ))
        }
        await load()
        await state.reloadOverview()
    }
}

// ── Symbol and transport ────────────────────────────────────────────────────

/// The symbol of an MCP server, guessed from its NAME (display only, nothing depends on it) — in the row's tile (own, adopted
/// and the catalog) and in the sheet's head. Like `agentSymbol` per word, the table order decides; `whole` counts only as a whole
/// word ("git", "db", "fs"), `beginnings` at the start of a word ("github", "postgres" → "postgresql"). Without a match the
/// transport decides: stdio `terminal`, http `globe`, sse `dot.radiowaves.left.and.right`.
///
/// Expectations (worked out by hand): "github" → arrow.triangle.branch · "mcp-gitlab" → arrow.triangle.branch ·
/// "postgres" → cylinder.split.1x2 · "sqlite" → cylinder.split.1x2 · "filesystem" → folder · "teams" → speech bubbles ·
/// "playwright-extra" → globe · "sequential-thinking" (stdio) → terminal · "events" (sse) → radio waves.
private func mcpSymbol(_ name: String, transport: String? = nil) -> String {
    let words = name.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    let table: [(symbol: String, whole: Set<String>, beginnings: [String])] = [
        ("arrow.triangle.branch", ["git"], ["github", "gitlab", "gitea", "bitbucket"]),
        ("cylinder.split.1x2", ["db", "sql", "pg"], ["postgres", "mysql", "sqlite", "mssql", "mongo", "redis", "supabase", "database"]),
        ("folder", ["fs", "file", "files"], ["filesystem"]),
        ("bubble.left.and.bubble.right", [], ["slack", "teams", "discord", "mattermost"]),
        ("globe", [], ["browser", "playwright", "puppeteer"]),
    ]
    for entry in table where words.contains(where: { w in
        entry.whole.contains(w) || entry.beginnings.contains { w.hasPrefix($0) }
    }) {
        return entry.symbol
    }
    switch transport {
    case "http": return "globe"
    case "sse": return "dot.radiowaves.left.and.right"
    default: return "terminal"
    }
}

/// The transport as a word for the subline in the sheet: "stdio", "HTTP", "SSE" (as in the editor).
private func mcpTransportWord(_ transport: String) -> String {
    switch transport {
    case "http": return "HTTP"
    case "sse": return "SSE"
    default: return transport
    }
}

// ── The server sheet on tap ─────────────────────────────────────────────────

private struct McpDetailTarget: Identifiable {
    let server: McpServer
    let origin: OriginKind
    /// Own servers only — a project's workspace servers are edited at workspace level.
    let editable: Bool
    var id: String { server.id }
}

/// What is missing in the row: the whole command with one argument per line (or the URL) and the environment — only the
/// KEYS, the values as •••• (tokens live there; whoever wants to see them opens the editor). Edit in the head,
/// remove at the end — both only for own servers.
private struct McpDetailSheet: View {
    let target: McpDetailTarget
    let client: APIClient
    let edit: () -> Void
    let remove: () -> Void

    private var server: McpServer { target.server }

    private var command: String {
        ([server.command] + server.args)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }

    private var environment: String {
        server.env.keys.sorted()
            .map { key in (server.env[key] ?? "").isEmpty ? "\(key)=" : "\(key)=••••" }
            .joined(separator: "\n")
    }

    var body: some View {
        CbDetailSheet(
            primary: target.editable ? CbSheetAction(title: L("Edit"), identifier: "mcp-detail-edit", action: edit) : nil,
            closeIdentifier: "mcp-detail-close",
            erase: target.editable ? CbSheetAction(title: L("Remove"), identifier: "mcp-detail-delete", action: remove) : nil,
            hint: target.editable ? nil : L("Edit at workspace level.")
        ) {
            CbDetailHeader(
                character: CbSign(
                    symbol: mcpSymbol(server.name, transport: server.transport),
                    tone: CbSituation.toggle(server.enabled).color,
                    tile: true
                ),
                title: server.name
            ) {
                CbOriginRow(
                    kind: target.origin,
                    addition: [mcpTransportWord(server.transport), server.enabled ? L("active") : L("off")]
                )
            }
            if server.transport == "stdio" {
                ProjectField(L("Command"), symbol: "terminal") { box(command) }
            } else {
                ProjectField("URL", symbol: "globe") { box(server.url.trimmingCharacters(in: .whitespaces)) }
            }
            if !server.env.isEmpty {
                ProjectField(L("Environment"), symbol: "key", right: String(server.env.count)) { CbCodeBox(text: environment, horizontal: true) }
            }
            if !server.headers.isEmpty {
                // Only the names — a value never leaves the server.
                ProjectField(L("Headers"), symbol: "key", right: String(server.headers.count)) {
                    CbCodeBox(text: server.headers.map { "\($0.name): \(L("set"))" }.joined(separator: "\n"), horizontal: true)
                }
            }
            // Tool choice, cards, "Subagents inherit" — a workspace server inside a project is read-only.
            McpToolsView(client: client, server: server, onlyRead: !target.editable) { _ in }
        }
    }

    /// Command or URL: long lines scroll horizontally instead of wrapping; empty shows a dash.
    @ViewBuilder
    private func box(_ text: String) -> some View {
        if text.isEmpty {
            Text("—")
                .cbFont(14)
                .foregroundStyle(CbColor.textMuted)
        } else {
            CbCodeBox(text: text, horizontal: true)
        }
    }
}

struct McpHeaderNew: Identifiable, Hashable {
    let id = UUID()
    var name = ""
    var value = ""
}

struct McpDraft: Identifiable {
    let id = UUID()
    var editing: String?
    var name = ""
    var transport = "stdio"
    var command = "npx"
    var argsText = ""
    var envText = ""
    var url = ""
    var enabled = true
    var hint = ""
    /// Headers (http/sse only): stored ones with a name only, ones marked for removal, new ones with a hidden value.
    var headerInventory: [String] = []
    var headerAway: [String] = []
    var headerNew: [McpHeaderNew] = []

    /// The header change: new or overwritten with value, removed with null — `nil` if nothing changed.
    var headerChange: [String: String?]? {
        var out: [String: String?] = [:]
        for name in headerAway { out[name] = .some(nil) }
        for k in headerNew where !k.name.trimmingCharacters(in: .whitespaces).isEmpty {
            out[k.name.trimmingCharacters(in: .whitespaces)] = .some(k.value)
        }
        return out.isEmpty ? nil : out
    }

    init() {}

    init(server: McpServer) {
        editing = server.id
        name = server.name
        transport = server.transport
        command = server.command.isEmpty ? "npx" : server.command
        argsText = server.args.joined(separator: "\n")
        envText = server.env.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: "\n")
        url = server.url
        enabled = server.enabled
        headerInventory = server.headers.map(\.name)
    }

    init(catalog entry: McpCatalogEntry) {
        name = entry.key
        transport = entry.transport
        let remote = entry.transport == "http" || entry.transport == "sse"
        command = remote ? "" : (entry.command.isEmpty ? "npx" : entry.command)
        argsText = entry.args.joined(separator: "\n")
        envText = entry.env.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: "\n")
        url = entry.url
        hint = entry.needs
    }
}

private struct McpEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: McpDraft
    let isProject: Bool
    let save: (McpDraft) async throws -> Void
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                if !draft.hint.isEmpty {
                    Section {
                        Label(L(draft.hint), systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Section(L("Name")) {
                    TextField(L("e.g. github"), text: $draft.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section(L("Type")) {
                    Picker(L("Type"), selection: $draft.transport) {
                        Text(L("stdio (local)")).tag("stdio")
                        Text("HTTP").tag("http")
                        Text("SSE").tag("sse")
                    }
                    .pickerStyle(.segmented)
                }
                if draft.transport == "stdio" {
                    Section("Command") {
                        TextField("npx", text: $draft.command)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Section(L("Arguments (one per line)")) {
                        TextEditor(text: $draft.argsText)
                            .frame(minHeight: 90)
                            .cbFont(13, design: .monospaced)
                    }
                    Section(L("Environment variables (KEY=VALUE per line)")) {
                        TextEditor(text: $draft.envText)
                            .frame(minHeight: 70)
                            .cbFont(13, design: .monospaced)
                    }
                } else {
                    Section("URL") {
                        TextField("https://…", text: $draft.url)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    Section {
                        ForEach(draft.headerInventory.filter { !draft.headerAway.contains($0) }, id: \.self) { name in
                            HStack {
                                Text(name).font(.system(.body, design: .monospaced))
                                Spacer()
                                Text(L("set")).foregroundStyle(.secondary)
                                Button(L("Remove"), role: .destructive) { draft.headerAway.append(name) }
                                    .buttonStyle(.borderless)
                            }
                        }
                        ForEach($draft.headerNew) { $k in
                            HStack {
                                TextField("Authorization", text: $k.name)
                                    .font(.system(.body, design: .monospaced))
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                SecureField(L("Value"), text: $k.value)
                            }
                        }
                        Button(L("+ Header")) { draft.headerNew.append(McpHeaderNew()) }
                            .accessibilityIdentifier("mcp-header-new")
                    } header: {
                        Text(L("Headers"))
                    } footer: {
                        Text(L("(e.g. Authorization — the value never leaves the server)"))
                    }
                }
                Section {
                    Toggle(L("Enabled"), isOn: $draft.enabled)
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(
                draft.editing != nil
                    ? L("Edit server")
                    : isProject ? L("New project MCP server") : L("New MCP server")
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await commit() } }
                        .disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func commit() async {
        busy = true
        error = ""
        do {
            try await save(draft)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
