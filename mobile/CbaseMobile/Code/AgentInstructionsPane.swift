import SwiftUI

// ── Coding → Agents → Instructions ─────────────────────────────────────────────────────────────────────────────────────
// Per workspace and per project an ordered list of sections (title, text, on/off, scope `all` | `main` | `sub`) in the
// database; every agent gets them in the system prompt on every turn: `all` the main, sub and workflow agent, `main` only
// the main run, `sub` only subagents and workflow agents. They replace the personas. Server:
// `server/backend/electron/server/workspaces/instructions-routes.js`. Web counterpart: `components/AgentInstructions.tsx`.
//
// The third kind of the "Agents" category (`AgentKindBar` fixed under the title) in the tile form of the subagents and
// the outer loop (`Kit/CbTile.swift`). Workspace level: the sections with the `on` switch; a tap opens the editor
// (`InstructionEditor`, a sheet with `.cbSheet`), long press: Edit · Move up · Move down · Delete. In a project first
// "From the workspace", where the switch is the takeover into this project (opt-out, no row = taken over); those are
// edited on workspace level; below it "This project" as above.
//
// Conflict protection via `version`: a 409 reloads and says so; in the editor the own version stays, "Load new state"
// takes the server's. Reloaded on the event `instructions` (`AppState.instructionsTick`).
struct AgentInstructionsPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var snapshot: InstructionsStatus?
    @State private var loading = true
    @State private var error = ""
    @State private var hint = ""
    @State private var editor: InstructionEditorTarget?
    @State private var deleteQuestion: AgentSection?
    @State private var toggles: String?

    private var cap: InstructionsCap { snapshot?.cap ?? InstructionsCap() }
    private var wsSections: [AgentSection] { snapshot?.workspace ?? [] }
    private var projectSections: [AgentSection] { snapshot?.project ?? [] }

    var body: some View {
        PaneScaffold(title: L("Instructions"), trailing: AnyView(headerButtons)) {
            VStack(spacing: 0) {
                AgentKindBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(L("Depending on scope, applies to the main agent, subagents and workflow agents of every provider — in the system prompt on every turn, also after compacting."))
                            .cbFont(13)
                            .foregroundStyle(CbColor.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, 14)
                            .padding(.bottom, 10)
                            .accessibilityIdentifier("instructions-explanation")
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)
                        if !hint.isEmpty {
                            Label(hint, systemImage: "arrow.triangle.2.circlepath")
                                .cbFont(13)
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 14)
                                .padding(.bottom, 8)
                                .accessibilityIdentifier("instructions-conflict")
                        }
                        if loading && snapshot == nil {
                            CbRowSkeleton(tile: true)
                        } else if snapshot != nil {
                            if projectId == nil { workspaceList } else { projectList }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                // The kind switches the WHOLE page (own `.id` in `CategoryContent`), the bar stays (`AgentKindBar`).
                .cbFadeIn(at: state.agentKind, atAppear: true)
            }
        }
        .task { await load() }
        .onChange(of: state.instructionsTick) { Task { await load() } }
        .sheet(item: $editor) { target in
            InstructionEditor(
                client: client, workspaceId: workspaceId, target: target, cap: cap
            ) { Task { await load() } }
            .cbSheet(.whole)
        }
        .confirmationDialog(
            deleteQuestion.map { L("Delete section “{title}”?", ["title": $0.title]) } ?? "",
            isPresented: Binding(get: { deleteQuestion != nil }, set: { if !$0 { deleteQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let a = deleteQuestion { Task { await erase(a) } }
                deleteQuestion = nil
            }
            Button(L("Cancel"), role: .cancel) { deleteQuestion = nil }
        } message: {
            Text(L("No agent will receive it afterwards."))
        }
    }

    private var headerButtons: some View {
        PillButton(title: L("New"), systemImage: "plus", prominent: true) {
            editor = InstructionEditorTarget(section: nil, projectId: projectId)
        }
        .disabled(snapshot == nil)
        .accessibilityIdentifier("instructions-new")
    }

    // ── Workspace level ──
    @ViewBuilder
    private var workspaceList: some View {
        CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
        if wsSections.isEmpty {
            CbTileEmpty(symbol: "text.badge.plus", text: L("No instructions for this workspace yet."), identifier: "instructions-empty") {
                editor = InstructionEditorTarget(section: nil, projectId: nil)
            }
        } else {
            CbSummary(parts: summary(wsSections, on: wsSections.filter(\.on).count), identifier: "instructions-summary")
            list(wsSections)
        }
    }

    // ── In a project: From the workspace · This project ──
    @ViewBuilder
    private var projectList: some View {
        CbTileHeader(symbol: OriginKind.workspace.symbol, title: L("From the workspace"), name: state.activeWorkspace?.name, margin: true)
        if wsSections.isEmpty {
            CbTileEmpty(symbol: "text.alignleft", text: L("The workspace has no instructions."))
        } else {
            CbSummary(
                parts: summary(wsSections, on: wsSections.filter { $0.on && $0.takenOver != false }.count),
                identifier: "instructions-ws-summary"
            )
            VStack(spacing: 2) {
                ForEach(wsSections) { a in
                    let takenOver = a.takenOver != false
                    CbToggleRow(
                        isOn: takenOver,
                        disabled: toggles == a.id,
                        toggleLabel: L("Adopt in this project: {title}", ["title": a.title]),
                        toggleIdentifier: "instructions-takeover-\(a.id)",
                        toggle: { Task { await takeover(a, !takenOver) } }
                    ) {
                        row(a, active: takenOver && a.on,
                              state: !a.on ? CbState(L("off in the workspace"), CbColor.textMuted)
                                  : !takenOver ? CbState(L("not adopted here"), CbColor.textMuted) : nil)
                    }
                }
            }
            Text(L("The switch adopts a section into this project. They are edited at the workspace level."))
                .cbFont(12.5)
                .foregroundStyle(CbColor.textMuted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.top, 6)
        }
        CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
            .padding(.top, 16)
        if projectSections.isEmpty {
            CbTileEmpty(symbol: "text.badge.plus", text: L("No instructions for this project yet."), identifier: "instructions-empty") {
                editor = InstructionEditorTarget(section: nil, projectId: projectId)
            }
        } else {
            CbSummary(parts: summary(projectSections, on: projectSections.filter(\.on).count), identifier: "instructions-summary")
            list(projectSections)
        }
    }

    /// "3 sections · 2 on".
    private func summary(_ list: [AgentSection], on: Int) -> [String] {
        [list.count == 1 ? L("1 section") : L("{n} sections", ["n": list.count]), L("{n} on", ["n": on])]
    }

    /// The own sections of a level: switch `on`, tap = editor, long press = menu including the order.
    private func list(_ sections: [AgentSection]) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(sections.enumerated()), id: \.element.id) { index, a in
                CbToggleRow(
                    isOn: a.on,
                    disabled: toggles == a.id,
                    toggleLabel: a.title,
                    toggleIdentifier: "instructions-an-\(a.id)",
                    toggle: { Task { await toggle(a) } },
                    tap: { editor = InstructionEditorTarget(section: a, projectId: projectId) },
                    identifier: "instructions-\(a.id)"
                ) {
                    row(a, active: a.on, state: nil)
                }
                .contextMenu {
                    Button { editor = InstructionEditorTarget(section: a, projectId: projectId) } label: { Label(L("Edit"), systemImage: "pencil") }
                    Button { Task { await move(sections, from: index, to: index - 1) } } label: { Label(L("Move Up"), systemImage: "arrow.up") }
                        .disabled(index == 0)
                    Button { Task { await move(sections, from: index, to: index + 1) } } label: { Label(L("Move Down"), systemImage: "arrow.down") }
                        .disabled(index == sections.count - 1)
                    Button(role: .destructive) { deleteQuestion = a } label: { Label(L("Delete"), systemImage: "trash") }
                }
            }
        }
    }

    private func row(_ a: AgentSection, active: Bool, state: CbState?) -> some View {
        CbTileRow(
            symbol: InstructionWord.glyph(a.scope),
            situation: CbSituation.toggle(active),
            title: a.title.isEmpty ? L("(untitled)") : a.title,
            state: state,
            shortLine: Text(verbatim: [InstructionWord.scope(a.scope), InstructionWord.character(a.text.utf16.count)].joined(separator: " · ")),
            text: a.text,
            active: active
        )
    }

    // ── Loading and acting ──
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            snapshot = try await InstructionsAPI.load(client, workspaceId: workspaceId, projectId: projectId)
            error = ""
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A failure on write: 409 means "changed meanwhile": hint and reload; otherwise the server's sentence.
    private func failure(_ error: Error) async {
        if InstructionsAPI.isConflict(error) {
            hint = L("A section changed meanwhile — the list has been reloaded.")
        } else {
            self.error = error.localizedDescription
        }
        await load()
    }

    private func toggle(_ a: AgentSection) async {
        toggles = a.id
        defer { toggles = nil }
        hint = ""
        do {
            _ = try await InstructionsAPI.change(client, workspaceId: workspaceId, sectionId: a.id,
                                                 draft: InstructionDraft(a, on: !a.on), version: a.version)
            await load()
        } catch {
            await failure(error)
        }
    }

    private func takeover(_ a: AgentSection, _ takenOver: Bool) async {
        guard let projectId else { return }
        toggles = a.id
        defer { toggles = nil }
        hint = ""
        do {
            try await InstructionsAPI.takeover(client, workspaceId: workspaceId, sectionId: a.id, projectId: projectId, takenOver: takenOver)
            await load()
        } catch {
            await failure(error)
        }
    }

    private func move(_ sections: [AgentSection], from: Int, to: Int) async {
        guard sections.indices.contains(from), sections.indices.contains(to) else { return }
        var ids = sections.map(\.id)
        ids.swapAt(from, to)
        hint = ""
        do {
            // The section's level: in a project the own sections are the project's.
            try await InstructionsAPI.arrange(client, workspaceId: workspaceId, projectId: projectId, ids: ids)
            await load()
        } catch {
            await failure(error)
        }
    }

    private func erase(_ a: AgentSection) async {
        hint = ""
        do {
            try await InstructionsAPI.erase(client, workspaceId: workspaceId, sectionId: a.id, version: a.version)
            await load()
        } catch {
            await failure(error)
        }
    }
}

