import SwiftUI
import UIKit

// ── Dynamic workflows ─────────────────────────────────────────────────────────────────────────────────────────────
// The library of saved workflow scripts — the "Dynamic" kind of the "Workflows" category (Workflows/WorkflowKindBar.swift) —
// twin of the "Dynamic" kind on the web (WorkflowsTab.tsx). The title is the graph page's, so the header does not jump on
// switching; the bar names the kind. The library belongs to the WORKSPACE (server: dynworkflows/routes.js): list
// `GET /api/workspaces/:id/dyn-workflows`, view and delete per id; in an entered project the same list with the adoption
// state (`GET /api/projects/:id/workspace-dyn-workflows`, `enabled`) and a switch per row (`PATCH …/<name>/enabled`,
// `enabled` is required). There are no project-own entries — the agent saves them (cbase_dynamic_workflow_save).
//
// Form, in the language of the subagents page (building blocks from `Kit/CbRows.swift`) and the tile form of the projects page
// like the "Graph" kind (`Kit/CbTile.swift`): in front of each row the tile with the library's symbol (`symbol`) — calm at
// workspace level, in a project green when adopted and muted when not —, no hairlines, above the list the summary
// ("4 workflows", in a project "· 2 active"; identifier `dynwf-summary`), the origin header with a small tile, when empty a
// row with a muted tile (`dynwf-empty` on the sentence). `/name` carries the row, as the short line the phases
// ("Read → Judge"), below it the description (two lines — it says what the workflow is good for), at the end a
// subtle chevron (tapping opens the view; not next to the adoption switch in a project). "When: …" is in the sheet,
// delete in the context menu and at the end of the sheet; the explanation is behind the ⓘ. The view
// (`DynWorkflowView`) has no cards — the script's box is a code block (byte-equal, scrolling horizontally), not a card.
//
// Two rules from mistakes: (1) The name goes UNENCODED into the path — `APIClient.makeURL` sets `components.path` and
// encodes itself; an `addingPercentEncoding` before it turned a special character into `%25…` and silently hit nothing.
// (2) "Not loaded yet" is not "none saved": the empty state appears only after a SUCCESSFUL answer, an
// error shows the error.
//
// Identifiers (on button or text, never on the stack): `dynwf-info`, `dynwf-row-<name>` (the whole row button, opens the
// view), `dynwf-toggle-<name>`, `dynwf-empty`; in the view `dynwf-script`, `dynwf-copy`, `dynwf-meta-name`,
// `dynwf-meta-title`, `dynwf-meta-description`, `dynwf-meta-when`, `dynwf-meta-phase`, `dynwf-view-delete`,
// `dynwf-view-close`.

