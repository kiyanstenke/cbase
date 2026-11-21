import SwiftUI

// ── Coding → Agents → Outer loop ───────────────────────────────────────────────────────────────────────────────────
// The user-managed background agents that observe chats and write one note per run, in the row language of the subagents page
// (`Kit/CbRows.swift`) and in its tile form (`Kit/CbTile.swift`) so switching subagents ↔ outer loop (`AgentKindBar`) keeps the form:
// a leading tile (`outerLoopSymbol`: quote = summarizer, speech bubble = chat-owned, eye = observing) in the colour of the situation
// (`outerLoopSituation`: green effective, orange without model or provider, muted off), no hairlines, a summary ("5 agents · 3 active
// · 1 running", identifier `outerloop-summary`), section headers with a small tile (`CbTileHeader`), an empty section is one line with
// a muted tile.
//
// Workspace level: Built in (summarizer, below it the agenda keeper; no delete, "Reset to template", both hang on `fixed`) ·
// Workspace · Projects · Chats · approval marks (`Code/ApprovalMarks.swift`); the switch on a row is the agent's `on`. Inside a
// project the page follows the drawer's choice (Own · Take over, like the subagents): the project agents, or the workspace agents
// including the summarizer with the TAKEOVER switch (no row = taken over); those are edited at workspace level.
//
// Tapping opens the editor (`OuterLoopEditor`), press and hold offers Edit · Runs · To chat · Reset · Delete. Reloaded on the
// `outer_loop` event (`AppState.outerLoopTick`). Web counterpart: components/outerloop/OuterLoopPane.tsx.
struct OuterLoopPane: View {
    let client: APIClient
    let workspaceId: String
    let projectId: String?
    @EnvironmentObject private var state: AppState

    @State private var inventory: OuterLoopInventory?
    @State private var projectWs: [OuterLoopProjectAgent] = []
    @State private var loading = true
    @State private var error = ""
    @State private var editor: OuterLoopEditorTarget?
    @State private var runs: OuterLoopAgent?
    @State private var deleteQuestion: OuterLoopAgent?
    @State private var resetQuestion: OuterLoopAgent?
    @State private var toggles: String?
    @State private var infoOpen = false

    private var items: [OuterLoopAgent] { inventory?.items ?? [] }
    private var summarizer: OuterLoopAgent? { items.first { $0.summarizer } }
    private var agendaKeeper: OuterLoopAgent? { items.first { $0.agendaKeeper } }
    private var timelineAgent: OuterLoopAgent? { items.first { $0.timeline } }
    private var wsAgents: [OuterLoopAgent] { items.filter { $0.origin == "workspace" && !$0.fixed } }
    private var projectAgents: [OuterLoopAgent] { items.filter { $0.origin == "project" && (projectId == nil || $0.projectId == projectId) } }
    private var chatAgents: [OuterLoopAgent] { items.filter { $0.origin == "chat" } }