/// What the editor opens: an existing section or a new one on its level (`projectId` nil = workspace).
struct InstructionEditorTarget: Identifiable {
    let section: AgentSection?
    let projectId: String?
    var id: String { section?.id ?? "new-\(projectId ?? "workspace")" }
}

// ── The editor ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/// Title, scope (segments), on/off, text in fixed width with a character counter against the cap; save with `version`,
/// delete with confirmation. A 409 keeps the own version, names the conflict and offers the new state.
private struct InstructionEditor: View {
    let client: APIClient
    let workspaceId: String
    let target: InstructionEditorTarget
    let cap: InstructionsCap
    let changed: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = InstructionDraft()
    @State private var version: Int?
    @State private var serverState: AgentSection?
    @State private var busy = false
    @State private var error = ""
    @State private var deleteQuestion = false
    @State private var ready = false

    private var fresh: Bool { target.section == nil }
    private var character: Int { draft.text.utf16.count }
    private var titleEmpty: Bool { draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var tooLong: Bool { character > cap.text || draft.title.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > cap.title }

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Title")) {
                    TextField(L("e.g. Way of working"), text: $draft.title)
                        .accessibilityIdentifier("instruction-title")
                }
                Section {
                    CbSegments(
                        options: InstructionWord.scopes.map { g in
                            CbSegment(value: g, label: InstructionWord.scope(g), id: "instruction-scope-\(g)")
                        },
                        selection: $draft.scope
                    )
                    Toggle(L("On"), isOn: $draft.on)
                        .accessibilityIdentifier("instruction-on")
                } header: {
                    Text(L("Scope"))
                } footer: {
                    Text(InstructionWord.scopeSet(draft.scope))
                }
                Section {
                    TextEditor(text: $draft.text)
                        .frame(minHeight: 260)
                        .cbFont(13, design: .monospaced)
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("instruction-text")
                } header: {
                    Text(L("Text"))
                } footer: {
                    Text(verbatim: L("{n} of {max} characters", ["n": character.formatted(), "max": cap.text.formatted()]))
                        .foregroundStyle(character > cap.text ? Color.red : CbColor.textMuted)
                        .accessibilityIdentifier("instruction-counter")
                }
                if !error.isEmpty {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                        if let serverState {
                            Button(L("Load new version")) { takeOver(serverState) }
                                .accessibilityIdentifier("instruction-new-load")
                        }
                    }
                }
                if !fresh {
                    Section {
                        Button(L("Delete section"), role: .destructive) { deleteQuestion = true }
                            .disabled(busy)
                            .accessibilityIdentifier("instruction-delete")
                    }
                }
            }
            .navigationTitle(fresh ? L("New section") : L("Edit section"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(identifier: "instruction-close", label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await save() } }
                        .disabled(busy || titleEmpty || tooLong)
                        .accessibilityIdentifier("instruction-save")
                }
            }
            .confirmationDialog(L("Delete section “{title}”?", ["title": draft.title]), isPresented: $deleteQuestion, titleVisibility: .visible) {
                Button(L("Delete"), role: .destructive) { Task { await erase() } }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("No agent will receive it afterwards."))
            }
        }
        .onAppear {
            guard !ready else { return }
            ready = true
            if let a = target.section { takeOver(a) }
        }
    }

    private func takeOver(_ a: AgentSection) {
        draft = InstructionDraft(a)
        version = a.version
        serverState = nil
        error = ""
    }

    private func conflict(_ error: Error) {
        serverState = InstructionsAPI.conflictStatus(error)
        if let serverState { version = serverState.version }
        self.error = L("The section changed meanwhile. Your version is still here — Save overwrites the new state, “Load new state” discards yours.")
        changed()
    }

    private func save() async {
        busy = true
        defer { busy = false }
        error = ""
        do {
            if let a = target.section, let version {
                _ = try await InstructionsAPI.change(client, workspaceId: workspaceId, sectionId: a.id, draft: draft, version: version)
            } else {
                _ = try await InstructionsAPI.create(client, workspaceId: workspaceId, projectId: target.projectId, draft: draft)
            }
            changed()
            dismiss()
        } catch {
            if InstructionsAPI.isConflict(error) { conflict(error) } else { self.error = error.localizedDescription }
        }
    }

    private func erase() async {
        guard let a = target.section, let version else { return }
        busy = true
        defer { busy = false }
        error = ""
        do {
            try await InstructionsAPI.erase(client, workspaceId: workspaceId, sectionId: a.id, version: version)
            changed()
            dismiss()
        } catch {
            if InstructionsAPI.isConflict(error) { conflict(error) } else { self.error = error.localizedDescription }
        }
    }
}

