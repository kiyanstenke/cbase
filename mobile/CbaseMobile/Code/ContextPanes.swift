import SwiftUI

// ── Context: dumpster (drop in) + memory (curated knowledge) ────────────────
//
// Memory is shown in the TILE form of the projects page (`Kit/CbTile.swift`): per row a tile with the category's sign
// (`contextSymbol`; calm), a curator suggestion with its action's sign in orange (it waits for "Apply"); no hairlines; above the
// list the summary ("12 entries · 2 pinned", identifier `context-summary`); group headers with a small tile (`CbTileHeader`);
// when empty a row with a muted tile plus "To the dumpster". In both sheets the tile in the header and a small tile per field
// (`ProjectField`).
//  – Memory: the sign says the CATEGORY (`contextSymbol`: the slugs of the project schema are fixed, the free workspace categories
//    are guessed from their words), the tone the origin (own project entries in the accent, adopted and all workspace entries
//    neutral); pinned is a dot plus word. Under the short line (category · date · as-of or source) come two lines of TEXT — a
//    memory entry IS text, and the title alone ("Deployment") rarely carries. The text is the summary, without it the beginning of
//    the content without markdown characters (`contextPreview`). The whole entry (markdown), tags, as-of, source and date are in
//    the sheet on tap (`ContextEntrySheet`); edit and delete there and in the context menu. Adopted workspace entries stay
//    read-only in the project.
//  – Curator suggestions (project only) form a group of their own above the entries, with the reasoning as text — the why is the
//    basis for the decision. Apply and dismiss in the sheet (`ContextSuggestionSheet`) and in the context menu. Without
//    headers (`showHeaders`) the short line of an adopted entry says "adopted".
//  – Dumpster: an input field like the composer island, below it ONE bar (target · characters · send), the result as a row with
//    a sign (`ContextDropIn`). The two explanation cards are in the ⓘ sheet (`contextInfoSheet`).
// Dumpster or memory is still chosen in the left drawer (`ContextSidebar`), as is the category.

// ── Workspace context ───────────────────────────────────────────────────────
struct WorkspaceContextPane: View {
    let client: APIClient
    let workspaceId: String
    @EnvironmentObject private var state: AppState

    @State private var items: [WorkspaceContextItem] = []
    @State private var search = ""
    @State private var loading = true
    /// True only after a successful answer — an error on the first load shows the error, not "No context yet"
    /// with "To the dumpster" (empty is not unknown; the same flag as `WorkflowsPane.loaded`).
    @State private var loaded = false
    @State private var error = ""
    @State private var dumpText = ""
    @State private var dumpSource = ""
    @State private var dumpTarget = "auto"
    @State private var dumpBusy = false
    @State private var dumpState: DropInStatus = .empty
    @State private var deleting: WorkspaceContextItem?
    @State private var searchTask: Task<Void, Never>?
    @State private var detail: WorkspaceContextItem?
    /// To delete once the detail sheet is closed — a view cannot present two sheets at once.
    @State private var byDetail: WorkspaceContextItem?
    @State private var infoOpen = false

