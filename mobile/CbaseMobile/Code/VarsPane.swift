import SwiftUI
import UIKit

// Credentials & variables: secrets (masked), variables, links and FREE TEXT. Every entry has an MCP toggle: the agent may read only
// released values via cbase_vars_get.
//
// "Free text" is the block for anything that does not fit ONE value: a whole set of access details as it stands somewhere.
// Deliberately without a field schema, since only the person entering it knows which fields it has. Hidden like a secret, readable
// as a whole.
//
// The page uses the quiet tile form of the projects page (`Kit/CbTile.swift`, `Kit/CbRows.swift`):
//  – In front of each row the tile with the kind's symbol (`varSymbol`: key, free text, link, variable) in the color of the
//    situation (quiet; blocked for the agent orange; not adopted muted), no hairlines. Above the list the summary
//    ("6 entries · 1 blocked", identifier `vars-summary`), the origin header with a small tile, empty a row with a muted tile.
//  – The key in monospace, below ONE muted line (`varShortLine`) that starts with the kind ("Secret · description", "Variable ·
//    value", "Free text · 3 lines"): the description (it helps the agent choose, and you too); without it, for variable and link
//    the value itself (not secret, and exactly the information), for secret and free text only the kind word. A secret value NEVER
//    appears in the row and so never in the context menu's preview. "Blocked for agent" is a state and shows as a dot plus word
//    (orange, the exception) above it.
//  – Tapping opens the entry sheet (`VarDetailSheet`): value hidden with an eye (`var-eye-<id>`, there instead of on the row),
//    copy, the agent switch, edit and delete; the tile in the header and a small tile on the value field (`ProjectField`).
//    Long-press: copy value (without revealing; the most common move on a phone), release/block, edit, delete.
//  – A chevron at the end where tapping opens the sheet (not next to the adopt switch).
//  – The explanation (what the agent sees, project versus workspace, free text) is in the ⓘ sheet in the header (`infoSheet`).
struct VarsPane: View {
    let client: APIClient
    let basePath: String
    let isProject: Bool
    @EnvironmentObject private var state: AppState

    @State private var vars: [WorkspaceVar] = []
    @State private var workspaceVars: [WorkspaceVar] = []
    @State private var loading = true
    /// True only after a successful response: an error on the first load shows the error, not "No entries yet." with "Create"
    /// (empty is not unknown; same trait as `WorkflowsPane.loaded`).
    @State private var loaded = false
    /// The same for the workspace entries in a project (own route, own error): a swallowed error must not silently become
    /// "No workspace credentials.".
    @State private var takeoverLoaded = false
    @State private var error = ""
    @State private var draft: VarDraft?
    @State private var deleting: WorkspaceVar?
    @State private var detail: VarDetailTarget?
    /// What should happen after the entry sheet closes: close first, then (in `onDismiss`) open the editor or the question
    /// (a view cannot show two sheets at once).
    @State private var byDetail: ByDetail?
    /// The entry whose switch (release or adopt) is being saved.
    @State private var toggles: Int?
    @State private var infoOpen = false

    private enum ByDetail {
        case edit(WorkspaceVar)
        case erase(WorkspaceVar)
    }

    /// The origin of the OWN list: in a project the project entries, otherwise the workspace's.
    private var ownOrigin: OriginKind { isProject ? .project : .workspace }

    private func filtered(_ list: [WorkspaceVar]) -> [WorkspaceVar] {
        state.varsFilter == .all ? list : list.filter { $0.kind == state.varsFilter.rawValue }
    }

    private var shown: [WorkspaceVar] { filtered(vars) }

