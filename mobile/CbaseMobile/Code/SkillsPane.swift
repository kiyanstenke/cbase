import SwiftUI

// Coding → Skills: in the coding bar right after the credentials, and by the SAME principle (per project or per whole workspace).
// Every skill belongs to EXACTLY ONE area.
//
// Model is `Code/VarsPane.swift`:
//  – Workspace level: ONLY the workspace's coding skills. Each row shows read-only "Hidden in: A, B"; hiding happens only in the
//    project view, not here and not in the editor.
//  – Project level: the section of the left drawer (`ItemsSectionSidebar`, "Own · Adopt"): "Own" are the project's skills
//    (create, edit, delete), "Adopt" the workspace's coding skills with a toggle per row. Opt-out: a workspace skill applies in
//    every project until switched off there; the toggle goes by skill ID (`PATCH …/workspace-skills/:skillId/enabled`). If the
//    response does not say `enabled`, the row shows "State unknown" and the toggle is locked: a tap would switch blindly.
//  – On top the cost line (`skill-catalog`): what the catalog of exactly THIS level costs per request: on workspace level
//    workspace + all projects (what a workspace chat gets), in a project its own and the non-hidden ones. Computed by the
//    server, not here.
//  – The row in the tile form of the other coding lists (`Kit/CbTile.swift`); tapping opens the sheet (`SkillDetailSheet`:
//    description, content, where hidden), long-press offers Edit and Delete.
// The editor (`SkillEditor`) lives here and serves both areas: name, description, content, no marks, no projects; WHERE a new
// skill belongs is known by the caller (`SkillLocation`).
//
// Coding main agents write skills: per row "changed by agent · <chat> · <time>" (only `who: agent`) and "Deletion requested"; in
// the sheet the request card and the history with undo; under the own list "Recently deleted"; on workspace level the switch
// "Agents may change skills". The building blocks are in `Code/SkillHistoryView.swift`; a skill event of the workspace reloads.
struct SkillsPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var own: [SkillEntry] = []
    @State private var workspaceSkills: [SkillEntry] = []
    @State private var catalog: SkillCatalog?
    @State private var loading = true
    /// True only after a successful response: an error on the first load shows the error, not "No skills yet." with "Create"
    /// (empty is not unknown; same traits as `VarsPane`).
    @State private var loaded = false
    @State private var takeoverLoaded = false
    @State private var error = ""
    @State private var draft: SkillDraft?
    @State private var deleting: SkillEntry?
    @State private var detail: SkillDetailTarget?
    /// What should happen after the sheet closes: a view cannot show two sheets at once.
    @State private var byDetail: ByDetail?
    /// The workspace skill whose toggle is being saved.
    @State private var toggles: String?
    @State private var infoOpen = false
    /// Counts the loads: only the LATEST writes (`load`). A slow older one (say the one from appearing, when a toggle reloads
    /// right after) would otherwise overwrite the newer state with the old.
    @State private var loadGeneration = 0
    /// nil until a response carried `agentsWrite` (older server): then no switch.
    @State private var agentsWrite: Bool?
    @State private var togglesAgents = false
    /// "Recently deleted": visible only after a successful response.
    @State private var deleted: [SkillHistoryEntry] = []
    @ObservedObject private var events = SkillEvents.shared

    private enum ByDetail {
        case edit(SkillEntry)
        case erase(SkillEntry)
    }

    /// Where the OWN list belongs: in a project the project, otherwise the workspace's coding skills.
    private var ownLocation: SkillLocation { projectId.map { .project($0) } ?? .workspace(workspaceId, .coding) }
    private var ownOrigin: OriginKind { projectId == nil ? .workspace : .project }

    var body: some View {
        PaneScaffold(title: L("Skills"), trailing: AnyView(headerButtons)) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)

                    if let catalog {
                        CbSummary(parts: [skillCatalogSet(catalog)], identifier: "skills-catalog")
                    }

                    if projectId == nil, let on = agentsWrite {
                        agentsToggle(on)
                    }

                    if loading && own.isEmpty && workspaceSkills.isEmpty {
                        CbRowSkeleton(rows: 4, tile: true)
                    } else if projectId != nil && state.itemsSection == .adopt {
                        // The header only with a response: after an error it would stand alone under the message.
                        if takeoverLoaded {
                            CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                        }
                        adoptSection
                    } else {
                        if projectId != nil && loaded {
                            CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
                        }
                        ownSection
                        deletedSection
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await load() }
        }
        .task { await load() }
        .onChange(of: events.counter(workspaceId)) { Task { await load() } }
        .sheet(item: $draft) { current in
            SkillEditor(draft: current) { saved in try await save(saved) }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { target in
            SkillDetailSheet(
                target: target,
                client: client,
                workspaceId: workspaceId,
                changed: { await load() },
                edit: {
                    byDetail = .edit(target.entry)
                    detail = nil
                },
                erase: {
                    byDetail = .erase(target.entry)
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleting.map { L("Delete skill \"{name}\"?", ["name": $0.name]) } ?? "",
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

    /// ⓘ and "New" in the header: creating always happens on the OWN level (in a project a project skill).
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About skills"), identifier: "skills-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                draft = SkillDraft()
            }
            .accessibilityIdentifier("skills-new")
        }
    }

    private var infoSheet: some View {
        var points: [CbInfoDot] = []
        if projectId != nil {
            points.append(CbInfoDot(origin: .project, text: L("Only in this project's chats and in workspace chats — other projects don't see them.")))
            points.append(CbInfoDot(origin: .workspace, text: L("Available in every project by default — hide it here for this project. With the same name, the project skill wins.")))
        } else {
            points.append(CbInfoDot(origin: .workspace, text: L("Apply in workspace chats and in every project — hide them in the project under “Adopt”. With the same name, the project skill wins.")))
        }
        points.append(CbInfoDot(
            symbol: "gauge.with.dots.needle.33percent",
            word: L("Cost"),
            text: L("Every skill is a line in the catalog of every request. The server computes the number above for exactly this level.")
        ))
        return CbInfoSheet(
            title: L("Skills"),
            intro: L("Instructions the coding agents load when needed: name and purpose are in the catalog of every run, the agent fetches the content via cbase_skill."),
            points: points,
            footnote: L("Tap to see description and content. Press and hold to edit or delete.")
        )
    }

    /// The own skills (workspace level: the workspace's coding skills, in a project the project's).
    @ViewBuilder
    private var ownSection: some View {
        if own.isEmpty {
            if !loading && loaded {
                CbTileEmpty(
                    symbol: "wand.and.stars",
                    text: projectId == nil ? L("No skills yet.") : L("No project skills yet."),
                    create: { draft = SkillDraft() }
                )
            }
        } else {
            CbSummary(parts: summary(own, takeover: false), identifier: "skills-summary")
            VStack(spacing: 2) {
                ForEach(own) { skill in
                    ownRow(skill)
                }
            }
        }
    }

    /// "3 skills"; under Adopt also how many of them are SURELY active in THIS project (an unknown state does not count).
    private func summary(_ list: [SkillEntry], takeover: Bool) -> [String] {
        var parts = [list.count == 1 ? L("1 skill") : L("{n} skills", ["n": list.count])]
        if takeover { parts.append(L("{n} active", ["n": list.filter(\.inProjectOn).count])) }
        return parts
    }

    /// A row: the tile, the name in monospace (skills are small-kebab-case like their `/name`), below the description; on a
    /// workspace skill at workspace level "Hidden in: …" as state (read-only), under Adopt "State unknown" if the response did not
    /// carry `enabled`.
    private func row(
        _ skill: SkillEntry, situation: CbSituation = .quiet, active: Bool = true, chevron: Bool = false, statusUnknown: Bool = false
    ) -> some View {
        let description = skill.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let hidden = projectId == nil && !skill.hiddenIn.isEmpty
        let agentRow = skillAgentRow(skill.lastChange)
        let state: CbState?
        if statusUnknown {
            state = CbState(L("state unknown"), CbSituation.off.color)
        } else if let request = skill.openRequest, !request.id.isEmpty {
            state = CbState(L("Deletion requested"), CbSituation.waiting.color)
        } else if hidden {
            state = CbState(L("Hidden in: {names}", ["names": skill.hiddenIn.map(\.name).joined(separator: ", ")]), CbSituation.off.color)
        } else {
            state = nil
        }
        return CbTileRow(
            symbol: "wand.and.stars",
            situation: situation,
            title: skill.name,
            titleMono: true,
            state: state,
            // If an agent changed the skill last, that shows in the short line and the description moves below as a paragraph.
            shortLine: agentRow.map { Text(verbatim: $0) }
                ?? Text(verbatim: description.isEmpty ? L("(no description)") : description.replacingOccurrences(of: "\n", with: " ")),
            text: agentRow == nil ? nil : description,
            textLines: 1,
            active: active,
            chevron: chevron
        )
    }

    /// One row per own skill. Tapping opens the sheet, long-press offers Edit and Delete.
    private func ownRow(_ skill: SkillEntry) -> some View {
        Button {
            detail = SkillDetailTarget(entry: skill, location: ownLocation, origin: ownOrigin, editable: true)
        } label: {
            row(skill, chevron: true)
        }
        .cbRowPress()
        .contextMenu {
            Button {
                Task { await edit(skill) }
            } label: {
                Label(L("Edit"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = skill
            } label: {
                Label(L("Delete"), systemImage: "trash")
            }
        }
        .accessibilityIdentifier("skill-\(skill.id)")
    }

    /// The workspace's coding skills in a project: the same row, on the right the toggle for THIS project. Tapping shows the
    /// skill read-only (editing happens at workspace level).
    @ViewBuilder
    private var adoptSection: some View {
        if workspaceSkills.isEmpty {
            if !loading && takeoverLoaded {
                CbTileEmpty(symbol: "wand.and.stars", text: L("No workspace skills."))
            }
        } else {
            CbSummary(parts: summary(workspaceSkills, takeover: true), identifier: "skills-summary")
            VStack(spacing: 2) {
                ForEach(workspaceSkills) { skill in
                    CbToggleRow(
                        isOn: skill.inProjectOn,
                        // Without a known state no toggling: nobody here knows which direction a tap would have.
                        disabled: toggles == skill.id || skill.enabled == nil,
                        toggleLabel: skill.name,
                        toggleIdentifier: "skill-adopt-\(skill.id)",
                        toggle: { Task { await toggle(skill) } },
                        tap: {
                            detail = SkillDetailTarget(
                                entry: skill,
                                location: .workspace(workspaceId, .coding),
                                origin: .workspace,
                                editable: false
                            )
                        },
                        identifier: "skill-\(skill.id)"
                    ) {
                        row(
                            skill,
                            situation: skill.enabled == nil ? .quiet : .on,
                            active: skill.inProjectOn,
                            statusUnknown: skill.enabled == nil
                        )
                    }
                }
            }
        }
    }

    /// The workspace-level switch. Off ⇒ no run of this workspace gets `cbase_skill_write`.
    private func agentsToggle(_ on: Bool) -> some View {
        CbToggleRow(
            isOn: on,
            disabled: togglesAgents,
            toggleLabel: L("Agents may change skills"),
            toggleIdentifier: "skills-agents-write",
            toggle: { Task { await setAgentsWrite(!on) } }
        ) {
            CbTileRow(
                symbol: "person.badge.key",
                situation: on ? .on : .off,
                title: L("Agents may change skills"),
                text: L("Coding chats create and change skills immediately; deletions are requested and wait for your approval."),
                textLines: 3
            )
        }
        .padding(.bottom, 6)
    }

    /// "Recently deleted" under the own list, per level like the list above (as on the web): on workspace level only the
    /// workspace skills, in a project only that project's. Only after a successful response and only if there is something.
    @ViewBuilder
    private var deletedSection: some View {
        let list = deleted.filter { $0.projectId == projectId }
        if !list.isEmpty {
            CbTileHeader(symbol: "trash", title: L("Recently deleted"), right: String(list.count), margin: true)
                .padding(.top, 18)
                .accessibilityIdentifier("skills-deleted")
            VStack(spacing: 2) {
                ForEach(list) { entry in
                    SkillDeletedRow(entry: entry, client: client, showProject: projectId == nil) {
                        await load()
                    }
                }
            }
        }
    }

    private func setAgentsWrite(_ on: Bool) async {
        togglesAgents = true
        defer { togglesAgents = false }
        do {
            let fresh = try await client.setSkillSettings(workspaceId: workspaceId, agentsWrite: on)
            // The response is the state; if it does not say, the sent choice applies (the server accepted it with 200).
            agentsWrite = fresh.agentsWrite ?? on
        } catch {
            self.error = skillErrorText(error)
        }
    }

    private func afterTheDetail() {
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .edit(let skill): Task { await edit(skill) }
        case .erase(let skill): deleting = skill
        }
    }

    /// The lists and the cost line each on their own (like `VarsPane.load`): every list shows its empty state only after ITS
    /// successful response, the message is the first that went wrong. `keep` is a message from BEFORE the reload (a failed
    /// toggle): it stays, otherwise the reload would clear the error line and the toggle would jump back without reason.
    /// Writing happens only at the end and only by the latest load.
    private func load(keep upfront: String = "") async {
        loadGeneration += 1
        let generation = loadGeneration
        loading = true
        var message = upfront
        var newOwn: [SkillEntry]?
        var newTakeover: [SkillEntry]?
        let newCatalog: SkillCatalog
        do {
            newOwn = try await client.skills(ownLocation)
        } catch {
            if message.isEmpty { message = error.localizedDescription }
        }
        if let projectId {
            do {
                newTakeover = try await client.workspaceSkillsInProject(projectId)
            } catch {
                if message.isEmpty { message = error.localizedDescription }
            }
        }
        do {
            newCatalog = try await client.skillCatalog(workspaceId: workspaceId, area: .coding, projectId: projectId)
        } catch {
            if message.isEmpty { message = error.localizedDescription }
            newCatalog = .notReadable
        }
        // The newer routes: an older server does not know them (404); then toggle and list stay away without a message.
        // Every other error shows in the error line.
        var newSetting: Bool?
        var settingRead = false
        if projectId == nil {
            do {
                newSetting = try await client.skillSettings(workspaceId: workspaceId).agentsWrite
                settingRead = true
            } catch {
                if self.error.isEmpty, (error as? APIError)?.status != 404 { self.error = skillErrorText(error) }
            }
        }
        var newDeleted: [SkillHistoryEntry]?
        do {
            newDeleted = try await client.skillDeleted(workspaceId: workspaceId)
        } catch {
            if self.error.isEmpty, (error as? APIError)?.status != 404 { self.error = skillErrorText(error) }
        }
        guard generation == loadGeneration else { return }
        if settingRead { agentsWrite = newSetting }
        if let newDeleted { deleted = newDeleted }
        if let newOwn {
            own = newOwn
            loaded = true
        }
        if let newTakeover {
            workspaceSkills = newTakeover
            takeoverLoaded = true
        }
        catalog = newCatalog
        self.error = message
        loading = false
    }

    /// Fetch the whole skill (the content is not in the list) and open the editor.
    private func edit(_ skill: SkillEntry) async {
        do {
            let full = try await client.skill(ownLocation, id: skill.id)
            draft = SkillDraft(editing: full.id, name: full.name, description: full.description, body: full.body)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func save(_ saved: SkillDraft) async throws {
        if let id = saved.editing {
            try await client.changeSkill(ownLocation, id: id, description: saved.description, content: saved.body)
        } else {
            try await client.skillCreate(
                ownLocation,
                name: saved.name.trimmingCharacters(in: .whitespacesAndNewlines),
                description: saved.description,
                content: saved.body
            )
        }
        await load()
    }

    private func remove(_ skill: SkillEntry) async {
        do {
            try await client.skillDelete(ownLocation, id: skill.id)
            await load()
        } catch {
            // If an agent definition carries the skill, the server answers 409 with the referencing names; they appear in the message.
            self.error = skillErrorText(error)
        }
    }

    private func toggle(_ skill: SkillEntry) async {
        guard let projectId, let on = skill.enabled else { return }
        toggles = skill.id
        defer { toggles = nil }
        var message = ""
        do {
            try await client.setSkillInProject(projectId: projectId, skillId: skill.id, on: !on)
        } catch {
            message = error.localizedDescription
        }
        // The cost line follows: a hidden skill is no longer in this project's catalog. The message of a failed PATCH
        // survives the reload: it explains why the toggle jumps back.
        await load(keep: message)
    }
}

extension SkillEntry {
    /// In the project view: is it SURELY active here? Only an explicit `true`; if `enabled` is missing the state is
    /// unknown (row "State unknown", toggle locked), not "active": a missing field is no statement.
    var inProjectOn: Bool { enabled == true }
}

// ── The sheet on tap ────────────────────────────────────────────────────────

private struct SkillDetailTarget: Identifiable {
    let entry: SkillEntry
    /// Through whom the content is fetched: an adopted workspace skill through the workspace.
    let location: SkillLocation
    let origin: OriginKind
    /// Own skills only: a project's workspace skills are edited at workspace level.
    let editable: Bool
    var id: String { entry.id }
}

/// What the row does not show: the whole description, where the skill is hidden, and the content (fetched on open: the list
/// does not carry it). Edit in the header, Delete at the end, both only on own skills.
private struct SkillDetailSheet: View {
    let target: SkillDetailTarget
    let client: APIClient
    let workspaceId: String
    /// After undo or decision: the page's list reloads.
    let changed: () async -> Void
    let edit: () -> Void
    let erase: () -> Void

    @State private var full: SkillDetail?
    @State private var error = ""
    /// The deletion requests of this skill that the sheet shows: the open one from the list and every one that was open on load;
    /// a decided one stays (with status) instead of disappearing.
    @State private var requestIds: [String] = []
    @ObservedObject private var events = SkillEvents.shared

    private var skill: SkillEntry { target.entry }

    /// "Active" / "Hidden" / "State unknown" only on a project's workspace skills.
    private var addition: [String] {
        guard !target.editable else { return [] }
        switch skill.enabled {
        case .some(true): return [L("Active")]
        case .some(false): return [L("Hidden")]
        case .none: return [L("state unknown")]
        }
    }

    private var situation: CbSituation {
        guard !target.editable, let on = skill.enabled else { return .quiet }
        return .toggle(on)
    }

    var body: some View {
        CbDetailSheet(
            primary: target.editable ? CbSheetAction(title: L("Edit"), identifier: "skill-detail-edit", action: edit) : nil,
            closeIdentifier: "skill-detail-close",
            erase: target.editable ? CbSheetAction(title: L("Delete"), identifier: "skill-detail-delete", action: erase) : nil,
            hint: target.editable ? nil : L("Edit at workspace level.")
        ) {
            CbDetailHeader(
                character: CbSign(symbol: "wand.and.stars", tone: situation.color, tile: true),
                title: skill.name,
                titleMono: true
            ) {
                CbOriginRow(kind: target.origin, addition: addition)
            }
            if let row = skillAgentRow(skill.lastChange) {
                Text(verbatim: row)
                    .cbFont(12.5)
                    .foregroundStyle(CbColor.textMuted)
                    .accessibilityIdentifier("skill-detail-agent")
            }
            ForEach(requestIds, id: \.self) { requestId in
                SkillRequestCard(client: client, requestId: requestId, workspaceId: workspaceId, decided: changed)
            }
            CbDetailDescription(text: skill.description, empty: L("(no description)"))
            if !skill.hiddenIn.isEmpty {
                ProjectField(L("Hidden in"), symbol: "eye.slash") {
                    CbMarks(names: skill.hiddenIn.map(\.name), mono: false)
                }
            }
            ProjectField(L("Content"), symbol: "doc.text") {
                if let full {
                    CbCodeBox(text: full.body, identifier: "skill-detail-content")
                } else if !error.isEmpty {
                    InlineError(message: error)
                } else {
                    CbLoading(compact: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            SkillHistorySection(client: client, workspaceId: workspaceId, skillId: skill.id, changed: changed)
        }
        .task {
            if let open = skill.openRequest, !open.id.isEmpty, !requestIds.contains(open.id) { requestIds.append(open.id) }
            await requestsLoad()
            do {
                full = try await client.skill(target.location, id: skill.id)
            } catch {
                self.error = error.localizedDescription
            }
        }
        .onChange(of: events.counter(workspaceId)) { Task { await requestsLoad() } }
    }

    /// New open requests of this skill are added; an error (or an older server) changes nothing about the shown ones.
    private func requestsLoad() async {
        guard let open = try? await client.skillRequests(workspaceId: workspaceId) else { return }
        for request in open where request.skillId == skill.id && !requestIds.contains(request.id) {
            requestIds.append(request.id)
        }
    }
}

// ── Editor (both areas) ─────────────────────────────────────────────────────

struct SkillDraft: Identifiable {
    let id = UUID()
    /// The ID of the skill being edited; nil = new.
    var editing: String?
    var name = ""
    var description = ""
    var body = "# \n"
}

struct SkillEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: SkillDraft
    let save: (SkillDraft) async throws -> Void
    /// Delete in the editor, for a page WITHOUT a sheet on tap; nil = no section.
    var erase: (() async throws -> Void)? = nil
    @State private var busy = false
    @State private var error = ""
    @State private var deleteQuestion = false

    var body: some View {
        NavigationStack {
            CbForm {
                Section {
                    TextField(L("e.g. release-checklist"), text: $draft.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(draft.editing != nil)
                        .accessibilityIdentifier("skill-editor-name")
                } header: {
                    Text(L("Name"))
                } footer: {
                    // A name is unique per workspace, and renaming or moving is not possible; the sentence says so before the
                    // server answers with 409.
                    if draft.editing == nil {
                        Text(L("Unique in the workspace — cannot be changed later."))
                    }
                }
                Section(L("Description")) {
                    TextField(L("When should this skill apply?"), text: $draft.description, axis: .vertical)
                        .lineLimit(2...5)
                        .accessibilityIdentifier("skill-editor-description")
                }
                Section(L("Content (Markdown)")) {
                    TextEditor(text: $draft.body)
                        .frame(minHeight: 240)
                        .cbFont(13, design: .monospaced)
                        .accessibilityIdentifier("skill-editor-content")
                }
                if erase != nil && draft.editing != nil {
                    Section {
                        Button(role: .destructive) {
                            deleteQuestion = true
                        } label: {
                            Label(L("Delete skill"), systemImage: "trash")
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("skill-editor-delete")
                    }
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(draft.editing == nil ? L("New skill") : L("Edit skill"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await commit() } }
                        .disabled(busy || draft.name.trimmingCharacters(in: .whitespaces).isEmpty)
                        // By identifier, not by label: the simulator may speak English.
                        .accessibilityIdentifier("skill-editor-save")
                }
            }
            .confirmationDialog(
                L("Delete skill \"{name}\"?", ["name": draft.name]),
                isPresented: $deleteQuestion,
                titleVisibility: .visible
            ) {
                Button(L("Delete"), role: .destructive) { Task { await remove() } }
                Button(L("Cancel"), role: .cancel) {}
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

    private func remove() async {
        guard let erase else { return }
        busy = true
        error = ""
        do {
            try await erase()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
