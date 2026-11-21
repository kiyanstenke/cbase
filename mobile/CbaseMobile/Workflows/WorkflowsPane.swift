import SwiftUI
import UIKit

// ── Workflows ───────────────────────────────────────────────────────────────
// Workspace level: CRUD of the workspace workflows. Project level: the project's own workflows (CRUD)
// plus the workspace workflows as an adoptable list, the same pattern as skills, agents and MCP
// servers. The graph is edited in the canvas editor (full screen).

extension WorkflowNodeType {
    var tint: Color {
        switch self {
        // GitLab orange #fc6d26, the same colour as in the desktop editor (TYPE.trigger.color).
        case .trigger: return Color(red: 0.99, green: 0.43, blue: 0.15)
        case .start: return Color(red: 0.06, green: 0.72, blue: 0.51)
        case .instruction: return Color(red: 0.42, green: 0.42, blue: 1.0)
        case .condition: return Color(red: 0.96, green: 0.62, blue: 0.04)
        case .loop: return Color(red: 0.66, green: 0.33, blue: 0.97)
        case .parallel: return Color(red: 0.08, green: 0.72, blue: 0.65)
        case .ask: return Color(red: 0.05, green: 0.65, blue: 0.91)
        // Pink #ec4899, the same colour as in the desktop editor (TYPE.review.color).
        case .review: return Color(red: 0.93, green: 0.28, blue: 0.60)
        case .end: return Color.secondary
        }
    }
}

// The list uses the tile form of the projects page (`Kit/CbTile.swift`); only the list, the editor
// (`WorkflowCanvasEditor`, `WorkflowEditorPresentation`, `WorkflowSettings`) is separate:
//  – Per workflow ONE row with a leading tile (`workflowSymbol`: branch without trigger, bolt with trigger,
//    filled when armed) in the tone of its situation (armed green, otherwise quiet; not adopted dimmed),
//    no hairlines. The name, below it (only when the trigger is armed, so the workflow can start on its own)
//    "Trigger active" as dot plus word, below that dimmed the steps [· Trigger off] (`workflowShortLine`).
//  – The origin is the LEVEL of the list and appears in the section header (in a project): `GET …/workflows`
//    returns only the workspace workflows at workspace level (`project_id IS NULL`) and only the project's own in
//    a project. `originProject` appears only in a chat's effective list (`effective-workflows`, the slash picker),
//    never on this page.
//  – TEXT only where it says something: the description, at most two lines. The graph has no detail sheet and
//    the description is the only human-written sentence about WHAT the flow does. Empty shows nothing.
//  – A tap opens the editor DIRECTLY (the subtle chevron says so): the graph IS the detail. Press and hold: edit, delete.
//  – Adoption in a project is a `CbToggleRow` without tap and chevron (editing happens at workspace level).
//  – Empty shows one tile row (`CbTileEmpty`), with "Create" on the own list.
//  – The explanation sits behind the info button in the header (`infoSheet`), not as a subtitle.
// Identifiers: `workflows-info`, `workflows-new`, `workflow-name-field`, `workflow-<id>` (on the row button),
// `workflow-toggle-<id>`, `workflows-summary`.