    var body: some View {
        PaneScaffold(title: L("Credentials"), trailing: AnyView(headerButtons)) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    InlineError(message: error)
                        .padding(.horizontal, 8)
                        .padding(.bottom, error.isEmpty ? 0 : 8)

                    if loading && vars.isEmpty && workspaceVars.isEmpty {
                        CbRowSkeleton(rows: 4, tile: true)
                    } else if isProject && state.itemsSection == .adopt {
                        // The header only with a response: after an error it would stand alone under the message.
                        if takeoverLoaded {
                            CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                        }
                        adoptSection
                    } else {
                        if isProject && loaded {
                            CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
                        }
                        ownSection
                    }
                }
                .padding(.horizontal, 8)
                .padding(.bottom, 24)
            }
            .cbRefreshable { await load() }
        }
        .task { await load() }
        .sheet(item: $draft) { current in
            VarEditor(draft: current) { saved in try await save(saved) }
            .cbSheet(.whole)
        }
        .sheet(item: $detail, onDismiss: afterTheDetail) { target in
            // The entry fresh from the list, not the state at opening: the switch in the sheet reloads.
            let entry = (target.editable ? vars : workspaceVars).first { $0.id == target.id } ?? target.entry
            VarDetailSheet(
                entry: entry,
                origin: target.origin,
                editable: target.editable,
                toggles: toggles == entry.id,
                mcpToggle: { Task { await toggleMcp(entry) } },
                edit: {
                    byDetail = .edit(entry)
                    detail = nil
                },
                erase: {
                    byDetail = .erase(entry)
                    detail = nil
                }
            )
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleting.map { L("Delete \"{key}\"?", ["key": $0.key]) } ?? "",
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

    /// ⓘ and "New" in the header: the explanation as a sheet instead of a subtitle.
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About credentials"), identifier: "vars-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                draft = VarDraft()
            }
            .accessibilityIdentifier("vars-new")
        }
    }

    /// The explanation: what the agent sees, project versus workspace, free text.
    private var infoSheet: some View {
        var points = [
            CbInfoDot(
                symbol: "powerplug",
                word: L("Agent"),
                text: L("Via cbase_vars_list the agent always sees WHAT exists — it only gets values via cbase_vars_get when the entry is exposed to it.")
            ),
        ]
        if isProject {
            points.append(CbInfoDot(origin: .project, text: L("Values for this project only — other projects don't see them, workspace chats do.")))
            points.append(CbInfoDot(origin: .workspace, text: L("Available everywhere by default — hide entries for this project here. On an identical key the project wins.")))
        } else {
            points.append(CbInfoDot(origin: .workspace, text: L("Workspace-wide values: available in every project, where each can be hidden. With the same key, the project wins.")))
        }
        points.append(CbInfoDot(symbol: "text.alignleft", word: L("Free text"), text: L("A whole set of access details in one piece, hidden like a secret.")))
        return CbInfoSheet(
            title: L("Credentials"),
            intro: L("Values for the agent and you: tokens, URLs, config values, whole sets of access details."),
            points: points,
            footnote: L("Tap to see the value. Press and hold to copy, edit or delete.")
        )
    }

    /// The own entries (workspace level: the workspace's, in a project the project's).
    @ViewBuilder
    private var ownSection: some View {
        if shown.isEmpty {
            if !loading && loaded {
                let withoutFilter = vars.isEmpty
                CbTileEmpty(
                    symbol: "key",
                    text: withoutFilter ? L("No entries yet.") : L("Nothing in this filter."),
                    create: withoutFilter ? { draft = VarDraft() } : nil
                )
            }
        } else {
            CbSummary(parts: summary(shown, takeover: false), identifier: "vars-summary")
            tileList(shown) { ownRow($0) }
        }
    }

    /// "6 entries · 1 blocked" (blocked for the agent, only if one is); under Adopt also how many are active in THIS project.
    /// Counts what the filter shows.
    private func summary(_ list: [WorkspaceVar], takeover: Bool) -> [String] {
        var parts = [list.count == 1 ? L("1 entry") : L("{n} entries", ["n": list.count])]
        if takeover { parts.append(L("{n} active", ["n": list.filter { $0.enabled == true }.count])) }
        let locked = list.filter { !$0.mcpAccess }.count
        if locked > 0 { parts.append(L("{n} blocked", ["n": locked])) }
        return parts
    }

    /// The rows of a section: without hairlines, the tile separates them.
    private func tileList<Row: View>(
        _ entries: [WorkspaceVar],
        @ViewBuilder row: @escaping (WorkspaceVar) -> Row
    ) -> some View {
        VStack(spacing: 2) {
            ForEach(entries) { entry in
                row(entry)
            }
        }
    }

    /// A row in tile form: the tile of the kind (`varSymbol`; blocked orange), key in monospace, "blocked for agent" as dot plus
    /// word, the short line (kind first); the chevron where tapping opens the sheet and no switch stands on the right.
    private func row(_ item: WorkspaceVar, active: Bool = true, chevron: Bool = false) -> some View {
        let short = varShortLine(item)
        return CbTileRow(
            symbol: varSymbol(item.kind),
            situation: item.mcpAccess ? .quiet : .waiting,
            title: item.key,
            titleMono: true,
            state: item.mcpAccess ? nil : CbState(L("hidden from agent"), .orange),
            shortLine: short.text,
            active: active,
            chevron: chevron
        )
        // A value truncates in the middle: the start and end of a URL stay visible.
        .truncationMode(short.middle ? .middle : .tail)
    }

    /// One row per own entry. Tapping opens the entry sheet, long-press the context menu.
    private func ownRow(_ item: WorkspaceVar) -> some View {
        Button {
            detail = VarDetailTarget(entry: item, origin: ownOrigin, editable: true)
        } label: {
            row(item, chevron: true)
        }
        .cbRowPress()
        .contextMenu {
            Button {
                UIPasteboard.general.string = item.value
            } label: {
                Label(L("Copy value"), systemImage: "doc.on.doc")
            }
            Button {
                Task { await toggleMcp(item) }
            } label: {
                Label(item.mcpAccess ? L("Hide from agent") : L("Expose to agent"), systemImage: "powerplug")
            }
            Button {
                draft = VarDraft(item: item)
            } label: {
                Label(L("Edit"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = item
            } label: {
                Label(L("Delete"), systemImage: "trash")
            }
        }
        .accessibilityIdentifier("var-\(item.id)")
    }

    /// The workspace entries in a project: the same row, on the right the switch for THIS project. Tapping shows the entry
    /// read-only (editing happens at workspace level).
    @ViewBuilder
    private var adoptSection: some View {
        let list = filtered(workspaceVars)
        if list.isEmpty {
            if !loading && takeoverLoaded {
                CbTileEmpty(
                    symbol: "key",
                    text: workspaceVars.isEmpty ? L("No workspace credentials available.") : L("Nothing in this filter.")
                )
            }
        } else {
            CbSummary(parts: summary(list, takeover: true), identifier: "vars-summary")
            tileList(list) { item in
                CbToggleRow(
                    isOn: item.enabled == true,
                    disabled: toggles == item.id,
                    toggleLabel: item.key,
                    toggleIdentifier: "var-adopt-\(item.id)",
                    toggle: { Task { await toggleAdopt(item) } },
                    tap: { detail = VarDetailTarget(entry: item, origin: .workspace, editable: false) },
                    identifier: "var-\(item.id)"
                ) {
                    row(item, active: item.enabled == true)
                }
            }
        }
    }

    private func afterTheDetail() {
        guard let step = byDetail else { return }
        byDetail = nil
        switch step {
        case .edit(let item): draft = VarDraft(item: item)
        case .erase(let item): deleting = item
        }
    }

    /// Both lists on their own (like `WorkflowsPane.load`): each shows its empty state only after ITS successful response, the
    /// message is the first that went wrong. `keep` is a message from BEFORE the reload (a failed switch): otherwise the reload
    /// would clear the error line and the switch would jump back without reason.
    private func load(keep upfront: String = "") async {
        loading = true
        defer { loading = false }
        var message = upfront
        do {
            vars = try await client.get("\(basePath)/vars")
            loaded = true
        } catch {
            message = error.localizedDescription
        }
        if isProject {
            do {
                workspaceVars = try await client.get("\(basePath)/workspace-vars")
                takeoverLoaded = true
            } catch {
                if message.isEmpty { message = error.localizedDescription }
            }
        }
        self.error = message
    }

    private func save(_ saved: VarDraft) async throws {
        struct Body: Encodable {
            let key: String
            let kind: String
            let value: String
            let description: String
            let mcpAccess: Bool
        }
        let payload = Body(
            key: saved.key.trimmingCharacters(in: .whitespaces),
            kind: saved.kind,
            value: saved.value,
            description: saved.description.trimmingCharacters(in: .whitespaces),
            mcpAccess: saved.mcpAccess
        )
        if let editing = saved.editing {
            try await client.send("\(basePath)/vars/\(editing)", method: .put, body: payload)
        } else {
            try await client.send("\(basePath)/vars", method: .post, body: payload)
        }
        await load()
        await state.reloadOverview()
    }

    private func toggleMcp(_ item: WorkspaceVar) async {
        struct Body: Encodable { let mcpAccess: Bool }
        toggles = item.id
        defer { toggles = nil }
        var message = ""
        do {
            try await client.send("\(basePath)/vars/\(item.id)", method: .put, body: Body(mcpAccess: !item.mcpAccess))
        } catch {
            message = error.localizedDescription
        }
        await load(keep: message)
    }

    private func toggleAdopt(_ item: WorkspaceVar) async {
        struct Body: Encodable { let enabled: Bool }
        toggles = item.id
        defer { toggles = nil }
        var message = ""
        do {
            try await client.send(
                "\(basePath)/workspace-vars/\(item.id)/enabled",
                method: .patch,
                body: Body(enabled: !(item.enabled == true))
            )
        } catch {
            message = error.localizedDescription
        }
        await load(keep: message)
    }

    private func remove(_ item: WorkspaceVar) async {
        do {
            let _: OKResponse = try await client.delete("\(basePath)/vars/\(item.id)")
            await load()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── The row: short line (and the symbol in the sheet header) ────────────────

/// Secret and free text are hidden: their value never appears in a row.
private func varSecret(_ kind: String) -> Bool { kind == "secret" || kind == "freeText" }

/// The symbol per kind: in the row's tile (tone from the situation) and in the header of the entry sheet; the kind also leads
/// the short line.
private func varSymbol(_ kind: String) -> String {
    switch kind {
    case "secret": return "key"
    case "freeText": return "text.alignleft"
    case "link": return "link"
    default: return "curlybraces"
    }
}

/// The kind word ("Secret" and "Link" read the same in both languages, as in the editor).
private func varKindWord(_ kind: String) -> String {
    switch kind {
    case "secret": return "Secret"
    case "freeText": return L("Free text")
    case "link": return "Link"
    default: return L("Variable")
    }
}

/// The ONE muted line under the key, kind first, and whether it should truncate in the middle (`middle`: a value).
/// "Blocked for agent" shows as a state above it (`VarsPane.row`).
private func varShortLine(_ v: WorkspaceVar) -> (text: Text, middle: Bool) {
    let description = v.description.trimmingCharacters(in: .whitespacesAndNewlines)
    let value = v.value.trimmingCharacters(in: .whitespacesAndNewlines)
    let kind = varKindWord(v.kind)
    if !description.isEmpty {
        return (Text(verbatim: kind + " · " + description.replacingOccurrences(of: "\n", with: " ")), false)
    } else if !varSecret(v.kind), !value.isEmpty {
        return (Text(verbatim: kind + " · ") + Text(verbatim: value.replacingOccurrences(of: "\n", with: " ")).monospaced(), true)
    } else if v.kind == "freeText", !value.isEmpty {
        let rows = value.components(separatedBy: "\n").count
        return (Text(verbatim: rows == 1 ? L("Free text · 1 line") : L("Free text · {n} lines", ["n": rows])), false)
    }
    return (Text(verbatim: kind), false)
}

// ── The entry sheet on tap ──────────────────────────────────────────────────

private struct VarDetailTarget: Identifiable {
    let entry: WorkspaceVar
    let origin: OriginKind
    /// Own entries only: a project's workspace entries are edited at workspace level.
    let editable: Bool
    var id: Int { entry.id }
}

/// What the row does not show: the value (hidden for secret and free text, with an eye), copy, the agent switch. Edit in the
/// header, delete at the end, both only on own entries.
private struct VarDetailSheet: View {
    let entry: WorkspaceVar
    let origin: OriginKind
    let editable: Bool
    /// The switch is being saved.
    let toggles: Bool
    let mcpToggle: () -> Void
    let edit: () -> Void
    let erase: () -> Void

    /// Revealed holds only while the sheet is open: the next time it opens the value is hidden again.
    @State private var open = false
    @State private var copied = false

    private var hidden: Bool { varSecret(entry.kind) && !open }

    /// Kind, for adopted workspace entries the state in the project, and blocked, where no switch shows it.
    private var addition: [String] {
        var parts = [varKindWord(entry.kind)]
        if !editable {
            if let on = entry.enabled { parts.append(on ? L("Active") : L("Inactive")) }
            if !entry.mcpAccess { parts.append(L("hidden from agent")) }
        }
        return parts
    }

    var body: some View {
        CbDetailSheet(
            primary: editable ? CbSheetAction(title: L("Edit"), identifier: "var-detail-edit", action: edit) : nil,
            closeIdentifier: "var-detail-close",
            erase: editable ? CbSheetAction(title: L("Delete"), identifier: "var-detail-delete", action: erase) : nil,
            hint: editable ? nil : L("Edit at workspace level.")
        ) {
            CbDetailHeader(
                character: CbSign(
                    symbol: varSymbol(entry.kind),
                    tone: (!editable && entry.enabled == false ? CbSituation.off : entry.mcpAccess ? .quiet : .waiting).color,
                    tile: true
                ),
                title: entry.key,
                titleMono: true
            ) {
                CbOriginRow(kind: origin, addition: addition)
            }
            CbDetailDescription(text: entry.description, empty: L("(no description)"))
            ProjectField(entry.kind == "freeText" ? L("Access details") : L("Value"), symbol: varSymbol(entry.kind)) {
                VStack(alignment: .leading, spacing: 10) {
                    // An access lives by its line breaks: free text scrolls horizontally, a link too; a variable wraps.
                    CbCodeBox(
                        text: hidden ? "••••••••••••" : entry.value,
                        horizontal: !hidden && (entry.kind == "freeText" || entry.kind == "link")
                    )
                    HStack(spacing: 7) {
                        if varSecret(entry.kind) {
                            PillButton(
                                title: open ? L("Hide") : L("Show"),
                                systemImage: open ? "eye.slash" : "eye"
                            ) {
                                open.toggle()
                            }
                            .accessibilityIdentifier("var-eye-\(entry.id)")
                        }
                        PillButton(
                            title: copied ? L("Copied") : L("Copy"),
                            systemImage: copied ? "checkmark" : "doc.on.doc"
                        ) {
                            copy()
                        }
                        .accessibilityIdentifier("var-copy-\(entry.id)")
                        Spacer(minLength: 0)
                    }
                }
            }
            if editable {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 12) {
                        Text(L("Share with the agent"))
                            .cbFont(15)
                            .foregroundStyle(CbColor.text)
                        Spacer(minLength: 0)
                        CbToggle(isOn: entry.mcpAccess, disabled: toggles, action: mcpToggle)
                            .accessibilityLabel(L("Share with the agent"))
                            .accessibilityIdentifier("var-mcp-\(entry.id)")
                    }
                    Text(L("(value retrievable via MCP; blocked entries are visible to it as names only)"))
                        .cbFont(12.5)
                        .foregroundStyle(CbColor.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func copy() {
        UIPasteboard.general.string = entry.value
        copied = true
        Task {
            try? await Task.sleep(for: .milliseconds(1200))
            copied = false
        }
    }
}

struct VarDraft: Identifiable {
    let id = UUID()
    var editing: Int?
    var key = ""
    var kind = "secret"
    var value = ""
    var description = ""
    var mcpAccess = true

    init() {}

    init(item: WorkspaceVar) {
        editing = item.id
        key = item.key
        kind = item.kind
        value = item.value
        description = item.description
        mcpAccess = item.mcpAccess
    }
}

private struct VarEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: VarDraft
    let save: (VarDraft) async throws -> Void
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbForm {
                Section("Key") {
                    TextField(L("e.g. GITLAB_TOKEN"), text: $draft.key)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section(L("Type")) {
                    Picker(L("Type"), selection: $draft.kind) {
                        Text("Secret").tag("secret")
                        Text(L("Variable")).tag("variable")
                        Text("Link").tag("link")
                        Text(L("Free text")).tag("freeText")
                    }
                    .pickerStyle(.segmented)
                }
                // Free text gets a LARGE field: an access is a block that is pasted and seen in one piece.
                Section {
                    TextEditor(text: $draft.value)
                        .frame(minHeight: draft.kind == "freeText" ? 220 : 80)
                        .cbFont(13, design: .monospaced)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("var-value")
                } header: {
                    Text(draft.kind == "freeText" ? L("Access details") : L("Value"))
                } footer: {
                    if draft.kind == "freeText" {
                        Text(L("(paste it as it stands — line breaks are kept)"))
                    }
                }
                Section {
                    TextField(L("e.g. PAT for gitlab.example.com"), text: $draft.description, axis: .vertical)
                        .lineLimit(1...4)
                } header: {
                    Text(L("Description"))
                } footer: {
                    Text(L("(helps the agent choose)"))
                }
                Section {
                    Toggle(L("Share with the agent"), isOn: $draft.mcpAccess)
                } footer: {
                    Text(L("(value retrievable via MCP; blocked entries are visible to it as names only)"))
                }
                if !error.isEmpty {
                    Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                }
            }
            .navigationTitle(draft.editing == nil ? L("New entry") : L("Edit entry"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Cancel")) { dismiss() }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? L("Saving…") : L("Save")) { Task { await commit() } }
                        .disabled(
                            busy
                            || draft.key.trimmingCharacters(in: .whitespaces).isEmpty
                            || draft.value.trimmingCharacters(in: .whitespaces).isEmpty
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