    var body: some View {
        PaneScaffold(
            title: L("Context"),
            trailing: AnyView(
                CbHeaderInfoButton(label: L("About context"), identifier: "context-info") { infoOpen = true }
            )
        ) {
            Group {
                if state.contextSub == .dumpster {
                    dumpster
                } else {
                    memory
                }
            }
            .animation(.easeInOut(duration: 0.2), value: state.contextSub)
        }
        .task { await load() }
        .onChange(of: state.contextCategory) { Task { await load() } }
        .sheet(item: $detail, onDismiss: afterTheDetail) { item in
            ContextEntrySheet(
                entry: ContextEntry(workspace: item),
                edit: nil,
                erase: {
                    byDetail = item
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { contextInfoSheet(inProject: false).cbSheet(.half) }
        .confirmationDialog(
            L("Delete context entry?"),
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let item = deleting { Task { await remove(item) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    // ── Dumpster ──
    private var dumpster: some View {
        ScrollView {
            ContextDropIn(
                text: $dumpText,
                textIdentifier: "dumpster-text",
                sendIdentifier: "dumpster-send",
                statusIdentifier: "dumpster-status",
                busy: dumpBusy,
                snapshot: dumpState,
                source: $dumpSource,
                send: { Task { await dump() } }
            ) {
                targetMenu
            }
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Where the drop goes: detect automatically, workspace or a project — as a calm menu on the left of the bar.
    private var targetMenu: some View {
        let projects = state.activeWorkspace?.projects ?? []
        let project = projects.first { $0.id == dumpTarget }
        let title: String
        let symbol: String
        switch dumpTarget {
        case "auto":
            title = L("Automatic")
            symbol = "sparkles"
        case "workspace":
            title = L("Workspace")
            symbol = OriginKind.workspace.symbol
        default:
            title = project?.name ?? dumpTarget
            symbol = OriginKind.project.symbol
        }
        return Menu {
            Picker(L("Destination"), selection: $dumpTarget) {
                Label(L("Detect automatically"), systemImage: "sparkles").tag("auto")
                Label(L("No project (workspace)"), systemImage: OriginKind.workspace.symbol).tag("workspace")
                ForEach(projects) { project in
                    Label(L("Project: {name}", ["name": project.name]), systemImage: OriginKind.project.symbol)
                        .tag(project.id)
                }
            }
            .pickerStyle(.inline)
        } label: {
            CbMenuLabel(title: title, systemImage: symbol, active: dumpTarget != "auto")
        }
        .accessibilityLabel("\(L("Destination")): \(title)")
        .accessibilityIdentifier("dumpster-target")
    }

    // ── Memory ──
    private var memory: some View {
        VStack(spacing: 0) {
            CbSearch(placeholder: L("Search title, content or tags…"), text: $search, identifier: "context-search")
                .onChange(of: search) { debounceSearch() }
                .padding(.horizontal, 16)
                .padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)
                    if loading && items.isEmpty {
                        CbRowSkeleton(tile: true)
                    } else if items.isEmpty {
                        if loaded {
                            contextEmpty(filtered: !search.isEmpty || state.contextCategory != nil) {
                                state.contextSub = .dumpster
                            }
                        }
                    } else {
                        CbSummary(parts: contextSummary(items.count, pinned: 0), identifier: "context-summary")
                        contextList(items, id: \.id) { item in row(item) }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await load() }
            .scrollDismissesKeyboard(.immediately)
        }
    }

    /// A tile-form row: the category's tile, title, category · date · source, two lines of text, chevron.
    /// Tapping opens the whole entry, long-press deletes (a workspace entry is not edited on mobile).
    private func row(_ item: WorkspaceContextItem) -> some View {
        Button {
            detail = item
        } label: {
            CbTileRow(
                symbol: contextSymbol(item.category),
                title: contextTitle(item.title),
                shortLine: contextShortLine([item.category, contextTag(item.createdAt), item.source]),
                text: contextPreview(summary: item.summary, body: item.body),
                chevron: true
            )
        }
        .cbRowPress()
        .contextMenu {
            Button(role: .destructive) {
                deleting = item
            } label: {
                Label(L("Delete"), systemImage: "trash")
            }
        }
        .accessibilityIdentifier("context-item-\(item.id)")
    }

    private func afterTheDetail() {
        guard let item = byDetail else { return }
        byDetail = nil
        deleting = item
    }

    private func debounceSearch() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            await load()
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        var query: [URLQueryItem] = []
        if let category = state.contextCategory { query.append(URLQueryItem(name: "category", value: category)) }
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines)
        // Meaning search (semantic + BM25 + structure boosts) instead of a substring filter —
        // same semantics as in the desktop and web client.
        if !needle.isEmpty {
            query.append(URLQueryItem(name: "search", value: needle))
            query.append(URLQueryItem(name: "limit", value: "100"))
        }
        do {
            items = try await client.get("/api/workspaces/\(workspaceId)/context", query: query)
            loaded = true
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func dump() async {
        let text = dumpText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        dumpBusy = true
        dumpState = .running(dumpTarget == "auto" ? L("LLM is detecting the project…") : L("LLM is filing it…"))
        struct Body: Encodable {
            let text: String
            let source: String
            let route: String?
            let projectId: String?
        }
        do {
            let response: WorkspaceDumpResult = try await client.post(
                "/api/workspaces/\(workspaceId)/context",
                body: Body(
                    text: text,
                    source: dumpSource.trimmingCharacters(in: .whitespaces),
                    route: dumpTarget == "workspace" ? "workspace" : nil,
                    projectId: dumpTarget != "auto" && dumpTarget != "workspace" ? dumpTarget : nil
                )
            )
            dumpText = ""
            dumpSource = ""
            // An unclear drop lands in the workspace dumpster.
            if response.target == "project" {
                dumpState = .ok(L("Project \"{name}\": {status} — \"{title}\".", [
                    "name": response.projectName ?? "",
                    "status": response.status == "updated" ? L("merged into an existing entry") : L("filed as new"),
                    "title": response.title ?? ""
                ]))
            } else {
                dumpState = .ok(L("Workspace context: \"{category}\" — {title}", [
                    "category": response.category ?? "",
                    "title": response.title ?? ""
                ]))
            }
            await load()
            await state.reloadOverview()
        } catch {
            dumpState = .error(L("Error: {msg}", ["msg": error.localizedDescription]))
        }
        dumpBusy = false
    }

    private func remove(_ item: WorkspaceContextItem) async {
        let _: OKResponse? = try? await client.delete("/api/workspaces/\(workspaceId)/context/\(item.id)")
        await load()
        await state.reloadOverview()
    }
}

// ── Projekt-Kontext ─────────────────────────────────────────────────────────
struct ProjectContextPane: View {
    let client: APIClient
    let projectId: String
    let projectName: String
    @EnvironmentObject private var state: AppState

    @State private var schema: [ProjectContextSchemaEntry] = []
    @State private var items: [ProjectContextItem] = []
    @State private var suggestions: [ContextSuggestion] = []
    @State private var adoptable: [AdoptableContextCategory] = []
    @State private var search = ""
    @State private var loading = true
    /// True only after a successful answer of the entries (like `WorkspaceContextPane.loaded`).
    @State private var loaded = false
    @State private var error = ""
    @State private var dumpText = ""
    @State private var dumpBusy = false
    @State private var dumpState: DropInStatus = .empty
    @State private var draft: ProjectContextDraft?
    @State private var deleting: ProjectContextItem?
    @State private var showAdopt = false
    @State private var importState: DropInStatus = .empty
    @State private var searchTask: Task<Void, Never>?
    @State private var detail: ProjectContextDetail?
    @State private var byDetail: ByDetail?
    @State private var suggestion: ContextSuggestion?
    @State private var infoOpen = false

    /// What should happen after the detail sheet closes (`AgentsPane.byDetail`).
    private enum ByDetail {
        case edit(ProjectContextItem)
        case erase(ProjectContextItem)
    }

    var body: some View {
        PaneScaffold(title: L("Context"), trailing: AnyView(headerButtons)) {
            Group {
                if state.contextSub == .dumpster {
                    dumpster
                } else {
                    memory
                }
            }
            .animation(.easeInOut(duration: 0.2), value: state.contextSub)
        }
        .task { await initialLoad() }
        .onChange(of: state.contextCategory) { Task { await loadItems() } }
        .sheet(item: $draft) { current in
            ProjectContextEditor(draft: current, schema: schema) { saved in try await save(saved) }
            .cbSheet(.whole)
        }
        .sheet(isPresented: $showAdopt) {
            AdoptContextSheet(categories: adoptable) { category, enabled in
                struct Body: Encodable { let category: String; let enabled: Bool }
                try await client.send(
                    "/api/projects/\(projectId)/context/adopt",
                    body: Body(category: category, enabled: enabled)
                )
                await loadAdopt()
                await loadItems()
            }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { d in
            ContextEntrySheet(
                entry: ContextEntry(project: d.item, category: categoryName(d.item)),
                edit: d.item.isAdopted ? nil : {
                    byDetail = .edit(d.item)
                    detail = nil
                },
                erase: d.item.isAdopted ? nil : {
                    byDetail = .erase(d.item)
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(item: $suggestion) { s in
            ContextSuggestionSheet(
                suggestion: s,
                category: labelOf(s.category),
                apply: {
                    suggestion = nil
                    Task { await applySuggestion(s) }
                },
                dismiss: {
                    suggestion = nil
                    Task { await dismissSuggestion(s) }
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { contextInfoSheet(inProject: true).cbSheet(.half) }
        .confirmationDialog(
            L("Delete context entry?"),
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let item = deleting { Task { await remove(item) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    /// ⓘ always; under memory additionally ⋯ (adopt workspace context, import folder) and "New".
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About context"), identifier: "context-info") { infoOpen = true }
            if state.contextSub == .memory {
                moreMenu
                PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                    draft = ProjectContextDraft(category: schema.first?.slug ?? "overview")
                }
                .accessibilityIdentifier("context-new")
            }
        }
    }

    /// The ⋯ in the header — shaped like `CbRoundButton`, but as a `Menu` (a button inside a menu's label
    /// would not reliably receive the touch).
    ///
    /// The identifier sits only on the MENU (`context-more`): SwiftUI does not pass `accessibilityIdentifier` on to the UIKit action
    /// of a menu item. A test finds the entries by their LABEL ("Adopt workspace context", "Import folder").
    private var moreMenu: some View {
        Menu {
            Button {
                showAdopt = true
            } label: {
                Label(L("Adopt workspace context"), systemImage: "arrow.down.to.line")
            }
            Button {
                Task { await importFolders() }
            } label: {
                Label(L("Import folder"), systemImage: "folder.badge.plus")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.symbol(13, weight: .semibold))
                .foregroundStyle(Color.primary)
                .frame(width: 32, height: 32)
                .background(.cbElevated, in: Circle())
        }
        .accessibilityLabel(L("More"))
        .accessibilityIdentifier("context-more")
    }

    private var dumpster: some View {
        ScrollView {
            ContextDropIn(
                text: $dumpText,
                textIdentifier: "project-dumpster-text",
                sendIdentifier: "project-dumpster-send",
                statusIdentifier: "project-dumpster-status",
                busy: dumpBusy,
                snapshot: dumpState,
                send: { Task { await dump() } }
            )
            .padding(.horizontal, 16)
            .padding(.top, 2)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Headers only if more than one group is present — or suggestions above an empty list (otherwise the
    /// empty state below would read as if it applied to the suggestions).
    private var showHeaders: Bool {
        let groups = [!suggestions.isEmpty, items.contains { !$0.isAdopted }, items.contains { $0.isAdopted }]
            .filter { $0 }.count
        return groups > 1 || (!suggestions.isEmpty && items.isEmpty)
    }

    private var memory: some View {
        VStack(spacing: 0) {
            CbSearch(placeholder: L("Search title, content or tags…"), text: $search, identifier: "project-context-search")
                .onChange(of: search) { debounceSearch() }
                .padding(.horizontal, 16)
                .padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)
                    if importState != .empty {
                        ContextStatusRow(snapshot: importState, identifier: "context-import-status")
                            .padding(.horizontal, 8)
                            .padding(.bottom, 10)
                    }

                    // The summary counts the entries of both groups — so it sits above the page, not above
                    // a group; the suggestions are counted by their header.
                    if !items.isEmpty {
                        CbSummary(
                            parts: contextSummary(items.count, pinned: items.filter(\.pinned).count),
                            identifier: "context-summary"
                        )
                    }

                    // Groups: suggestions → project (own) → workspace (adopted, read-only); in each the
                    // server's order.
                    if !suggestions.isEmpty {
                        if showHeaders {
                            CbTileHeader(symbol: "sparkles", title: L("Proposals"), right: String(suggestions.count), margin: true)
                        }
                        contextList(suggestions, id: \.id) { s in suggestionRow(s) }
                    }

                    if loading && items.isEmpty {
                        CbRowSkeleton(tile: true)
                            .padding(.top, suggestions.isEmpty ? 0 : 16)
                    } else if items.isEmpty {
                        if loaded {
                            contextEmpty(filtered: !search.isEmpty || state.contextCategory != nil) {
                                state.contextSub = .dumpster
                            }
                        }
                    } else {
                        let own = items.filter { !$0.isAdopted }
                        let takenOver = items.filter { $0.isAdopted }
                        if !own.isEmpty {
                            if showHeaders {
                                CbTileHeader(origin: .project, name: projectName, margin: true)
                                    .padding(.top, suggestions.isEmpty ? 0 : 16)
                            }
                            contextList(own, id: \.rowKey) { item in entryRow(item) }
                        }
                        if !takenOver.isEmpty {
                            if showHeaders {
                                CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                                    .padding(.top, suggestions.isEmpty && own.isEmpty ? 0 : 16)
                            }
                            contextList(takenOver, id: \.rowKey) { item in entryRow(item) }
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await initialLoad() }
            .scrollDismissesKeyboard(.immediately)
        }
    }

    /// An entry in tile form: the category's tile, title, "Pinned" as dot plus word, category · date ·
    /// as-of (without headers an adopted one starts with "adopted" — otherwise the "Workspace" header says it), two lines of
    /// text, chevron.
    private func entryRow(_ item: ProjectContextItem) -> some View {
        Button {
            detail = ProjectContextDetail(item: item)
        } label: {
            CbTileRow(
                symbol: contextSymbol(item.category),
                title: contextTitle(item.title),
                state: item.pinned ? CbState(L("Pinned"), CbColor.textMuted) : nil,
                shortLine: contextShortLine([
                    item.isAdopted && !showHeaders ? L("adopted") : nil,
                    categoryName(item),
                    contextTag(item.updatedAt),
                    item.validAsOf.isEmpty ? nil : "\(L("As of:")) \(item.validAsOf)"
                ]),
                text: contextPreview(summary: item.summary, body: item.body),
                chevron: true
            )
        }
        .cbRowPress()
        .contextMenu {
            if item.isAdopted {
                // Read-only — maintained at workspace level; here only the way to adopt per category.
                Button {
                    showAdopt = true
                } label: {
                    Label(L("Adopt workspace context"), systemImage: "arrow.down.to.line")
                }
            } else {
                Button {
                    draft = ProjectContextDraft(item: item)
                } label: {
                    Label(L("Edit"), systemImage: "pencil")
                }
                Button(role: .destructive) {
                    deleting = item
                } label: {
                    Label(L("Delete"), systemImage: "trash")
                }
            }
        }
        .accessibilityIdentifier("project-context-\(item.rowKey)")
    }

    /// A curator suggestion in tile form: the tile with the action's sign in orange (it waits for a
    /// decision), title, action · category, the reasoning as text, chevron.
    private func suggestionRow(_ s: ContextSuggestion) -> some View {
        Button {
            suggestion = s
        } label: {
            CbTileRow(
                symbol: suggestionSymbol(s.op),
                situation: .waiting,
                title: contextTitle(s.title),
                shortLine: contextShortLine([suggestionWord(s.op), labelOf(s.category)]),
                text: s.reason,
                chevron: true
            )
        }
        .cbRowPress()
        .contextMenu {
            Button {
                Task { await applySuggestion(s) }
            } label: {
                Label(L("Apply"), systemImage: "checkmark")
            }
            // Without `role: .destructive`: dismissing keeps the entry (red belongs to deleting, see `ContextSuggestionSheet`).
            Button {
                Task { await dismissSuggestion(s) }
            } label: {
                Label(L("Dismiss"), systemImage: "xmark")
            }
        }
        .accessibilityIdentifier("context-suggestion-\(s.id)")
    }

    private func afterTheDetail() {
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .edit(let item): draft = ProjectContextDraft(item: item)
        case .erase(let item): deleting = item
        }
    }

    private func labelOf(_ slug: String) -> String {
        L(schema.first(where: { $0.slug == slug })?.label ?? slug)
    }

    /// Adopted entries carry the workspace's free category, own ones a schema slug.
    private func categoryName(_ item: ProjectContextItem) -> String {
        item.isAdopted ? item.category : labelOf(item.category)
    }

    private func debounceSearch() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(280))
            guard !Task.isCancelled else { return }
            await loadItems()
        }
    }

    private func initialLoad() async {
        schema = (try? await client.get("/api/project-context/schema")) ?? []
        await loadItems()
        await loadCounts()
        await loadSuggestions()
        await loadAdopt()
    }

    private func loadItems() async {
        loading = true
        defer { loading = false }
        var query: [URLQueryItem] = []
        if let category = state.contextCategory { query.append(URLQueryItem(name: "category", value: category)) }
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines)
        // Meaning search (semantic + BM25 + structure boosts) instead of a substring filter —
        // same semantics as in the desktop and web client.
        if !needle.isEmpty {
            query.append(URLQueryItem(name: "search", value: needle))
            query.append(URLQueryItem(name: "limit", value: "100"))
        }
        do {
            items = try await client.get("/api/projects/\(projectId)/context", query: query)
            loaded = true
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadCounts() async {
        let rows: [ContextCategory] = (try? await client.get("/api/projects/\(projectId)/context/categories")) ?? []
        state.projectContextCounts = rows.map { row in
            ContextCategory(category: labelOf(row.category), n: row.n, slug: row.category)
        }
    }

    private func loadSuggestions() async {
        suggestions = (try? await client.get("/api/projects/\(projectId)/context-suggestions")) ?? []
    }

    private func loadAdopt() async {
        adoptable = (try? await client.get("/api/projects/\(projectId)/context/adopt")) ?? []
    }

    private func dump() async {
        let text = dumpText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        dumpBusy = true
        dumpState = .running(L("Sorting in…"))
        struct Body: Encodable { let text: String }
        do {
            let response: ContextDumpResult = try await client.post(
                "/api/projects/\(projectId)/context/dump",
                body: Body(text: text)
            )
            if response.status == "created" || response.status == "updated" {
                dumpText = ""
                dumpState = .ok(response.status == "created"
                    ? L("New memory entry created")
                    : L("Existing memory entry extended"))
                await loadItems()
                await loadCounts()
            } else {
                dumpState = .error(response.error ?? L("Could not be filed"))
            }
        } catch {
            dumpState = .error(L("Error: {msg}", ["msg": error.localizedDescription]))
        }
        dumpBusy = false
    }

    private func save(_ saved: ProjectContextDraft) async throws {
        struct Body: Encodable {
            let category: String
            let title: String
            let body: String
            let summary: String
            let tags: [String]
            let validAsOf: String
            let pinned: Bool
            let force: Bool
        }
        let payload = Body(
            category: saved.category,
            title: saved.title.trimmingCharacters(in: .whitespaces),
            body: saved.body,
            summary: saved.summary.trimmingCharacters(in: .whitespaces),
            tags: saved.tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
            validAsOf: saved.validAsOf.trimmingCharacters(in: .whitespaces),
            pinned: saved.pinned,
            force: true
        )
        if let editing = saved.editing {
            try await client.send("/api/projects/\(projectId)/context/\(editing)", method: .put, body: payload)
        } else {
            try await client.send("/api/projects/\(projectId)/context", method: .post, body: payload)
        }
        await loadItems()
        await loadCounts()
    }

    private func remove(_ item: ProjectContextItem) async {
        let _: OKResponse? = try? await client.delete("/api/projects/\(projectId)/context/\(item.id)")
        await loadItems()
        await loadCounts()
    }

    private func applySuggestion(_ suggestion: ContextSuggestion) async {
        _ = try? await client.send("/api/projects/\(projectId)/context-suggestions/\(suggestion.id)/apply")
        await loadSuggestions()
        await loadItems()
        await loadCounts()
    }

    private func dismissSuggestion(_ suggestion: ContextSuggestion) async {
        _ = try? await client.send("/api/projects/\(projectId)/context-suggestions/\(suggestion.id)/dismiss")
        await loadSuggestions()
    }

    private func importFolders() async {
        importState = .running(L("Importing…"))
        struct Response: Decodable { let imported: [String]?; let skipped: [String]? }
        if let response: Response = try? await client.post("/api/projects/\(projectId)/context/import-folders") {
            importState = .ok(L("{imported} imported, {skipped} skipped.", [
                "imported": response.imported?.count ?? 0,
                "skipped": response.skipped?.count ?? 0
            ]))
            await loadItems()
            await loadCounts()
        } else {
            importState = .error(L("Could not be loaded"))
        }
    }
}

// ── Shared parts of both levels ──────────────────────────────────────────

/// The rows of a group in tile form: without hairlines, the tile separates them — like
/// `OuterLoopPane.liste`. `id` per level (`rowKey` in the project: own and adopted entries can carry the same
/// number).
@MainActor
private func contextList<Entry, Identifier: Hashable, Row: View>(
    _ entries: [Entry],
    id: KeyPath<Entry, Identifier>,
    @ViewBuilder row: @escaping (Entry) -> Row
) -> some View {
    VStack(spacing: 2) {
        ForEach(entries, id: id) { entry in
            row(entry)
        }
    }
}

/// "12 entries · 2 pinned" — pinned only if one is (workspace entries cannot be pinned).
private func contextSummary(_ count: Int, pinned: Int) -> [String] {
    var parts = [count == 1 ? L("1 entry") : L("{n} entries", ["n": count])]
    if pinned > 0 { parts.append(L("{n} pinned", ["n": pinned])) }
    return parts
}

/// The sign of a context category (display only, nothing depends on it) — in the row's tile and in the entry sheet's header.
/// The slugs of the project schema (`projects/context.js` PROJECT_CATEGORIES) are fixed; workspace categories are free text (also
/// the adopted ones in the project) and are guessed from their WORDS like `agentSymbol`/`mcpSymbol` — otherwise every row at
/// workspace level would carry the same document. Word beginnings, lowercase and without umlaut dots ("Übersicht" → "ubersicht");
/// the table order decides, without a hit the document (also "Other", the server's default). The word lists are DATA:
/// German and English beginnings, because categories are free user text.
///
/// Expectations (computed by hand): "Architektur" → building.columns · "Setup & Deployment" → wrench.and.screwdriver ·
/// "Entscheidungen" → signpost.right · "Kunden" → person.2 · "Offene Fragen" → questionmark.circle · "Datenbank" →
/// cylinder.split.1x2 · "Other" → doc.text.
private func contextSymbol(_ category: String) -> String {
    switch category {
    case "overview": return "doc.text"
    case "domain": return "books.vertical"
    case "architecture": return "building.columns"
    case "repositories": return "arrow.triangle.branch"
    case "setup": return "wrench.and.screwdriver"
    case "decisions": return "signpost.right"
    case "pitfalls": return "exclamationmark.triangle"
    case "open-points": return "questionmark.circle"
    case "deliverables": return "shippingbox"
    case "references": return "link"
    default: break
    }
    let words = category.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        .split { !$0.isLetter && !$0.isNumber }
        .map(String.init)
    let table: [(symbol: String, beginnings: [String])] = [
        ("exclamationmark.triangle", ["fallstrick", "falle", "pitfall", "gotcha", "risik", "risk", "bug", "fehler", "problem"]),
        ("questionmark.circle", ["offen", "frage", "question", "todo"]),
        ("signpost.right", ["entscheid", "decision", "adr"]),
        ("building.columns", ["architektur", "architecture", "aufbau", "struktur"]),
        ("wrench.and.screwdriver", ["setup", "einricht", "install", "deploy", "betrieb", "infra", "ops", "konfig", "config"]),
        ("cylinder.split.1x2", ["datenbank", "database", "daten", "data", "schema", "db"]),
        ("arrow.triangle.branch", ["repo", "git", "code", "branch"]),
        ("lock", ["zugang", "zugaeng", "credential", "secret", "auth", "sicherheit", "security", "passw"]),
        ("person.2", ["kunde", "customer", "client", "team", "person", "people", "kontakt", "ansprech", "stakeholder"]),
        ("books.vertical", ["domane", "domaene", "domain", "fachlich", "glossar", "begriff", "wissen"]),
        ("shippingbox", ["liefer", "release", "deliver", "produkt"]),
        ("calendar", ["termin", "meeting", "besprech", "protokoll", "plan", "roadmap", "sprint"]),
        ("link", ["referenz", "reference", "link", "quelle", "doku", "docs"]),
        ("doc.text", ["ubersicht", "uebersicht", "overview", "allgemein", "general", "notiz", "note"]),
    ]
    for entry in table where words.contains(where: { w in entry.beginnings.contains { w.hasPrefix($0) } }) {
        return entry.symbol
    }
    return "doc.text"
}

private func contextTitle(_ title: String) -> String {
    title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? L("(untitled)") : title
}

/// The short line from its parts — empty ones drop out; if all are empty there is none.
private func contextShortLine(_ parts: [String?]) -> Text? {
    let set = contextShort(parts)
    return set.isEmpty ? nil : Text(set)
}

private func contextShort(_ parts: [String?]) -> String {
    parts.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
}

/// Day and month ("12.09."), from another year with the year — `nil` without a timestamp.
private func contextTag(_ value: Double) -> String? {
    guard value > 0 else { return nil }
    let date = locDate(fromServer: value)
    let formatter = DateFormatter()
    formatter.locale = Loc.locale
    let thisYear = Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
    formatter.setLocalizedDateFormatFromTemplate(thisYear ? "ddMM" : "ddMMyy")
    return formatter.string(from: date)
}

/// Date and time in the detail sheet.
private func contextMoment(_ value: Double) -> String {
    let formatter = DateFormatter()
    formatter.locale = Loc.locale
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: locDate(fromServer: value))
}

/// The two lines of text of a row: the summary — if missing, the beginning of the content as plain text
/// (heading, quote and bullet characters at the line start, `*` and `` ` `` everywhere, code fences and line breaks
/// removed; a link keeps its text). About 200 characters — two lines show no more.
private func contextPreview(summary: String, body: String) -> String? {
    let summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    if !summary.isEmpty { return summary }
    var parts: [String] = []
    var length = 0
    for raw in body.prefix(1200).split(whereSeparator: \.isNewline) {
        var row = raw.trimmingCharacters(in: .whitespaces)
        if row.hasPrefix("```") { continue }
        while let first = row.first, "#>-*+".contains(first) {
            row = String(row.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        row.removeAll { $0 == "*" || $0 == "`" }
        row = row.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        row = row.trimmingCharacters(in: .whitespaces)
        guard !row.isEmpty else { continue }
        parts.append(row)
        length += row.count + 1
        if length >= 200 { break }
    }
    let text = String(parts.joined(separator: " ").prefix(200))
    return text.isEmpty ? nil : text
}

/// The word of a curator action.
private func suggestionWord(_ op: String) -> String {
    op == "create" ? L("New") : op == "update" ? L("Update") : L("Delete")
}

/// The sign of a curator action (in the row's tile and in the suggestion sheet's header).
private func suggestionSymbol(_ op: String) -> String {
    op == "create" ? "plus" : op == "update" ? "pencil" : "trash"
}

/// The empty state of memory: a row with a muted tile (the dumpster's tray) and the way into the dumpster.
private func contextEmpty(filtered: Bool, toDumpster: @escaping () -> Void) -> CbTileEmpty {
    CbTileEmpty(
        symbol: filtered ? "magnifyingglass" : "tray",
        text: filtered ? L("No matching entries") : L("No context yet"),
        button: L("To the dumpster"),
        buttonIdentifier: "context-to-dumpster",
        create: toDumpster
    )
}

/// The explanations (subtitle and explanation cards above the dumpster). In the project the sheet says what applies there
/// (project entries, adopted ones read-only, the curator); at workspace level there is neither editing nor
/// suggestions — there it says only what holds there.
@MainActor
private func contextInfoSheet(inProject: Bool) -> CbInfoSheet {
    let points: [CbInfoDot] = inProject
        ? [
            CbInfoDot(symbol: "tray", word: L("Dumpster"), text: L("Drop in text — an LLM recognizes the context and creates an entry in this project or extends a matching one.")),
            CbInfoDot(origin: .project, text: L("Entries of this project — added by hand or from the dumpster.")),
            CbInfoDot(origin: .workspace, text: L("Workspace entries can be adopted per category; here they are read-only.")),
            CbInfoDot(symbol: "sparkles", tone: .accentColor, word: L("Curator"), text: L("The curator proposes changes — nothing takes effect without “Apply”.")),
        ]
        : [
            CbInfoDot(symbol: "tray", word: L("Dumpster"), text: L("Drop in text — an LLM recognizes the context and creates an entry or extends a matching one. Target: automatic, workspace or a project.")),
            CbInfoDot(origin: .workspace, text: L("Entries at the workspace level — a project adopts them per category.")),
        ]
    return CbInfoSheet(
        title: L("Context"),
        intro: L("Curated knowledge the agents read. Search goes by meaning, not just by words."),
        points: points,
        footnote: inProject
            ? L("Tap to see the whole entry. Press and hold to edit or delete.")
            : L("Tap to see the whole entry. Press and hold to delete.")
    )
}

// ── Dumpster: the input field ───────────────────────────────────────────────

/// The state of a drop (or of the folder import) — as a row with a sign instead of a colored sentence.
private enum DropInStatus: Equatable {
    case empty
    case running(String)
    case ok(String)
    case error(String)
}

/// The result as a row: sign on the left (running, ✓ in the accent, ! red), the sentence in `CbColor.textSecondary`.
private struct ContextStatusRow: View {
    let snapshot: DropInStatus
    let identifier: String

    var body: some View {
        switch snapshot {
        case .empty:
            EmptyView()
        case .running(let set):
            row(set) { ProgressView().controlSize(.small) }
        case .ok(let set):
            row(set) { character("checkmark", .accentColor) }
        case .error(let set):
            row(set) { character("exclamationmark", .red) }
        }
    }

    private func character(_ symbol: String, _ tone: Color) -> some View {
        Image(systemName: symbol)
            .font(.symbol(12, weight: .bold))
            .foregroundStyle(tone)
    }

    private func row<Z: View>(_ set: String, @ViewBuilder character: () -> Z) -> some View {
        HStack(alignment: .top, spacing: 9) {
            character()
                .frame(width: 18, height: 18)
                .accessibilityHidden(true)
            Text(set)
                .cbFont(13)
                .foregroundStyle(CbColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(identifier)
        }
    }
}

/// The dumpster's input field like the composer island (surface, radius 20, hairline edge), below it ONE bar: on the left the
/// target (workspace level only), on the right the character count and the round send button; below it the source as a calm
/// row (workspace only) and the result.
private struct ContextDropIn<Target: View>: View {
    @Binding var text: String
    let textIdentifier: String
    let sendIdentifier: String
    let statusIdentifier: String
    let busy: Bool
    let snapshot: DropInStatus
    var source: Binding<String>?
    let send: () -> Void
    let target: Target
    @FocusState private var focus: Bool

    init(
        text: Binding<String>,
        textIdentifier: String,
        sendIdentifier: String,
        statusIdentifier: String,
        busy: Bool,
        snapshot: DropInStatus,
        source: Binding<String>? = nil,
        send: @escaping () -> Void,
        @ViewBuilder target: () -> Target
    ) {
        _text = text
        self.textIdentifier = textIdentifier
        self.sendIdentifier = sendIdentifier
        self.statusIdentifier = statusIdentifier
        self.busy = busy
        self.snapshot = snapshot
        self.source = source
        self.send = send
        self.target = target()
    }

    private static var form: RoundedRectangle { RoundedRectangle(cornerRadius: 20, style: .continuous) }

    private var canSend: Bool {
        !busy && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            field
            bar
            if let source {
                HStack(spacing: 8) {
                    Image(systemName: "link")
                        .font(.symbol(12, weight: .medium))
                        .foregroundStyle(CbColor.textMuted)
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    TextField(L("Source (optional)"), text: source)
                        .cbFont(13)
                        .foregroundStyle(CbColor.text)
                        .accessibilityIdentifier("dumpster-source")
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
            }
            if snapshot != .empty {
                ContextStatusRow(snapshot: snapshot, identifier: statusIdentifier)
                    .padding(.horizontal, 6)
            }
        }
    }

    private var field: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .cbFont(15)
                .foregroundStyle(CbColor.text)
                .scrollContentBackground(.hidden)
                .focused($focus)
                .frame(minHeight: 170)
                .accessibilityIdentifier(textIdentifier)
            if text.isEmpty {
                // The placeholder's margin is the `TextEditor`'s text margin (5 pt line padding, 8 pt top).
                Text(L("Drop in notes, decisions, details or loose ideas…"))
                    .cbFont(15)
                    .foregroundStyle(CbColor.textMuted)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 8)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.cbSurface, in: Self.form)
        .overlay(Self.form.strokeBorder(CbColor.edge))
    }

    private var bar: some View {
        HStack(spacing: 10) {
            target
            Spacer(minLength: 6)
            Text("\(locFormattedInt(text.count)) \(L("characters"))")
                .cbFont(12, digitsEqual: true)
                .foregroundStyle(CbColor.textMuted)
                .lineLimit(1)
            CbRoundButton(systemImage: busy ? "hourglass" : "arrow.up", accent: true) {
                focus = false
                send()
            }
            .disabled(!canSend)
            .opacity(canSend ? 1 : 0.45)
            .accessibilityLabel(L("Into memory"))
            .accessibilityIdentifier(sendIdentifier)
        }
    }
}

extension ContextDropIn where Target == EmptyView {
    init(
        text: Binding<String>,
        textIdentifier: String,
        sendIdentifier: String,
        statusIdentifier: String,
        busy: Bool,
        snapshot: DropInStatus,
        source: Binding<String>? = nil,
        send: @escaping () -> Void
    ) {
        self.init(
            text: text, textIdentifier: textIdentifier, sendIdentifier: sendIdentifier, statusIdentifier: statusIdentifier,
            busy: busy, snapshot: snapshot, source: source, send: send, target: { EmptyView() }
        )
    }
}

// ── The detail on tap ────────────────────────────────────────────────

private struct ProjectContextDetail: Identifiable {
    let item: ProjectContextItem
    /// Own and adopted entries can carry the same number — `rowKey` cannot.
    var id: String { item.rowKey }
}

/// An entry of both levels in the form the sheet needs.
private struct ContextEntry {
    let title: String
    let category: String
    let symbol: String
    let origin: OriginKind
    let takenOver: Bool
    let pinned: Bool
    let summary: String
    let content: String
    let tags: [String]
    let asOf: String
    let source: String
    /// "Changed" (project, `updated_at`) or "Created" (workspace knows only `created_at`).
    let dateLabel: String
    let date: Double
}

extension ContextEntry {
    init(workspace item: WorkspaceContextItem) {
        self.init(
            title: item.title, category: item.category, symbol: contextSymbol(item.category), origin: .workspace,
            takenOver: false, pinned: false, summary: item.summary, content: item.body,
            tags: contextTags(item.tags), asOf: "", source: item.source,
            dateLabel: L("Created"), date: item.createdAt
        )
    }

    init(project item: ProjectContextItem, category: String) {
        self.init(
            title: item.title, category: category, symbol: contextSymbol(item.category),
            origin: item.isAdopted ? .workspace : .project, takenOver: item.isAdopted, pinned: item.pinned,
            summary: item.summary, content: item.body, tags: contextTags(item.tags), asOf: item.validAsOf,
            source: item.source, dateLabel: L("Updated"), date: item.updatedAt
        )
    }
}

/// All tags.
private func contextTags(_ comma: String) -> [String] {
    comma.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

/// The whole entry: summary, content as markdown (complete), tags, as-of, source, date. Edit in the
/// header only for own project entries; delete at the end — for adopted ones a note instead.
private struct ContextEntrySheet: View {
    let entry: ContextEntry
    let edit: (() -> Void)?
    let erase: (() -> Void)?

    private var addition: [String] {
        var z: [String] = []
        if entry.takenOver { z.append(L("adopted")) }
        if !entry.category.isEmpty { z.append(entry.category) }
        return z
    }

    var body: some View {
        CbDetailSheet(
            primary: edit.map { CbSheetAction(title: L("Edit"), identifier: "context-detail-edit", action: $0) },
            closeIdentifier: "context-detail-close",
            erase: erase.map { CbSheetAction(title: L("Delete"), identifier: "context-detail-delete", action: $0) },
            hint: entry.takenOver ? L("Read-only — maintained at the workspace level.") : nil
        ) {
            CbDetailHeader(
                character: CbSign(
                    symbol: entry.symbol,
                    marker: entry.pinned ? .pin(L("Pinned")) : nil,
                    tile: true
                ),
                title: contextTitle(entry.title)
            ) {
                CbOriginRow(kind: entry.origin, addition: addition)
            }
            if !entry.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                CbDetailDescription(text: entry.summary, empty: "")
            }
            if !entry.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProjectField(L("Content"), symbol: "doc.text") { MarkdownView(source: entry.content) }
            }
            if !entry.tags.isEmpty {
                ProjectField(L("Tags"), symbol: "number", right: String(entry.tags.count)) { CbMarks(names: entry.tags.map { "#\($0)" }) }
            }
            if !entry.asOf.isEmpty {
                // The label is "As of:" without the colon — "Stand" alone means "status" in the dictionary.
                ProjectField(L("As of:").trimmingCharacters(in: CharacterSet(charactersIn: ": ")), symbol: "flag") { value(entry.asOf) }
            }
            if !entry.source.isEmpty {
                ProjectField(L("Source"), symbol: "link") { value(entry.source) }
            }
            if entry.date > 0 {
                ProjectField(entry.dateLabel, symbol: "calendar") { value(contextMoment(entry.date)) }
            }
        }
    }

    private func value(_ text: String) -> some View {
        Text(text)
            .cbFont(14)
            .foregroundStyle(CbColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}

/// A curator suggestion in the sheet: the reasoning first (it is the basis for the decision), then summary
/// and content as markdown. "Apply" on the right in the header, "Dismiss" at the end — CALM with `xmark`, not red with a trash can:
/// dismissing keeps the entry; for a delete suggestion it is "Apply" that deletes.
private struct ContextSuggestionSheet: View {
    let suggestion: ContextSuggestion
    let category: String
    let apply: () -> Void
    let dismiss: () -> Void

    var body: some View {
        CbDetailSheet(
            primary: CbSheetAction(title: L("Apply"), identifier: "context-suggestion-apply", action: apply),
            closeIdentifier: "context-suggestion-close",
            erase: CbSheetAction(
                title: L("Dismiss"), identifier: "context-suggestion-dismiss", symbol: "xmark", destructive: false, action: dismiss
            )
        ) {
            CbDetailHeader(
                character: CbSign(symbol: suggestionSymbol(suggestion.op), tone: CbSituation.waiting.color, tile: true),
                title: contextTitle(suggestion.title)
            ) {
                Text(contextShort([L("Curator"), suggestionWord(suggestion.op), category]))
            }
            if !suggestion.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProjectField(L("Reason"), symbol: "sparkles") { paragraph(suggestion.reason) }
            }
            if !suggestion.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProjectField(L("Summary"), symbol: "text.alignleft") { paragraph(suggestion.summary) }
            }
            if !suggestion.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ProjectField(L("Content"), symbol: "doc.text") { MarkdownView(source: suggestion.body) }
            }
        }
    }

    private func paragraph(_ text: String) -> some View {
        Text(text)
            .cbFont(15)
            .foregroundStyle(CbColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }
}
struct ProjectContextDraft: Identifiable {
    let id = UUID()
    var editing: Int?
    var category: String
    var title = ""
    var body = ""
    var summary = ""
    var tags = ""
    var validAsOf = ""
    var pinned = false

    init(category: String) {
        self.category = category
    }

    init(item: ProjectContextItem) {
        editing = item.id
        category = item.category
        title = item.title
        body = item.body
        summary = item.summary
        tags = item.tags
        validAsOf = item.validAsOf
        pinned = item.pinned
    }
}

private struct ProjectContextEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: ProjectContextDraft
    let schema: [ProjectContextSchemaEntry]
    let save: (ProjectContextDraft) async throws -> Void
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Category")) {
                    Picker(L("Category"), selection: $draft.category) {
                        ForEach(schema) { entry in
                            Text(L(entry.label)).tag(entry.slug)
                        }
                    }
                }
                Section(L("Title")) {
                    TextField(L("Title"), text: $draft.title)
                }
                Section(L("Summary (optional, 1–2 sentences)")) {
                    TextField(L("Summary"), text: $draft.summary, axis: .vertical)
                        .lineLimit(1...4)
                }
                Section(L("Content")) {
                    TextEditor(text: $draft.body)
                        .frame(minHeight: 220)
                        .cbFont(13, design: .monospaced)
                }
                Section {
                    TextField("frontend, auth", text: $draft.tags)
                    TextField(L("e.g. Sprint 3"), text: $draft.validAsOf)
                    Toggle(L("Pin to top"), isOn: $draft.pinned)
                } header: {
                    Text(L("Tags (comma-separated)"))
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(draft.editing == nil ? L("New context entry") : L("Edit context"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await commit() } }
                        .disabled(
                            busy
                            || (draft.title.trimmingCharacters(in: .whitespaces).isEmpty
                                && draft.body.trimmingCharacters(in: .whitespaces).isEmpty)
                        )
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

private struct AdoptContextSheet: View {
    @Environment(\.dismiss) private var dismiss
    let categories: [AdoptableContextCategory]
    let toggle: (String, Bool) async throws -> Void
    @State private var working: String?

    var body: some View {
        NavigationStack {
            CbList {
                Section {
                    if categories.isEmpty {
                        Text(L("No workspace context available.")).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(categories) { entry in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.category).font(.subheadline.weight(.medium))
                                Text(L("{n} entries", ["n": entry.n])).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            CbToggle(isOn: entry.adopted, disabled: working == entry.category) {
                                working = entry.category
                                Task {
                                    try? await toggle(entry.category, !entry.adopted)
                                    working = nil
                                }
                            }
                        }
                    }
                } header: {
                    Text(L("Adopt workspace context"))
                } footer: {
                    Text(L("Adopted entries are read-only here — maintenance stays at workspace level."))
                }
            }
            .navigationTitle(L("Workspace context"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Done")) { dismiss() }
            }
        }
    }
}