// ── The words ───────────────────────────────────────────────────────────────────────────────────────────────────────────
enum InstructionWord {
    /// The scopes in the order of the segments, the same values as `SECTION_SCOPES` on the server.
    static let scopes = ["all", "main", "sub"]

    static func scope(_ g: String) -> String {
        switch g {
        case "main": return L("Main agent only")
        case "sub": return L("Subagents only")
        default: return L("For all")
        }
    }

    static func scopeSet(_ g: String) -> String {
        switch g {
        case "main": return L("Only the main agent of a chat receives this section.")
        case "sub": return L("Only subagents and workflow agents receive this section.")
        default: return L("The main agent, subagents and workflow agents receive this section.")
        }
    }

    static func glyph(_ g: String) -> String {
        switch g {
        case "main": return "person"
        case "sub": return "person.2"
        default: return "person.3"
        }
    }

    static func character(_ n: Int) -> String {
        n == 1 ? L("1 character") : L("{n} characters", ["n": n.formatted()])
    }
}

// ── Models and routes ───────────────────────────────────────────────────────────────────────────────────────────────────
/// A section on the wire (`publiclyVisible` in instructions-routes.js). Read tolerantly: a missing field does not make the list
/// unreadable. `takenOver` is set only on workspace sections when loaded with `projectId` (nil = not loaded).
struct AgentSection: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var text: String
    var scope: String
    var on: Bool
    var pos: Int
    var version: Int
    var updatedAt: Double
    var takenOver: Bool?

    enum CodingKeys: String, CodingKey { case id, title, text, scope, on = "enabled", pos, version, updatedAt, takenOver }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.str(.title)
        text = c.str(.text)
        scope = c.str(.scope, "all")
        on = c.bool(.on, true)
        pos = c.int(.pos)
        version = c.int(.version)
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        takenOver = c.boolOpt(.takenOver)
    }
}

