import SwiftUI

// Coding → Scheduled: the scheduled jobs of the workspace or the entered project. Each job is a coding chat that receives a
// message at set times (server `scheduled/`, routes `GET/POST /api/workspaces/:ws/scheduled`). The category sits right after
// "Chats" (`WorkspaceCategory.scheduled`, like `scheduled` in `web/src/lib/coding-tabs.ts`). Web counterpart: `components/scheduled/`.
//
// Tile form like the other coding pages (`Kit/CbTile.swift`): under the title the segments Upcoming, Paused, Done (`CbSegments`),
// below one row per job with name, cadence in plain words and the next occurrence; the tile takes the color of the situation
// (green running, orange queued or parked, red after an error, muted paused). "Upcoming" sorts by the next moment
// (`nextEventAt`; a repeat precedes the occurrence). Tapping opens the sheet `ScheduledDetail`, "New" the dialog `JobDialog`
// (both in `Code/ScheduledDetail.swift`). Reloads on the `scheduled` event (`AppState.scheduledTick`), no polling.
//
// "Not yet loaded" is not "no jobs": the empty state appears only after a SUCCESSFUL response.
//
// Identifiers (on button or text, never on the stack): `scheduled-new`, `scheduled-seg-<upcoming|paused|done>` (the segments),
// `scheduled-row-<id>` (the row button), `scheduled-empty`, `scheduled-summary`.
struct ScheduledPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    enum Page: String, CaseIterable, Hashable {
        case upcoming, paused, done

        var status: String { self == .upcoming ? "active" : rawValue }
        var displayLabel: String {
            switch self {
            case .upcoming: return "Upcoming"
            case .paused: return "Paused"
            case .done: return "Done"
            }
        }
    }

    @State private var jobs: [ScheduledJob] = []
    @State private var loaded = false
    @State private var error = ""
    @State private var page: Page = .upcoming
    @State private var detail: ScheduledJob?
    @State private var newOpen = false
    /// "Go to chat" from the sheet: close first, then open (in `onDismiss`), otherwise the chat would sit under the sheet.
    @State private var byDetailChat: String?

    static let symbol = "clock"

    private var visible: [ScheduledJob] {
        let list = jobs.filter { $0.status == page.status }
        guard page == .upcoming else { return list.sorted { $0.updatedAt > $1.updatedAt } }
        // Without an occurrence (0) at the end, otherwise the nearest moment first.
        return list.sorted { a, b in
            let x = a.nextEventAt > 0 ? a.nextEventAt : .greatestFiniteMagnitude
            let y = b.nextEventAt > 0 ? b.nextEventAt : .greatestFiniteMagnitude
            return x < y
        }
    }

    var body: some View {
        PaneScaffold(title: L("Scheduled"), trailing: AnyView(
            PillButton(title: L("New"), systemImage: "plus", prominent: true) { newOpen = true }
                .accessibilityIdentifier("scheduled-new")
        )) {
            VStack(spacing: 0) {
                CbSegments(
                    options: Page.allCases.map { CbSegment(value: $0, label: L($0.displayLabel), id: "scheduled-seg-\($0.rawValue)") },
                    selection: $page
                )
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)
                        if !loaded {
                            if error.isEmpty { CbRowSkeleton(rows: 3, tile: true) }
                        } else if visible.isEmpty {
                            CbTileEmpty(
                                symbol: Self.symbol,
                                text: emptyText,
                                identifier: "scheduled-empty",
                                button: page == .upcoming ? L("New task") : nil,
                                buttonIdentifier: "scheduled-empty-new",
                                create: page == .upcoming ? { newOpen = true } : nil
                            )
                        } else {
                            CbSummary(parts: summary, identifier: "scheduled-summary")
                            VStack(spacing: 2) {
                                ForEach(visible) { row($0) }
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                .cbFadeIn(at: page)
            }
        }
        .task { await load() }
        .onChange(of: state.scheduledTick) { Task { await load() } }
        .sheet(item: $detail, onDismiss: afterTheDetail) { a in
            ScheduledDetail(client: client, workspaceId: workspaceId, job: a, changed: { fresh in replace(fresh) }, deleted: {
                jobs.removeAll { $0.id == a.id }
                detail = nil
            }, toChat: { chatId in
                byDetailChat = chatId
                detail = nil
            })
            .cbSheet(.whole)
        }
        .sheet(isPresented: $newOpen) {
            JobDialog(client: client, workspaceId: workspaceId, projectId: projectId, job: nil) { fresh in
                replace(fresh)
                page = .upcoming
                // The new chat shows up in the chat list at once (also without a message), with its clock.
                Task { await state.chatList?.load() }
            }
            .cbSheet(.whole)
        }
    }

    private var emptyText: String {
        switch page {
        case .upcoming: return L("No scheduled tasks yet. A task sends its chat a message at set times.")
        case .paused: return L("No task is paused.")
        case .done: return L("No one-time task completed yet.")
        }
    }

    private var summary: [String] {
        let n = visible.count
        var parts = [n == 1 ? L("1 task") : L("{n} tasks", ["n": n])]
        let run = visible.filter { $0.state == "running" }.count
        if run > 0 { parts.append(L("{n} running##one", ["n": run])) }
        return parts
    }

    private func row(_ a: ScheduledJob) -> some View {
        Button {
            detail = a
        } label: {
            CbTileRow(
                symbol: Self.symbol,
                situation: situation(a),
                title: a.name.isEmpty ? L("Scheduled task") : a.name,
                state: ScheduledWord.state(a.state).map { CbState($0, situation(a).color) },
                shortLine: Text(verbatim: shortLine(a)),
                active: a.status != "paused",
                chevron: true
            )
        }
        .cbRowPress()
        .accessibilityIdentifier("scheduled-row-\(a.id)")
    }

    /// "Weekdays at 08:00 · next: tomorrow 08:00": done has no occurrence, paused shows the word.
    private func shortLine(_ a: ScheduledJob) -> String {
        switch a.status {
        case "active": return "\(a.cadenceText) · \(L("next: {when}", ["when": ScheduledWord.occurrence(a.nextEventAt)]))"
        default: return a.cadenceText
        }
    }

    private func situation(_ a: ScheduledJob) -> CbSituation {
        if a.status == "paused" { return .off }
        switch a.state {
        case "running": return .on
        case "queued", "parked": return .waiting
        default: return a.lastStatus == "error" ? .error : .quiet
        }
    }

    private func replace(_ fresh: ScheduledJob) {
        // The open sheet keeps its own state (`ScheduledDetail.job`); `detail` stays, otherwise SwiftUI would rebuild it.
        if let i = jobs.firstIndex(where: { $0.id == fresh.id }) { jobs[i] = fresh } else { jobs.append(fresh) }
    }

    private func afterTheDetail() {
        guard let chatId = byDetailChat else { return }
        byDetailChat = nil
        state.openChat(chatId)
    }

    private func load() async {
        do {
            let list = try await client.scheduledJobs(workspaceId: workspaceId, projectId: projectId)
            jobs = list.items
            loaded = true
            error = ""
        } catch {
            // No "loaded": the empty state would otherwise speak about a list that never arrived.
            self.error = error.localizedDescription
        }
    }
}