    var body: some View {
        PaneScaffold(title: L("Outer loop"), trailing: AnyView(headerButtons)) {
            VStack(spacing: 0) {
                AgentKindBar()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        InlineError(message: error)
                            .padding(.horizontal, 8)
                            .padding(.bottom, error.isEmpty ? 0 : 8)
                        if loading && inventory == nil {
                            CbRowSkeleton(tile: true)
                        } else if inventory != nil {
                            if projectId == nil { workspaceList } else { projectList }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 24)
                }
                .cbRefreshable { await load() }
                // The kind switches the WHOLE page (own `.id` in `CategoryContent`): its content fades in on appearance while the bar
                // stays (`CbFadeIn`; `AgentKindBar`).
                .cbFadeIn(at: state.agentKind, atAppear: true)
            }
        }
        .task { await load() }
        .onChange(of: state.outerLoopTick) { Task { await load() } }
        .sheet(item: $editor) { target in
            if let inventory {
                OuterLoopEditor(
                    client: client, workspaceId: workspaceId, inventory: inventory, agent: target.agent, fresh: target.fresh,
                    projects: state.activeWorkspace?.projects ?? []
                ) { Task { await load() } }
                .cbSheet(.whole)
            }
        }
        .sheet(item: $runs) { a in
            OuterLoopRuns(client: client, workspaceId: workspaceId, agent: a)
            .cbSheet(.whole)
        }
        .sheet(isPresented: $infoOpen) { infoSheet.cbSheet(.half) }
        .confirmationDialog(
            deleteQuestion.map { L("Delete outer-loop agent “{name}”?", ["name": $0.name]) } ?? "",
            isPresented: Binding(get: { deleteQuestion != nil }, set: { if !$0 { deleteQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let a = deleteQuestion { Task { await erase(a) } }
                deleteQuestion = nil
            }
            Button(L("Cancel"), role: .cancel) { deleteQuestion = nil }
        } message: {
            Text(deleteQuestion.map { $0.running > 0 ? L("It is running right now — the run is ended. Its notes and runs go with it.") : L("Its notes and runs go with it.") } ?? "")
        }
        .confirmationDialog(
            L("Reset to template?"),
            isPresented: Binding(get: { resetQuestion != nil }, set: { if !$0 { resetQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Reset")) {
                if let a = resetQuestion { Task { await reset(a) } }
                resetQuestion = nil
            }
            Button(L("Cancel"), role: .cancel) { resetQuestion = nil }
        } message: {
            Text(L("Name, task, triggers and tools come from the cbase template; provider, model, effort and “on” stay."))
        }
    }

    private var headerButtons: some View {
        HStack(spacing: 8) {
            CbHeaderInfoButton(label: L("About the outer loop"), identifier: "outerloop-info") { infoOpen = true }
            PillButton(title: L("New"), systemImage: "plus", prominent: true) {
                editor = OuterLoopEditorTarget(agent: nil, fresh: projectId.map { .project($0) } ?? .workspace)
            }
            .disabled(inventory == nil)
            .accessibilityIdentifier("outerloop-new")
        }
    }

    private var infoSheet: some View {
        CbInfoSheet(
            title: L("Outer loop"),
            intro: L("Background agents that watch chats and write a note per run. The summarizer is built in — only its notes are visible to other agents."),
            points: [
                CbInfoDot(symbol: "text.quote", word: L("Summarizer"), text: L("Summarizes every watched chat for other agents. Without a chosen model it is off.")),
                CbInfoDot(symbol: "checklist", word: L("Agenda keeper"), text: L("Keeps a watched chat's agenda up to date when the main agent forgets — new items, status only forward, never while the chat is working. Its changes are marked quietly in the agenda.")),
                CbInfoDot(origin: .workspace, text: L("Count as adopted in every project — can be switched off there one by one.")),
                CbInfoDot(origin: .project, text: L("Watch only chats of this project.")),
                CbInfoDot(symbol: "bubble.left", word: L("Chat"), text: L("Chat-owned agents — created in the chat's chat info, they go with it.")),
            ],
            footnote: L("Tap opens the editor. Press and hold for runs, reset or delete. Which chat an agent runs on, you switch in the chat settings under “Outer loop”.")
        )
    }

    // ── Workspace level ──
    /// Four sections; the summary counts them all, so it sits above the page, not above one section.
    @ViewBuilder
    private var workspaceList: some View {
        if !items.isEmpty {
            CbSummary(parts: summary(items), identifier: "outerloop-summary")
        }
        // The fixed group: the summarizer, directly below it the agenda keeper; one each per workspace, seeded by the server.
        CbTileHeader(symbol: "pin", title: L("Built in"), margin: true)
        if let z = summarizer {
            list([z])
        } else {
            CbTileEmpty(symbol: "text.quote", text: L("No summarizer yet — the server creates it on the next start."))
        }
        if let p = agendaKeeper {
            list([p])
                .padding(.top, 2)
        } else {
            CbTileEmpty(symbol: "checklist", text: L("No agenda keeper yet — the server creates it on the next start."))
        }
        if let tl = timelineAgent {
            list([tl])
                .padding(.top, 2)
        } else {
            CbTileEmpty(symbol: "clock.arrow.circlepath", text: L("No timeline agent yet — the server creates it on the next start."))
        }
        CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
            .padding(.top, 16)
        if wsAgents.isEmpty {
            CbTileEmpty(symbol: "eye", text: L("No workspace agents yet."), identifier: "outerloop-empty") {
                editor = OuterLoopEditorTarget(agent: nil, fresh: .workspace)
            }
        } else {
            list(wsAgents)
        }
        if !projectAgents.isEmpty {
            CbTileHeader(symbol: OriginKind.project.symbol, title: L("Projects"), margin: true)
                .padding(.top, 16)
            list(projectAgents)
        }
        if !chatAgents.isEmpty {
            CbTileHeader(symbol: "bubble.left", title: L("Chats"), margin: true)
                .padding(.top, 16)
            list(chatAgents)
        }
        // Marks apply per workspace (not per project), so only at workspace level (`Code/ApprovalMarks.swift`).
        if let inventory {
            ApprovalMarksRow(client: client, workspaceId: workspaceId, groups: inventory.catalog.groups) { Task { await load() } }
                .padding(.top, 16)
        }
    }

    /// "5 agents · 3 active · 1 running": active means effective (on, with provider and model); "running" only if one is running.
    private func summary(_ agents: [OuterLoopAgent]) -> [String] {
        var parts = [agents.count == 1 ? L("1 agent") : L("{n} agents", ["n": agents.count])]
        parts.append(L("{n} active", ["n": agents.filter(\.effective).count]))
        let run = agents.filter { $0.running > 0 }.count
        if run > 0 { parts.append(run == 1 ? L("1 running") : L("{n} running", ["n": run])) }
        return parts
    }

    // ── In a project: Own · Take over (drawer) ──
    @ViewBuilder
    private var projectList: some View {
        if state.itemsSection == .own {
            CbTileHeader(origin: .project, name: state.enteredProject?.name, margin: true)
            if projectAgents.isEmpty {
                CbTileEmpty(symbol: "eye", text: L("No project agents yet."), identifier: "outerloop-empty") {
                    if let projectId { editor = OuterLoopEditorTarget(agent: nil, fresh: .project(projectId)) }
                }
            } else {
                CbSummary(parts: summary(projectAgents), identifier: "outerloop-summary")
                list(projectAgents)
            }
        } else {
            CbTileHeader(origin: .workspace, name: state.activeWorkspace?.name, margin: true)
            if projectWs.isEmpty {
                if !loading { CbTileEmpty(symbol: "eye", text: L("No workspace agents.")) }
            } else {
                // Taken over means active here: the switch on the row is the takeover.
                CbSummary(
                    parts: [projectWs.count == 1 ? L("1 agent") : L("{n} agents", ["n": projectWs.count]),
                            L("{n} active", ["n": projectWs.filter(\.takenOver).count])],
                    identifier: "outerloop-summary"
                )
                VStack(spacing: 2) {
                    ForEach(projectWs) { p in
                        CbToggleRow(
                            isOn: p.takenOver,
                            disabled: toggles == p.id,
                            toggleLabel: p.agent.name,
                            toggleIdentifier: "outerloop-takeover-\(p.id)",
                            toggle: { Task { await takeover(p) } },
                            tap: { runs = p.agent }
                        ) {
                            row(p.agent, active: p.takenOver)
                        }
                    }
                }
            }
        }
    }

    /// The rows of a section with the `on` switch, without hairlines; the tile separates them.
    private func list(_ agents: [OuterLoopAgent]) -> some View {
        VStack(spacing: 2) {
            ForEach(agents) { a in
                enabledRow(a)
            }
        }
    }

    /// A row with the `on` switch; tap = edit, press and hold = the menu.
    private func enabledRow(_ a: OuterLoopAgent) -> some View {
        CbToggleRow(
            isOn: a.on,
            disabled: toggles == a.id,
            toggleLabel: a.name,
            toggleIdentifier: "outerloop-on-\(a.id)",
            toggle: { Task { await toggle(a) } },
            tap: { editor = OuterLoopEditorTarget(agent: a, fresh: nil) },
            identifier: "outerloop-\(a.id)"
        ) {
            row(a, active: a.on)
        }
        .contextMenu { menu(a) }
    }

    @ViewBuilder
    private func menu(_ a: OuterLoopAgent) -> some View {
        Button { editor = OuterLoopEditorTarget(agent: a, fresh: nil) } label: { Label(L("Edit"), systemImage: "pencil") }
        Button { runs = a } label: { Label(L("runs"), systemImage: "clock.arrow.circlepath") }
        if a.origin == "chat", let chatId = a.chatId, OuterLoopWord.jumpable(a.chatKind) {
            Button { state.openChat(chatId) } label: { Label(L("Back to chat"), systemImage: "bubble.left") }
        }
        if a.fixed {
            Button { resetQuestion = a } label: { Label(L("Reset to template"), systemImage: "arrow.uturn.backward") }
        } else {
            Button(role: .destructive) { deleteQuestion = a } label: { Label(L("Delete"), systemImage: "trash") }
        }
    }

    /// A tile-form row: the tile (`outerLoopSymbol`, colour `outerLoopSituation`), the name, "ineffective" (orange) or "running"
    /// (accent) as a dot plus word, the short line, the job as a paragraph. No chevron: a switch is always on the right.
    private func row(_ a: OuterLoopAgent, active: Bool) -> some View {
        CbTileRow(
            symbol: outerLoopSymbol(a),
            situation: outerLoopSituation(a),
            title: a.name.isEmpty ? L("(no name)") : a.name,
            state: !a.effective ? CbState(OuterLoopWord.ineffective(a.ineffectiveReason), .orange)
                : a.running > 0 ? CbState(L("running"), .accentColor) : nil,
            shortLine: Text(OuterLoopWord.shortLine(a)),
            text: a.job,
            active: active
        )
    }

    // ── Loading and acting ──
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            inventory = try await OuterLoopAPI.inventory(client, workspaceId: workspaceId)
            if let projectId { projectWs = try await OuterLoopAPI.project(client, projectId: projectId) }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ a: OuterLoopAgent) async {
        toggles = a.id
        defer { toggles = nil }
        do {
            _ = try await OuterLoopAPI.toggle(client, workspaceId: workspaceId, agentId: a.id, on: !a.on)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func takeover(_ p: OuterLoopProjectAgent) async {
        guard let projectId else { return }
        toggles = p.id
        defer { toggles = nil }
        do {
            try await OuterLoopAPI.takeover(client, projectId: projectId, agentId: p.id, takenOver: !p.takenOver)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func erase(_ a: OuterLoopAgent) async {
        do {
            try await OuterLoopAPI.erase(client, workspaceId: workspaceId, agentId: a.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func reset(_ a: OuterLoopAgent) async {
        do {
            _ = try await OuterLoopAPI.reset(client, workspaceId: workspaceId, agentId: a.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The symbol of an outer-loop agent in its tile: the quote for the summarizer (as in the ⓘ sheet), the checklist for the agenda
/// keeper, the clock for the timeline agent, the speech bubble for a chat-owned one, otherwise the eye (it observes chats).
private func outerLoopSymbol(_ a: OuterLoopAgent) -> String {
    if a.summarizer { return "text.quote" }
    if a.agendaKeeper { return "checklist" }
    if a.timeline { return "clock.arrow.circlepath" }
    return a.origin == "chat" ? "bubble.left" : "eye"
}

/// The situation of an outer-loop agent: effective green, switched off muted, on but without model or provider orange (it does not
/// run although it should: the same orange as the "does not run: …" word in the row).
private func outerLoopSituation(_ a: OuterLoopAgent) -> CbSituation {
    if a.effective { return .on }
    return a.ineffectiveReason == "off" ? .off : .waiting
}

/// What the editor opens: an existing agent, or a new one at its location.
struct OuterLoopEditorTarget: Identifiable {
    enum Fresh: Equatable {
        case workspace
        case project(String)
        case chat(String)
    }
    let agent: OuterLoopAgent?
    let fresh: Fresh?
    var id: String { agent?.id ?? "fresh" }
}

// ── The words of the outer loop: ONE place for list, editor, runs and chat info ───────────────────────────────────────
// Word-for-word with the web (`components/outerloop/outerLoopText.ts`); the German versions are in `Kit/LocDEOuterLoop.swift`.
enum OuterLoopWord {
    /// "To chat" for an outer-loop agent or run exists only for a chat of the kind "normal": for a manager conversation (in no chat
    /// list any more; `openChat` would open it in the coding area) and for a chat that is gone, the server returns `null`.
    /// Web counterpart: `chatKind === "normal"` in components/outerloop/OuterLoopPane.tsx and OuterLoopRuns.tsx.
    static func jumpable(_ chatKind: String?) -> Bool { chatKind == "normal" }

    static func ineffective(_ reason: String) -> String {
        switch reason {
        case "managing": return L("not running: managing agent")
        case "off": return L("off")
        case "without-model": return L("not running: no model")
        case "without-provider": return L("not running: no provider")
        default: return ""
        }
    }

    static func triggerShort(_ a: OuterLoopTrigger) -> String {
        switch a.kind {
        case "quiet": return L("after {n} min of quiet", ["n": "\(a.minutes)"])
        case "interval": return L("every {n} min", ["n": "\(a.minutes)"])
        case "run_end": return L("after every run end")
        case "clockTime": return a.clockTimes.isEmpty ? L("Fixed times") : L("at {times}", ["times": a.clockTimes.joined(separator: ", ")])
        default: return a.kind
        }
    }

    static func triggerRow(_ list: [OuterLoopTrigger]) -> String {
        list.isEmpty ? L("no trigger") : list.map(triggerShort).joined(separator: " · ")
    }

    /// A row's short line: trigger · tools · model (or why it does not run) · observed chat.
    static func shortLine(_ a: OuterLoopAgent) -> String {
        var parts = [triggerRow(a.trigger), L("{n} tools", ["n": "\(a.toolCount)"])]
        if !a.effective { parts.append(ineffective(a.ineffectiveReason)) } else if !a.model.isEmpty { parts.append(a.model) }
        if a.origin == "chat" { parts.append(a.chatTitle.isEmpty ? L("(deleted chat)") : a.chatTitle) }
        if a.origin == "project", !a.projectName.isEmpty { parts.append(a.projectName) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func kindName(_ kind: String) -> String {
        switch kind {
        case "quiet": return L("After quiet")
        case "interval": return L("Interval")
        case "run_end": return L("After every run end")
        case "clockTime": return L("Fixed times")
        case "afterRun": return L("Follow-up run")
        default: return kind
        }
    }

    static func state(_ z: String) -> String {
        switch z {
        case "running": return L("running")
        case "finished": return L("done")
        case "parked": return L("parked")
        case "aborted": return L("cancelled")
        case "error": return L("Error")
        default: return z
        }
    }

    static func stateColor(_ z: String) -> Color {
        switch z {
        case "running": return .accentColor
        case "finished": return .green
        case "parked": return .orange
        case "error": return .red
        default: return .secondary
        }
    }

    static func source(_ q: String) -> String {
        switch q {
        case "no-target-chat": return L("not a target chat")
        case "archived": return L("resting — the chat is archived")
        case "not-available": return L("not available here")
        case "ineffective": return L("not running")
        case "row-on": return L("switched on for this chat")
        case "row-off": return L("switched off for this chat")
        case "chat": return L("belongs to this chat")
        case "standard": return L("Default for new chats")
        case "timeline": return L("on for every chat of the project")
        case "no-default": return L("not default for this chat")
        default: return q
        }
    }

    /// The agenda keeper's tally: "12 changes · 10 standing · 2 corrected" ("standing" = open + confirmed); without changes "No
    /// change yet", without a tally (`nil`: an older server) "Track record unknown": empty is not unknown.
    /// Word-for-word with `upkeepTallyText` on the web (components/outerloop/outerLoopText.ts), bound in
    /// web/test/outerloop-set-binding.test.mjs, where both computations run with the same inputs.
    static func upkeepTally(_ b: OuterLoopUpkeepTally?) -> String {
        guard let b else { return L("Track record unknown") }
        guard b.changes > 0 else { return L("No change yet") }
        return [changes(b.changes),
                b.standing == 1 ? L("1 standing") : L("{n} standing", ["n": "\(b.standing)"]),
                L("{n} corrected", ["n": "\(b.corrected)"])].joined(separator: " · ")
    }

    /// What a keeper run changed: "3 changes · 1 corrected"; without a correction only the changes, without changes "no change".
    /// Word-for-word with `runUpkeepText` on the web (bound as above).
    static func runUpkeep(_ p: OuterLoopRunUpkeep) -> String {
        guard p.changes > 0 else { return L("no change") }
        guard p.corrected > 0 else { return changes(p.changes) }
        return [changes(p.changes), L("{n} corrected", ["n": "\(p.corrected)"])].joined(separator: " · ")
    }

    private static func changes(_ n: Int) -> String {
        n == 1 ? L("1 change") : L("{n} changes", ["n": "\(n)"])
    }

    /// The quiet text of an intended end, per code with which the server ends a run ON PURPOSE (state "aborted", `error` = the code;
    /// server: `outerloop/intended-end.js` INTENDED_END, ONE list): `turn`: a turn in the observed chat aborted the agenda keeper;
    /// `quiet`: the wakeup of a parked run arrived in a chat that was not quiet. Any other code is not an intended end (`nil`).
    /// Web counterpart: the table in components/outerloop/outerLoopText.ts; the guard reads the codes from the server (outerloop-keeper
    /// (e), run in outerloop-set-binding), so a code there without a case here is red.
    static func intendedEnd(_ code: String) -> String? {
        switch code {
        case "turn": return L("Stopped: the chat went back to work")
        case "quiet": return L("Postponed: the chat was not quiet")
        default: return nil
        }
    }

    /// What is shown as the error under a run, and whether quietly (grey instead of red). An intended end (`intendedEnd`) on an
    /// aborted run is no error (the next trigger catches up), so its own text is shown quietly. Any other text is shown verbatim and
    /// red; without text `nil`. Web counterpart: `runError` (outerLoopText.ts).
    static func runError(_ l: OuterLoopRun) -> (text: String, quiet: Bool)? {
        guard !l.error.isEmpty else { return nil }
        if l.state == "aborted", let text = intendedEnd(l.error) { return (text, true) }
        return (l.error, false)
    }

    static func origin(_ h: String) -> String {
        h == "chat" ? L("Chat") : h == "project" ? L("Project") : L("Workspace")
    }

    static func token(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }

    /// `nil` means subscription or no price: then "—", never "$0".
    static func cost(_ k: Double?) -> String {
        guard let k else { return "—" }
        return String(format: k < 0.1 ? "$%.4f" : "$%.2f", k)
    }

    static func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .numeric, time: .shortened)
    }
}