/// The caps: defaults like the server's, in case the response does not carry them.
struct InstructionsCap: Decodable, Hashable, Sendable {
    var text = 20_000
    var title = 80
    var sections = 30

    init() {}

    enum CodingKeys: String, CodingKey { case text, title, sections }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = c.int(.text, 20_000)
        title = c.int(.title, 80)
        sections = c.int(.sections, 30)
    }
}

struct InstructionsStatus: Decodable, Sendable {
    var workspace: [AgentSection]
    /// nil without `projectId`; empty is not unknown.
    var project: [AgentSection]?
    var cap: InstructionsCap

    enum CodingKeys: String, CodingKey { case workspace, project, cap }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspace = c.list(.workspace, AgentSection.self)
        project = try? c.decodeIfPresent([AgentSection].self, forKey: .project)
        cap = (try? c.decodeIfPresent(InstructionsCap.self, forKey: .cap)) ?? InstructionsCap()
    }
}

private struct SectionResponse: Decodable {
    let section: AgentSection
}

/// The fields the user edits; each is mandatory on the server.
struct InstructionDraft: Equatable {
    var title = ""
    var text = ""
    var scope = "all"
    var on = true

    init() {}

    init(_ a: AgentSection, on: Bool? = nil) {
        title = a.title
        text = a.text
        scope = a.scope
        self.on = on ?? a.on
    }
}

