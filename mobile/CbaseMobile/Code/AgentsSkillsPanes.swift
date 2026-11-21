import SwiftUI

// ── Subagents ───────────────────────────────────────────────────────────────
// Workspace level: CRUD of the workspace agents. Project level: the project's own agents (CRUD) plus the workspace agents
// as a switchable list. The section is chosen by the left drawer (Own · Adopt).
//
// The form is the tile form of the Projects page, no cards and no explanatory text in the list (building blocks from
// `Kit/CbTile.swift` and `Kit/CbRows.swift`: `CbListRow`, `CbSign`, `CbRowPress`, `CbToggleRow`, `CbSectionHeader`,
// `CbEmpty`, `CbRowSkeleton`, `CbHeaderInfoButton`/`CbInfoSheet`, `CbDetailSheet` …; workflows, projects, MCP, context
// and credentials speak the same language):
//  – Per row a tile with the kind's symbol (`agentSymbol`, guessed from the name) in the color of the situation (own calm,
//    adopted green on or muted off); no hairlines (`VStack(spacing: 2)`).
//  – The name carries the row, below it ONE muted line: model · tools · skills (`agentShortLine`), the model with its
//    display name from the catalog (`agentModelName`); a chevron where a tap opens the sheet (not beside the adoption switch).
//  – Description, tools, skills and system prompt are in the sheet on tap (`SubagentDetailSheet`); edit and delete there
//    and in the context menu (long press).
//  – Above the list the summary ("3 subagents · 2 active", identifier `agents-summary`), the origin header with a small
//    tile (`CbTileHeader`), empty a row with a muted tile (`CbTileEmpty`). In the sheet the tile in the head and a small
//    tile per field (`ProjectField`). The "Outer loop" kind next door looks the same.
//  – The explanations (what a subagent is, project versus workspace, this project's default) are in the ⓘ sheet in the
//    header (`infoSheet`) instead of subtitles and sentences under every section header.
//
// NEW projects adopt the workspace agents (server: store/toolchain.js wsAgentsInProject); an existing project stays
// opt-in. The sentence about it follows THIS project's default (`wsAgentsDefault`) and is in the ⓘ sheet.
struct AgentsPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var workspaceAgents: [AgentDefinition] = []
    @State private var projectAgents: [AgentDefinition] = []
    @State private var loading = true
    // `nil` = not loaded yet; then no sentence about the workspace agents is shown (empty is not unknown).
    @State private var standard: String?
    @State private var error = ""
    @State private var draft: AgentDraft?
    @State private var toggling: String?
    @State private var deleting: AgentDefinition?
    @State private var detail: SubagentDetailTarget?
    /// What should happen after the detail sheet closes: a view cannot show two sheets at once, so close first, then (in
    /// `onDismiss`) open the editor or the confirmation.
    @State private var byDetail: ByDetail?
    @State private var infoOpen = false
    /// The model catalog (`/api/providers`), only for the display names in the short line. Empty while it is not loaded
    /// (or did not arrive): then the model appears without the provider in front (`agentModelName`).
    @State private var provider: [Provider] = []

    private enum ByDetail {
        case edit(AgentDefinition)
        case erase(AgentDefinition)
    }

    private var wsBase: String { "/api/workspaces/\(workspaceId)/agents" }
    private var projBase: String? { projectId.map { "/api/projects/\($0)/agents" } }
    /// The origin of the OWN list: in a project the project agents, otherwise the workspace's.
    private var ownOrigin: OriginKind { projectId == nil ? .workspace : .project }

    var body: some View {
        PaneScaffold(title: L("Subagents"), trailing: AnyView(headerButtons)) {
            // The kind (Subagents · Outer loop · Instructions) fixed under the title (Code/AgentKindBar.swift).
            VStack(spacing: 0) {
                AgentKindBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)

                        if loading && workspaceAgents.isEmpty && projectAgents.isEmpty {
                            CbRowSkeleton(tile: true)
                        } else if projectId != nil {
                            if state.itemsSection == .own {
                                CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
                                ownSection
                            } else {
                                CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                                adoptSection
                            }
                        } else {
                            ownSection
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                // The kind switches the WHOLE page (own `.id` in `CategoryContent`): its content fades in on appearing,
                // the bar stays (`CbFadeIn`; `AgentKindBar`).
                .cbFadeIn(at: state.agentKind, atAppear: true)
            }
        }
        .task { await load() }
        .task {
            let r: ProvidersResponse? = try? await client.get("/api/providers", timeout: 20)
            provider = r?.providers ?? []
        }
        .sheet(item: $draft) { current in
            AgentEditor(draft: current, provider: provider.filter(\.connected)) { saved in
                try await save(saved)
            }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { target in
            SubagentDetailSheet(
                target: target,
                edit: {
                    byDetail = .edit(target.agent)
                    detail = nil
                },
                erase: {
                    byDetail = .erase(target.agent)
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleting.map { L("Delete subagent “{name}”?", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let agent = deleting { Task { await delete(agent) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    /// ⓘ and "New" in the header: the explanation as a sheet instead of a subtitle.
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About subagents"), identifier: "agents-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                draft = AgentDraft(scope: projectId == nil ? .workspace : .project)
            }
            .accessibilityIdentifier("agents-new")
        }
    }

    /// The sentence about a project's workspace agents: it says what is true for THIS project (in the ⓘ sheet).
    private var wsHint: String? {
        switch standard {
        case "on": return L("New projects adopt them automatically — switch them off for this project here. Edit them at workspace level.")
        case nil: return nil
        default: return L("Off by default in the project — enable specifically for this project here. (Edit at the workspace level.)")
        }
    }

    /// The explanations, as a sheet behind the ⓘ in the header. In a project the workspace item names THIS project's default
    /// as soon as it is loaded.
    private var infoSheet: some View {
        let wsSet = L("Workspace-wide subagents. Active automatically in new projects — switch them off there one by one.")
        let points: [CbInfoDot] = projectId != nil
            ? [
                CbInfoDot(origin: .project, text: L("Only in this project's chats and in workspace chats — other projects don't see them.")),
                CbInfoDot(origin: .workspace, text: wsHint ?? wsSet),
            ]
            : [CbInfoDot(origin: .workspace, text: wsSet)]
        return CbInfoSheet(
            title: L("Subagents"),
            intro: L("Agent types the agent in a chat starts as subagents."),
            points: points,
            footnote: L("Tap to see description, tools and skills. Press and hold to edit or delete.")
        )
    }

    @ViewBuilder
    private var ownSection: some View {
        let agents = projectId == nil ? workspaceAgents : projectAgents
        if agents.isEmpty {
            if !loading {
                CbTileEmpty(symbol: "sparkle", text: projectId == nil ? L("No subagents yet.") : L("No project subagents yet.")) {
                    draft = AgentDraft(scope: projectId == nil ? .workspace : .project)
                }
            }
        } else {
            CbSummary(parts: summary(agents, takeover: false), identifier: "agents-summary")
            // No hairlines: the tile separates the rows.
            VStack(spacing: 2) {
                ForEach(agents) { agent in
                    ownRow(agent)
                }
            }
        }
    }

    /// "3 subagents"; in the adoption section also how many of them are active in THIS project.
    private func summary(_ agents: [AgentDefinition], takeover: Bool) -> [String] {
        var parts = [agents.count == 1 ? L("1 subagent") : L("{n} subagents", ["n": agents.count])]
        if takeover { parts.append(L("{n} active", ["n": agents.filter { $0.enabled == true }.count])) }
        return parts
    }

    /// One row: the tile with the kind's symbol (guessed from the name, `agentSymbol`) in the color of the situation (own
    /// calm, adopted green on or muted off), the name, below it model · tools · skills; the chevron where a tap opens the
    /// sheet and no switch is on the right.
    private func row(_ agent: AgentDefinition, situation: CbSituation = .quiet, active: Bool = true, chevron: Bool = false) -> some View {
        CbTileRow(
            symbol: agentSymbol(agent),
            situation: situation,
            title: agent.name,
            shortLine: Text(agentShortLine(agent, provider)),
            active: active,
            chevron: chevron
        )
    }

    /// One row per own agent. Tap opens the detail, long press Edit and Delete.
    private func ownRow(_ agent: AgentDefinition) -> some View {
        Button {
            detail = SubagentDetailTarget(agent: agent, origin: ownOrigin, editable: true)
        } label: {
            row(agent, chevron: true)
        }
        .cbRowPress()
        .contextMenu {
            Button {
                Task { await edit(agent) }
            } label: {
                Label(L("Edit"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = agent
            } label: {
                Label(L("Delete"), systemImage: "trash")
            }
        }
        .accessibilityIdentifier("agent-\(agent.id)")
    }

    /// The workspace agents in a project: the same row, on the right the switch for THIS project (`CbToggleRow`: the switch
    /// lies over the row, the pressed highlight takes the whole width).
    @ViewBuilder
    private var adoptSection: some View {
        if workspaceAgents.isEmpty {
            if !loading { CbTileEmpty(symbol: "sparkle", text: L("No workspace subagents.")) }
        } else {
            CbSummary(parts: summary(workspaceAgents, takeover: true), identifier: "agents-summary")
            VStack(spacing: 2) {
                ForEach(workspaceAgents) { agent in
                    CbToggleRow(
                        isOn: agent.enabled == true,
                        disabled: toggling == agent.id,
                        toggleLabel: agent.name,
                        toggleIdentifier: "agent-toggle-\(agent.id)",
                        toggle: { Task { await toggleAdopt(agent) } },
                        tap: { detail = SubagentDetailTarget(agent: agent, origin: .workspace, editable: false) }
                    ) {
                        row(agent, situation: .on, active: agent.enabled == true)
                    }
                }
            }
        }
    }

    private func afterTheDetail() {
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .edit(let agent): Task { await edit(agent) }
        case .erase(let agent): deleting = agent
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            if let projectId {
                let response: ProjectAgentsResponse = try await client.get("/api/projects/\(projectId)/agents")
                projectAgents = response.projectAgents
                workspaceAgents = response.workspaceAgents
                // An older server does not send the field; there the old sentence applies (opt-in).
                standard = response.wsAgentsDefault == "on" ? "on" : "off"
            } else {
                workspaceAgents = try await client.get(wsBase)
                projectAgents = []
                standard = nil
            }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func edit(_ agent: AgentDefinition) async {
        let scope: AgentDraft.Scope = projectId == nil ? .workspace : .project
        let base = scope == .project ? (projBase ?? wsBase) : wsBase
        if let full: AgentDefinition = try? await client.get("\(base)/\(agent.id)") {
            draft = AgentDraft(
                editing: full.id,
                scope: scope,
                name: full.name,
                description: full.description,
                tools: full.tools,
                model: full.model,
                body: full.body,
                skills: full.skills
            )
        }
    }

    private func save(_ saved: AgentDraft) async throws {
        struct Body: Encodable {
            let name: String
            let description: String
            let tools: String
            let model: String
            let body: String
            let skills: String
        }
        let base = saved.scope == .project ? (projBase ?? wsBase) : wsBase
        let payload = Body(
            name: saved.name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: saved.description,
            tools: saved.tools,
            model: saved.model,
            body: saved.body,
            skills: saved.skills
        )
        if let editing = saved.editing {
            let _: AgentDefinition = try await client.put("\(base)/\(editing)", body: payload)
        } else {
            let _: AgentDefinition = try await client.post(base, body: payload)
        }
        await load()
        await state.reloadOverview()
    }

    private func delete(_ agent: AgentDefinition) async {
        let base = projectId == nil ? wsBase : (projBase ?? wsBase)
        do {
            let _: OKResponse = try await client.delete("\(base)/\(agent.id)")
            await load()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleAdopt(_ agent: AgentDefinition) async {
        guard let projectId else { return }
        struct Body: Encodable { let enabled: Bool }
        toggling = agent.id
        defer { toggling = nil }
        do {
            try await client.send(
                "/api/projects/\(projectId)/agents/\(agent.id)/enabled",
                method: .patch,
                body: Body(enabled: !(agent.enabled == true))
            )
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── The row: short line (and the symbol in the sheet's head) ───────────────

/// The parts of a comma list (`tools`, `skills`), without empty ones.
private func agentList(_ comma: String) -> [String] {
    comma.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

/// An agent's tools: `nil` = not set (it inherits all), otherwise the list; `[]` means NONE. The JSON list takes precedence;
/// an older server sends only the comma list, and there empty always meant "all".
private func agentTools(_ a: AgentDefinition) -> [String]? {
    let comma = agentList(a.tools)
    if !comma.isEmpty { return comma }
    if let list = a.toolList { return list }
    return nil
}

/// The display name of a model "provider::model": the name from the catalog, as the model picker and the workflow settings
/// show it ("Opus 5.5", "GPT-5.6 Sol"); without a catalog hit the model without the provider in front (it is part of the
/// model name: "claude-opus-5-5"). The detail sheet keeps the full identifier.
private func agentModelName(_ raw: String, _ provider: [Provider]) -> String {
    var providerId: String?
    var model = raw
    if let separator = raw.range(of: "::") {
        providerId = String(raw[..<separator.lowerBound])
        model = String(raw[separator.upperBound...])
    }
    let candidates = providerId.map { id in provider.filter { $0.id == id } } ?? provider
    let hits = candidates.lazy.compactMap { p in p.models.first { $0.id == model } }.first
    return hits?.label ?? model
}

/// The ONE muted line under the name: model · tools · skills.
private func agentShortLine(_ a: AgentDefinition, _ provider: [Provider]) -> String {
    var parts: [String] = []
    let model = a.model.trimmingCharacters(in: .whitespaces)
    if !model.isEmpty { parts.append(agentModelName(model, provider)) }
    switch agentTools(a) {
    case nil: parts.append(L("all tools"))
    case let list? where list.isEmpty: parts.append(L("no tools"))
    case let list?: parts.append(list.count == 1 ? L("1 tool") : L("{n} tools", ["n": list.count]))
    }
    let skills = agentList(a.skills)
    if !skills.isEmpty { parts.append(skills.count == 1 ? L("1 skill") : L("{n} skills", ["n": skills.count])) }
    // The coding MCP servers the type brings along: only displayed; edited on the web. A save here does not send the field,
    // so the server leaves it alone.
    if a.mcpServer > 0 { parts.append(a.mcpServer == 1 ? L("1 MCP server") : L("{n} MCP servers", ["n": a.mcpServer])) }
    return parts.joined(separator: " · ")
}

/// The symbol of a subagent, guessed from its NAME, in the row's tile and in the sheet's head; pure display, nothing
/// depends on it. Compared per word, the table's order decides ("code-reviewer" is a review). Two kinds of keys:
///  – `whole`: abbreviations that count only as a WHOLE word ("pr", "doc", "ui", "app", "cli" …); as a word beginning they
///    would swallow other words: "pr" caught "prompt", "product", "programmer", "doc" caught "docker", "app" caught
///    "approval", "cli" caught "client";
///  – `beginnings`: stems that count at the word beginning ("review" → "reviewer", "deploy" → "deployment").
///
/// Expectations:
///   "code-reviewer" → checkmark.seal · "docker-ops" → shippingbox · "pr-helper" → arrow.triangle.branch ·
///   "programmer" → Code · "prompt-writer" → doc.text · "docs-writer" → doc.text · "ui-designer" → paintbrush.pointed ·
///   "build-agent" → shippingbox · "client-sync" → sparkle · "approval-bot" → sparkle · "devops" → shippingbox ·
///   "ios-dev" → iphone · "explorer" → magnifyingglass · "git-committer" → arrow.triangle.branch.
private func agentSymbol(_ a: AgentDefinition) -> String {
    let words = a.name.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    // German terms here match German user input on purpose (the UI is bilingual) - an intended exception to the English-only rule.
    let table: [(symbol: String, whole: Set<String>, beginnings: [String])] = [
        ("lock.shield", ["auth", "authz", "authn"], ["secur", "safe", "authent", "authori", "pentest"]),
        ("checkmark.seal", [], ["review", "prüf", "check", "audit", "lint", "verif"]),
        ("testtube.2", ["qa", "e2e"], ["test"]),
        ("ladybug", ["fix", "fixer", "fixes"], ["debug", "bug", "error"]),
        ("magnifyingglass", [], ["search", "search", "explor", "research", "recherch", "find", "analy"]),
        ("list.bullet.clipboard", ["spec", "specs"], ["plan", "architect", "architect", "specif", "concept"]),
        ("shippingbox", ["ops"], ["deploy", "release", "build", "ship", "docker", "infra", "devops"]),
        ("doc.text", ["doc", "docs"], ["document", "document", "write", "write", "text", "readme", "changelog"]),
        ("paintbrush.pointed", ["ui", "ux", "css"], ["design", "style", "frontend"]),
        ("cylinder.split.1x2", ["db"], ["data", "data", "sql", "migrat", "schema"]),
        ("arrow.triangle.branch", ["pr", "prs"], ["git", "merge", "branch", "commit"]),
        ("gauge.with.dots.needle.67percent", ["perf"], ["perform", "optim", "bench", "speed"]),
        ("globe", ["api", "apis"], ["web", "browser", "http", "scrap"]),
        ("terminal", ["cli"], ["shell", "bash", "script"]),
        ("iphone", ["ios", "app", "apps"], ["mobile", "swift", "android"]),
        ("chevron.left.forwardslash.chevron.right", ["dev", "devs"], ["code", "coder", "develop", "impl", "refactor", "program", "backend"]),
    ]
    for entry in table where words.contains(where: { w in
        entry.whole.contains(w) || entry.beginnings.contains { w.hasPrefix($0) }
    }) {
        return entry.symbol
    }
    return "sparkle"
}

// ── The detail on tap ───────────────────────────────────────────────────────

private struct SubagentDetailTarget: Identifiable {
    let agent: AgentDefinition
    let origin: OriginKind
    /// Only own agents; a project's workspace agents are edited on the workspace level.
    let editable: Bool
    var id: String { agent.id }
}

/// What is missing in the row: description, model, tools, skills and the system prompt. Edit in the head, delete at the
/// end, both only for own agents. The head as a tile and a small tile per field (`ProjectField`).
private struct SubagentDetailSheet: View {
    let target: SubagentDetailTarget
    let edit: () -> Void
    let erase: () -> Void

    private var agent: AgentDefinition { target.agent }

    /// The tile's situation in the head, as in the row: own calm, adopted on or off.
    private var situation: CbSituation {
        guard let on = agent.enabled, !target.editable else { return .quiet }
        return .toggle(on)
    }

    /// "· Active" / "· Inactive" only on a project's adopted workspace agents.
    private var state: [String] {
        guard let on = agent.enabled, !target.editable else { return [] }
        return [on ? L("Active") : L("Inactive")]
    }

    var body: some View {
        CbDetailSheet(
            primary: target.editable ? CbSheetAction(title: L("Edit"), identifier: "agent-detail-edit", action: edit) : nil,
            closeIdentifier: "agent-detail-close",
            erase: target.editable ? CbSheetAction(title: L("Delete"), identifier: "agent-detail-delete", action: erase) : nil,
            hint: target.editable ? nil : L("Edit at workspace level.")
        ) {
            CbDetailHeader(character: CbSign(symbol: agentSymbol(agent), tone: situation.color, tile: true), title: agent.name) {
                CbOriginRow(kind: target.origin, addition: state)
            }
            CbDetailDescription(text: agent.description, empty: L("(no description)"))
            ProjectField(L("Model"), symbol: "cpu") {
                let model = agent.model.trimmingCharacters(in: .whitespaces)
                Text(model.isEmpty ? L("as the chat") : model)
                    .cbFont(14, design: model.isEmpty ? nil : .monospaced)
                    .foregroundStyle(model.isEmpty ? CbColor.textMuted : CbColor.text)
            }
            ProjectField(L("Tools"), symbol: "wrench.and.screwdriver") {
                switch agentTools(agent) {
                case nil: silent(L("all tools"))
                case let list? where list.isEmpty: silent(L("no tools"))
                case let list?: CbMarks(names: list)
                }
            }
            let skills = agentList(agent.skills)
            if !skills.isEmpty {
                ProjectField(L("Skills"), symbol: "wand.and.stars") { CbMarks(names: skills) }
            }
            let prompt = agent.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if !prompt.isEmpty {
                ProjectField(L("System prompt"), symbol: "text.alignleft") { CbCodeBox(text: prompt) }
            }
        }
    }

    private func silent(_ text: String) -> some View {
        Text(text)
            .cbFont(14)
            .foregroundStyle(CbColor.textMuted)
    }
}

struct AgentDraft: Identifiable {
    enum Scope { case workspace, project }
    let id = UUID()
    var editing: String?
    var scope: Scope
    var name = ""
    var description = ""
    var tools = ""
    var model = ""
    var body = "You are a specialized subagent.\n\n"
    /// Comma list of skill names, loaded completely into the system prompt at the start.
    var skills = ""
}

private struct AgentEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: AgentDraft
    /// The connected providers, for the choice from the catalog (with OpenRouter, hundreds of models).
    var provider: [Provider] = []
    let save: (AgentDraft) async throws -> Void
    @State private var busy = false
    @State private var error = ""
    @State private var catalogOpen = false

    var body: some View {
        NavigationStack {
            CbForm {
                Section(L("Name")) {
                    TextField(L("e.g. code-reviewer"), text: $draft.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(draft.editing != nil)
                }
                Section(L("Description")) {
                    TextField(L("What is this subagent responsible for?"), text: $draft.description, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    TextField("Read, Grep, Bash", text: $draft.tools)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text(L("Tools (comma-separated, empty = all)"))
                } footer: {
                    // The list means the same for every provider as in Claude Code, except the built-ins of Codex (the same
                    // sentence as in the web form, `AgentDialog.tsx`).
                    Text(L("When set, ONLY what is listed applies: built-in tools and cbase tools (cbase_projects_list, all: mcp__cbase). MCP servers are not listed here — they are chosen on the web at the agent type under “MCP servers”; saving here keeps them. Codex keeps its built-in tools (shell, patch, web search) — there the list only applies to cbase tools."))
                }
                Section(L("Model (optional)")) {
                    TextField(L("e.g. sonnet"), text: $draft.model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    // Free typing stays possible (abbreviations like "sonnet"); plus the choice from the catalog, the same searchable choice as
                    // everywhere (Kit/ModelSelection.swift), value "provider::model" as in the web form.
                    if !provider.isEmpty {
                        Button(L("Choose from the catalog")) { catalogOpen = true }
                            .accessibilityIdentifier("agent-editor-model-catalog")
                    }
                }
                // Skills as a comma list, like the tools: the web's checkbox list would need the place's catalog here;
                // the name suffices, it is checked at the start (an unknown name is an instructive error there, not a silent
                // omission).
                Section {
                    TextField("api-conventions, error-handling-rules", text: $draft.skills)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("agent-editor-skills")
                } header: {
                    Text(L("Skills (comma-separated)"))
                } footer: {
                    Text(L("Loaded in full into the subagent's system prompt at start — it no longer needs to fetch them."))
                }
                Section(L("System prompt")) {
                    TextEditor(text: $draft.body)
                        .frame(minHeight: 200)
                        .cbFont(13, design: .monospaced)
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .sheet(isPresented: $catalogOpen) {
                ModelSelectionSheet(title: L("Model"), groups: provider.map { ModelGroup($0) }, selection: draft.model,
                                   value: { g, m in "\(g.id)::\(m.id)" }) { fresh in draft.model = fresh }
                .cbSheet(.whole)
            }
            .navigationTitle(draft.editing == nil ? L("New subagent") : L("Edit subagent"))
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

// The skill management lives as a coding category in `Code/SkillsPane.swift` (with its editor).