struct WorkflowsPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState
    // For the presented editor: a UIKit fullscreen does not inherit SwiftUI's environment.
    @Environment(\.colorScheme) private var colorScheme

    @State private var own: [WorkflowSummary] = []
    @State private var adoptable: [WorkflowSummary] = []
    @State private var loading = true
    /// True only after a successful response: an error on first load shows the error, not "No workflows
    /// yet." (empty is not unknown).
    @State private var loaded = false
    /// The same for the adoption list in a project (own route, own error); a silent `try? … ?? []` would
    /// turn an error into "No workspace workflows.".
    @State private var takeoverLoaded = false
    @State private var error = ""
    @State private var toggling: String?
    @State private var deleting: WorkflowSummary?
    @State private var editing: WorkflowDetail?
    @State private var creatingName = ""
    @State private var showingCreate = false
    @State private var infoOpen = false

    private var base: String {
        projectId.map { "/api/projects/\($0)/workflows" } ?? "/api/workspaces/\(workspaceId)/workflows"
    }

    var body: some View {
        // The title is the same in a project and at workspace level (like "Subagents"); the section header names the place.
        PaneScaffold(title: L("Workflows"), trailing: AnyView(headerButtons)) {
            // The kind (Graph · Dynamic) is fixed below the title (Workflows/WorkflowKindBar.swift).
            VStack(spacing: 0) {
                WorkflowKindBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)

                        if loading && own.isEmpty && adoptable.isEmpty {
                            CbRowSkeleton(rows: 3, tile: true)
                        } else if projectId != nil {
                            // The header only with a response; after an error it would stand alone under the message.
                            if state.itemsSection == .adopt {
                                if takeoverLoaded {
                                    CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                                }
                                adoptSection
                            } else {
                                if loaded {
                                    CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
                                }
                                ownSection
                            }
                        } else {
                            ownSection
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                // The kind switches the WHOLE page (own `.id` in `CategoryContent`): its content fades in on
                // appearing while the bar stays (`CbFadeIn`; `WorkflowKindBar`).
                .cbFadeIn(at: state.workflowKind, atAppear: true)
            }
        }
        .task { await load() }
        // No `fullScreenCover`: the editor opens in landscape, which only its own controller can hold
        // (see WorkflowEditorPresentation).
        .background(
            WorkflowEditorPresentation(detail: $editing, colorScheme: colorScheme, onDismiss: { WorkflowOrientation.editorClosed() }) { detail, close in
                WorkflowCanvasEditor(client: client, base: base, workspaceId: workspaceId, projectId: projectId, detail: detail, close: close) {
                    Task { await load() }
                }
            }
            .frame(width: 0, height: 0)
        )
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .alert(L("New workflow"), isPresented: $showingCreate) {
            TextField(L("Name"), text: $creatingName)
                .accessibilityIdentifier("workflow-name-field")
            Button(L("Create")) { Task { await create() } }
            Button(L("Cancel"), role: .cancel) {}
        }
        .confirmationDialog(
            deleting.map { L("Delete workflow “{name}”?", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let flow = deleting { Task { await delete(flow) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        }
    }

    /// Info button and "New" in the header; the explanation is a sheet, not a subtitle.
    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About workflows"), identifier: "workflows-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) { newWorkflow() }
                .accessibilityIdentifier("workflows-new")
        }
    }

    /// The explanations that would otherwise be a subtitle or a sentence under the section header.
    private var infoSheet: some View {
        // The filled bolt in green: how an armed trigger appears in the row's tile
        // (`workflowSymbol`, `workflowSituation`).
        let trigger = CbInfoDot(
            symbol: "bolt.fill",
            tone: .green,
            word: L("Trigger"),
            text: L("A workflow with a trigger can start on its own; it is armed in its settings.")
        )
        let points: [CbInfoDot] = projectId != nil
            ? [
                CbInfoDot(origin: .project, text: L("Available in chats of this project and in workspace chats.")),
                CbInfoDot(origin: .workspace, text: L("Off by default in the project — enable specifically for this project here. (Edit at the workspace level.)")),
                trigger,
            ]
            : [
                // No project point: the workspace-level list shows only workspace workflows (see the file header).
                CbInfoDot(origin: .workspace, text: L("Workspace-wide workflows. Off by default in projects — adopt them there one by one.")),
                trigger,
            ]
        return CbInfoSheet(
            title: L("Workflows"),
            intro: L("A graph of steps the agent works through one by one. In a chat, /workflow:<short name> starts it."),
            points: points,
            footnote: L("Tap to open the editor. Press and hold to delete.")
        )
    }

    @ViewBuilder
    private var ownSection: some View {
        if own.isEmpty {
            if !loading && loaded {
                CbTileEmpty(
                    symbol: "arrow.triangle.branch",
                    text: projectId == nil ? L("No workflows yet.") : L("No project workflows yet."),
                    create: { newWorkflow() }
                )
            }
        } else {
            CbSummary(parts: summary(own, takeover: false), identifier: "workflows-summary")
            // No hairlines: the tile separates the rows.
            VStack(spacing: 2) {
                ForEach(own) { flow in
                    ownRow(flow)
                }
            }
        }
    }

    /// "4 workflows · 1 trigger active"; in adoption, instead of the triggers, how many are active in THIS project.
    private func summary(_ flows: [WorkflowSummary], takeover: Bool) -> [String] {
        var parts = [flows.count == 1 ? L("1 workflow") : L("{n} workflows", ["n": flows.count])]
        if takeover {
            parts.append(L("{n} active", ["n": flows.filter { $0.enabled == true }.count]))
        } else {
            let armedCount = flows.filter { workflowState($0) != nil }.count
            if armedCount > 0 { parts.append(L("{n} triggers active", ["n": armedCount])) }
        }
        return parts
    }

    /// One row per own workflow. A tap opens the editor, press and hold offers edit and delete.
    private func ownRow(_ flow: WorkflowSummary) -> some View {
        Button {
            Task { await open(flow) }
        } label: {
            row(flow, chevron: true)
        }
        .cbRowPress()
        .contextMenu {
            Button {
                Task { await open(flow) }
            } label: {
                Label(L("Edit"), systemImage: "pencil")
            }
            Button(role: .destructive) {
                deleting = flow
            } label: {
                Label(L("Delete"), systemImage: "trash")
            }
        }
        .accessibilityIdentifier("workflow-\(flow.id)")
    }

    /// The workspace workflows in a project: the same row, with the switch for THIS project on the right. The row
    /// itself is inert: editing happens at workspace level, and name and description are already shown.
    @ViewBuilder
    private var adoptSection: some View {
        if adoptable.isEmpty {
            if !loading && takeoverLoaded {
                CbTileEmpty(symbol: "arrow.triangle.branch", text: L("No workspace workflows."))
            }
        } else {
            CbSummary(parts: summary(adoptable, takeover: true), identifier: "workflows-summary")
            VStack(spacing: 2) {
                ForEach(adoptable) { flow in
                    CbToggleRow(
                        isOn: flow.enabled == true,
                        disabled: toggling == flow.name,
                        toggleLabel: flow.name,
                        toggleIdentifier: "workflow-toggle-\(flow.id)",
                        toggle: { Task { await toggleAdopt(flow) } }
                    ) {
                        row(flow, active: flow.enabled == true)
                    }
                }
            }
        }
    }

    /// One row: the tile (`workflowSymbol` in the tone of `workflowSituation`), name, "Trigger active" as dot plus word
    /// (only when armed), steps [· Trigger off], and the description because it says what the flow does. The chevron
    /// only where a tap opens the editor.
    private func row(_ flow: WorkflowSummary, active: Bool = true, chevron: Bool = false) -> some View {
        CbTileRow(
            symbol: workflowSymbol(flow),
            situation: workflowSituation(flow),
            title: flow.name,
            state: workflowState(flow),
            shortLine: Text(workflowShortLine(flow)),
            text: flow.description,
            active: active,
            chevron: chevron
        )
    }

    private func newWorkflow() {
        creatingName = ""
        showingCreate = true
    }

    /// Both lists independently: an error in one leaves the other standing, and each shows its empty state only after
    /// ITS OWN successful response; the message is the first one that failed.
    private func load() async {
        loading = true
        defer { loading = false }
        var message = ""
        do {
            own = try await client.get(base)
            loaded = true
        } catch {
            message = error.localizedDescription
        }
        if let projectId {
            do {
                adoptable = try await client.get("/api/projects/\(projectId)/workspace-workflows")
                takeoverLoaded = true
            } catch {
                if message.isEmpty { message = error.localizedDescription }
            }
        } else {
            adoptable = []
        }
        self.error = message
    }

    private func open(_ flow: WorkflowSummary) async {
        do {
            let detail: WorkflowDetail = try await client.get("\(base)/\(flow.id)")
            // A graph is wide and a phone in portrait is narrow: the editor opens in landscape, which
            // its controller handles when presenting.
            editing = detail
        } catch { self.error = error.localizedDescription }
    }

    private func create() async {
        let name = creatingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        struct Body: Encodable { let name: String }
        do {
            let created: WorkflowDetail = try await client.post(base, body: Body(name: name))
            await load()
            await state.reloadOverview()
            editing = created
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ flow: WorkflowSummary) async {
        do {
            let _: OKResponse = try await client.delete("\(base)/\(flow.id)")
            await load()
            await state.reloadOverview()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleAdopt(_ flow: WorkflowSummary) async {
        guard let projectId else { return }
        struct Body: Encodable { let enabled: Bool }
        toggling = flow.name
        defer { toggling = nil }
        do {
            // The name UNENCODED: `APIClient.makeURL` sets `components.path` and encodes itself. Pre-encoding with
            // `addingPercentEncoding` would turn "Prepare release" into `Prepare%2520…` and adoption would miss every
            // name with spaces or special characters.
            let _: OKResponse = try await client.patch(
                "/api/projects/\(projectId)/workspace-workflows/\(flow.name)/enabled",
                body: Body(enabled: !(flow.enabled == true))
            )
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// ── The row: state and short line ───────────────────────────────────────────

/// The state of a graph workflow: only an ARMED trigger (the workflow can start on its own) as dot plus
/// "Trigger active", green like its tile.
private func workflowState(_ flow: WorkflowSummary) -> CbState? {
    guard flow.triggerCount > 0, flow.active else { return nil }
    return CbState(L("Trigger active"), .green)
}

/// The symbol in the tile: the branch for a graph without trigger, the bolt for one with a trigger, filled when armed.
private func workflowSymbol(_ flow: WorkflowSummary) -> String {
    guard flow.triggerCount > 0 else { return "arrow.triangle.branch" }
    return flow.active ? "bolt.fill" : "bolt"
}

/// The tile's situation: an armed trigger is "on" (green), otherwise quiet. A workflow without a trigger is not off;
/// it waits for a manual start.
private func workflowSituation(_ flow: WorkflowSummary) -> CbSituation {
    workflowState(flow) == nil ? .quiet : .on
}

/// The ONE dimmed line under the name: steps [· Trigger off]. An armed trigger appears above it
/// (`workflowState`), a disarmed one quietly here.
private func workflowShortLine(_ flow: WorkflowSummary) -> String {
    var parts: [String] = []
    parts.append(flow.steps.label())
    if flow.triggerCount > 0, !flow.active { parts.append(L("Trigger off")) }
    return parts.joined(separator: " · ")
}