/// `POST …/instructions`: `projectId` is ALWAYS in the body, as `null` for the workspace level; the synthesized `Encodable`
/// would omit a nil optional, and the server then answers 400 ("projectId is required").
private struct CreateBody: Encodable {
    let projectId: String?
    let title: String
    let text: String
    let scope: String
    let on: Bool

    enum CodingKeys: String, CodingKey { case projectId, title, text, scope, on = "enabled" }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let projectId { try c.encode(projectId, forKey: .projectId) } else { try c.encodeNil(forKey: .projectId) }
        try c.encode(title, forKey: .title)
        try c.encode(text, forKey: .text)
        try c.encode(scope, forKey: .scope)
        try c.encode(on, forKey: .on)
    }
}

private struct ChangeBody: Encodable {
    let title: String
    let text: String
    let scope: String
    let on: Bool
    let version: Int
    enum CodingKeys: String, CodingKey { case title, text, scope, on = "enabled", version }
}

/// `PUT …/instructions/order`: `projectId` likewise always in the body (null = workspace).
private struct ArrangeBody: Encodable {
    let projectId: String?
    let ids: [String]

    enum CodingKeys: String, CodingKey { case projectId, ids }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let projectId { try c.encode(projectId, forKey: .projectId) } else { try c.encodeNil(forKey: .projectId) }
        try c.encode(ids, forKey: .ids)
    }
}

private struct TakeoverBody: Encodable {
    let projectId: String
    let takenOver: Bool
}

enum InstructionsAPI {
    private static func path(_ workspaceId: String, _ rest: String = "") -> String {
        "/api/workspaces/\(workspaceId)/instructions\(rest)"
    }

    static func load(_ client: APIClient, workspaceId: String, projectId: String?) async throws -> InstructionsStatus {
        let q = projectId.map { [URLQueryItem(name: "projectId", value: $0)] } ?? []
        return try await client.get(path(workspaceId), query: q, timeout: 20)
    }

    static func create(_ client: APIClient, workspaceId: String, projectId: String?, draft e: InstructionDraft) async throws -> AgentSection {
        let r: SectionResponse = try await client.post(path(workspaceId), body: CreateBody(
            projectId: projectId, title: e.title, text: e.text, scope: e.scope, on: e.on
        ))
        return r.section
    }

    static func change(_ client: APIClient, workspaceId: String, sectionId: String, draft e: InstructionDraft, version: Int) async throws -> AgentSection {
        let r: SectionResponse = try await client.put(path(workspaceId, "/\(sectionId)"), body: ChangeBody(
            title: e.title, text: e.text, scope: e.scope, on: e.on, version: version
        ))
        return r.section
    }

    static func erase(_ client: APIClient, workspaceId: String, sectionId: String, version: Int) async throws {
        try await client.send(path(workspaceId, "/\(sectionId)"), method: .delete, query: [URLQueryItem(name: "version", value: String(version))])
    }

    static func arrange(_ client: APIClient, workspaceId: String, projectId: String?, ids: [String]) async throws {
        try await client.send(path(workspaceId, "/order"), method: .put, body: ArrangeBody(projectId: projectId, ids: ids))
    }

    static func takeover(_ client: APIClient, workspaceId: String, sectionId: String, projectId: String, takenOver: Bool) async throws {
        try await client.send(path(workspaceId, "/\(sectionId)/takeover"), method: .put,
                              body: TakeoverBody(projectId: projectId, takenOver: takenOver))
    }

    static func isConflict(_ error: Error) -> Bool {
        (error as? APIError)?.status == 409
    }

    /// The current state from a 409 (`{ error, section }`), nil without a readable body.
    static func conflictStatus(_ error: Error) -> AgentSection? {
        guard let f = error as? APIError, f.status == 409, let raw = f.body?["section"],
              let data = try? JSONEncoder().encode(raw) else { return nil }
        return try? JSONDecoder().decode(AgentSection.self, from: data)
    }
}