struct DynWorkflowsPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var entries: [DynWorkflowEntry] = []
    /// True only after a successful answer — before that there is no statement about "none".
    @State private var loaded = false
    @State private var error = ""
    @State private var toggling: String?
    @State private var deleting: DynWorkflowEntry?
    @State private var view: DynWorkflowEntry?
    /// Delete from the view: first close the sheet, then (in `onDismiss`) the confirmation — a view cannot show two sheets
    /// at once (the same pattern as the agents page's `byDetail`).
    @State private var afterView: DynWorkflowEntry?
    @State private var infoOpen = false

    var body: some View {
        PaneScaffold(title: L("Workflows"), trailing: AnyView(
            CbHeaderInfoButton(label: L("About dynamic workflows"), identifier: "dynwf-info") { infoOpen = true }
        )) {
            // The kind (Graph · Dynamic) fixed under the title (Workflows/WorkflowKindBar.swift).
            VStack(spacing: 0) {
                WorkflowKindBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)
                        if !loaded {
                            if error.isEmpty { CbRowSkeleton(rows: 3, tile: true) }
                        } else {
                            if projectId != nil {
                                CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
                            }
                            if entries.isEmpty {
                                CbTileEmpty(
                                    symbol: Self.symbol,
                                    text: L("No dynamic workflows saved yet."),
                                    identifier: "dynwf-empty"
                                )
                            } else {
                                CbSummary(parts: summary, identifier: "dynwf-summary")
                                // No hairlines: the tile separates the rows.
                                VStack(spacing: 2) {
                                    ForEach(entries) { entry in
                                        row(entry)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                // The kind switches the WHOLE page (own `.id` in `CategoryContent`): its content fades in on
                // appearing while the bar stays put (`CbFadeIn`; `WorkflowKindBar`).
                .cbFadeIn(at: state.workflowKind, atAppear: true)
            }
        }
        .task { await load() }
        .sheet(item: $view, onDismiss: afterTheView) { entry in
            DynWorkflowView(client: client, workspaceId: workspaceId, entry: entry) {
                afterView = entry
                view = nil
            }
            .cbSheet(.half)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleting.map { L("Delete dynamic workflow “{name}”?", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let entry = deleting { Task { await delete(entry) } }
                deleting = nil
            }
            Button(L("Cancel"), role: .cancel) { deleting = nil }
        } message: {
            Text(L("It disappears from the workspace library and from every project that adopted it."))
        }
    }

    /// The symbol of a dynamic workflow — in the row's tile, the empty state's and in the view's header.
    static let symbol = "point.3.connected.trianglepath.dotted"

    /// "4 workflows" — in a project plus how many of them are adopted (active) here.
    private var summary: [String] {
        var parts = [entries.count == 1 ? L("1 workflow") : L("{n} workflows", ["n": entries.count])]
        if projectId != nil { parts.append(L("{n} active", ["n": entries.filter { $0.enabled == true }.count])) }
        return parts
    }

    /// The explanations (behind the ⓘ).
    private var infoSheet: some View {
        CbInfoSheet(
            title: L("Dynamic workflows"),
            intro: L("Saved workflow scripts of this workspace — in a chat the model starts them by name."),
            points: [
                CbInfoDot(
                    symbol: "square.and.arrow.down",
                    word: L("Save"),
                    text: L("The agent saves them — ask it in the chat to save a workflow.")
                ),
                CbInfoDot(
                    origin: .workspace,
                    text: projectId != nil
                        ? L("The library belongs to the workspace — off by default in a project; adopt each workflow here.")
                        : L("The library belongs to the workspace — off by default in projects; adopt each workflow there.")
                ),
            ],
            footnote: L("Tap to see the description, phases and the script.")
        )
    }

    /// A row: at workspace level a button to the view with a context menu (open, delete); in a project the same
    /// row with the adoption switch (`CbToggleRow`) — tapping opens the view there too, and at its end
    /// delete stands on both levels.
    @ViewBuilder
    private func row(_ entry: DynWorkflowEntry) -> some View {
        if projectId != nil {
            CbToggleRow(
                isOn: entry.enabled == true,
                disabled: toggling == entry.name,
                toggleLabel: entry.name,
                toggleIdentifier: "dynwf-toggle-\(entry.name)",
                toggle: { Task { await toggleAdopt(entry) } },
                tap: { view = entry },
                identifier: "dynwf-row-\(entry.name)"
            ) {
                rowsContent(entry, active: entry.enabled == true)
            }
        } else {
            Button {
                view = entry
            } label: {
                rowsContent(entry, chevron: true)
            }
            .cbRowPress()
            .contextMenu {
                Button {
                    view = entry
                } label: {
                    Label(L("Open"), systemImage: "doc.text.magnifyingglass")
                }
                Button(role: .destructive) {
                    deleting = entry
                } label: {
                    Label(L("Delete"), systemImage: "trash")
                }
            }
            .accessibilityIdentifier("dynwf-row-\(entry.name)")
        }
    }

    /// The tile (calm at workspace level, in a project green when adopted and muted when not), `/name`, the phases as
    /// the short line and the description (two lines at most); the chevron only at workspace level, in a project the
    /// switch stands there.
    private func rowsContent(_ entry: DynWorkflowEntry, active: Bool = true, chevron: Bool = false) -> some View {
        CbTileRow(
            symbol: Self.symbol,
            situation: projectId == nil ? .quiet : .on,
            title: "/\(entry.name)",
            shortLine: shortLine(entry),
            text: entry.description,
            active: active,
            chevron: chevron
        )
    }

    /// The phases ("Read → Judge"); without phases no short line. An empty description (the server requires one,
    /// the model is tolerant) does NOT show as a placeholder in the row — as under "Graph" (`WorkflowsPane`); the
    /// hint is given by the sheet (`CbDetailDescription`, `empty:`).
    private func shortLine(_ entry: DynWorkflowEntry) -> Text? {
        guard !entry.phases.isEmpty else { return nil }
        return Text(verbatim: entry.phases.map(\.title).joined(separator: " → "))
    }

    private func afterTheView() {
        guard let entry = afterView else { return }
        afterView = nil
        deleting = entry
    }

    private var listPath: String {
        projectId.map { "/api/projects/\($0)/workspace-dyn-workflows" } ?? "/api/workspaces/\(workspaceId)/dyn-workflows"
    }

    private func load() async {
        do {
            entries = try await client.get(listPath)
            loaded = true
            error = ""
        } catch {
            // No "loaded": the empty state would otherwise speak about a list that never arrived.
            self.error = error.localizedDescription
        }
    }

    private func toggleAdopt(_ entry: DynWorkflowEntry) async {
        guard let projectId else { return }
        struct Body: Encodable { let enabled: Bool }
        toggling = entry.name
        defer { toggling = nil }
        do {
            // The name UNENCODED — the client encodes the path itself (see the header).
            let _: OKResponse = try await client.patch(
                "/api/projects/\(projectId)/workspace-dyn-workflows/\(entry.name)/enabled",
                body: Body(enabled: !(entry.enabled == true))
            )
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete(_ entry: DynWorkflowEntry) async {
        do {
            let _: OKResponse = try await client.delete("/api/workspaces/\(workspaceId)/dyn-workflows/\(entry.id)")
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The view of a saved workflow in the subagents page's sheet (`CbDetailSheet`): header with the name (without the
/// slash — as it stands in `meta`) and `/name` below, the description, "When to use", the phases numbered
/// and the script BYTE-EQUAL — copyable, interchangeable with Claude Code; delete in red at the end. It is loaded here (the
/// list does not carry the script).
struct DynWorkflowView: View {
    let client: APIClient
    let workspaceId: String
    let entry: DynWorkflowEntry
    /// Delete: the list closes the sheet and then asks for confirmation.
    let erase: () -> Void

    @State private var full: DynWorkflowEntry?
    @State private var error = ""
    @State private var copied = false

    var body: some View {
        let e = full ?? entry
        CbDetailSheet(
            closeIdentifier: "dynwf-view-close",
            erase: CbSheetAction(title: L("Delete"), identifier: "dynwf-view-delete", action: erase)
        ) {
            InlineError(message: error)
            CbDetailHeader(
                character: CbSign(symbol: DynWorkflowsPane.symbol, tile: true),
                title: e.name,
                titleIdentifier: "dynwf-meta-name"
            ) {
                Text(verbatim: "/\(e.name)").monospaced() + Text(verbatim: " ") + Text(L("starts it in chat"))
            }
            CbDetailDescription(text: e.description, empty: L("(no description)"))
                .accessibilityIdentifier("dynwf-meta-description")
            if let title = e.title, !title.isEmpty {
                ProjectField(L("Title"), symbol: "textformat") {
                    value(title).accessibilityIdentifier("dynwf-meta-title")
                }
            }
            if let when = e.whenToUse, !when.isEmpty {
                ProjectField(L("When to use"), symbol: "lightbulb") {
                    value(when).accessibilityIdentifier("dynwf-meta-when")
                }
            }
            if !e.phases.isEmpty {
                ProjectField(L("Phases"), symbol: "list.number", right: String(e.phases.count)) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(e.phases.enumerated()), id: \.offset) { n, phase in
                            // ONE text per phase — the identifier counts the phases (an identifier on a stack would
                            // land on every child).
                            phasesText(n, phase)
                                .cbFont(14.5)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("dynwf-meta-phase")
                        }
                    }
                }
            }
            ProjectField(L("Script"), symbol: "chevron.left.forwardslash.chevron.right") {
                if let script = full?.script {
                    VStack(alignment: .leading, spacing: 10) {
                        // Scrolling horizontally: a script line does not wrap. `CbCodeBox` shows the bytes as
                        // stored (a `String`, no Markdown, no translation).
                        CbCodeBox(text: script, horizontal: true, identifier: "dynwf-script")
                        Button {
                            UIPasteboard.general.string = script
                            copied = true
                        } label: {
                            Label(copied ? L("Copied") : L("Copy script"), systemImage: copied ? "checkmark" : "doc.on.doc")
                                .cbFont(14, weight: .medium)
                        }
                        .accessibilityIdentifier("dynwf-copy")
                    }
                } else if error.isEmpty {
                    ProgressView()
                }
            }
        }
        .task {
            do {
                full = try await client.get("/api/workspaces/\(workspaceId)/dyn-workflows/\(entry.id)")
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// A value in the field: 15 pt, selectable, like the description.
    private func value(_ text: String) -> some View {
        Text(verbatim: text)
            .cbFont(15)
            .foregroundStyle(CbColor.text)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// "1. Read — diff and tickets": number and explanation muted, the title in primary text.
    private func phasesText(_ n: Int, _ phase: DynWorkflowEntry.Phase) -> Text {
        let header = Text(verbatim: "\(n + 1).  ").foregroundStyle(CbColor.textMuted)
            + Text(verbatim: phase.title).foregroundStyle(CbColor.text)
        guard !phase.detail.isEmpty else { return header }
        return header + Text(verbatim: " — \(phase.detail)").foregroundStyle(CbColor.textSecondary)
    }
}
