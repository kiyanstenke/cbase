import SwiftUI

// ── The outer-loop chat info ─────────────────────────────────────────────────────────────────────────────────────────
// Reached from the coding chat through the chat settings (`Chat/ChatSheets.swift` → `ChatSettingsSheet`, section "Outer Loop" with a
// NavigationLink). The page itself has NO NavigationStack: it is pushed or embedded by the caller.
//
//  · Agents: per available agent a toggle for THIS chat (row on/off, three-valued with "no row") and the reason for the
//    state (`source`); locked where the server says `toggleable: false` (ineffective, archived, …).
//  · Create/edit/delete chat-own agents: only the human creates them, through the same editor.
//  · Notes: read-only, newest first, history unbounded ("Load more" pages through `before`).
// No stop button. Counterpart on the web: components/outerloop/OuterLoopChatSheet.tsx.
struct OuterLoopChatPage: View {
    let client: APIClient
    let chatId: String
    let workspaceId: String
    @EnvironmentObject private var state: AppState

    @State private var snapshot: OuterLoopChatState?
    @State private var notes: [OuterLoopNote] = []
    @State private var additional = false
    @State private var filter = ""
    @State private var error = ""
    @State private var toggles: String?
    @State private var inventory: OuterLoopInventory?
    @State private var editor: OuterLoopEditorTarget?
    @State private var deleteQuestion: OuterLoopChatAgent?

    var body: some View {
        CbForm {
            if let snapshot, !snapshot.targetChat {
                Section {
                    Text(snapshot.reason.isEmpty ? L("This chat is not a target of the outer loop — it observes regular coding chats.") : snapshot.reason)
                        .cbFont(13)
                        .foregroundStyle(.secondary)
                }
            }
            agentsSection
            notesSection
            if !error.isEmpty { Section { InlineError(message: error) } }
        }
        .navigationTitle(L("Outer loop"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: state.outerLoopTick) { Task { await load() } }
        .onChange(of: filter) { Task { await loadNotes() } }
        .sheet(item: $editor) { target in
            if let inventory {
                OuterLoopEditor(
                    client: client, workspaceId: workspaceId, inventory: inventory, agent: target.agent, fresh: target.fresh, projects: []
                ) { Task { await load() } }
                .cbSheet(.whole)
            }
        }
        .confirmationDialog(
            deleteQuestion.map { L("Delete outer-loop agent “{name}”?", ["name": $0.agent.name]) } ?? "",
            isPresented: Binding(get: { deleteQuestion != nil }, set: { if !$0 { deleteQuestion = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Delete"), role: .destructive) {
                if let a = deleteQuestion { Task { await erase(a) } }
                deleteQuestion = nil
            }
            Button(L("Cancel"), role: .cancel) { deleteQuestion = nil }
        } message: {
            Text(L("Its notes and runs go with it."))
        }
    }

    @ViewBuilder
    private var agentsSection: some View {
        Section {
            if let snapshot {
                if snapshot.agents.isEmpty {
                    Text(L("No outer-loop agent is available here.")).cbFont(13).foregroundStyle(.secondary)
                }
                ForEach(snapshot.agents) { a in
                    Toggle(isOn: Binding(get: { a.active }, set: { _ in Task { await toggle(a) } })) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(a.agent.name).cbFont(14)
                                if a.agent.summarizer {
                                    AgentMarker(L("Summarizer"), tone: .accent)
                                } else if a.agent.agendaKeeper {
                                    AgentMarker(L("Agenda keeper"), tone: .accent)
                                } else {
                                    AgentMarker(OuterLoopWord.origin(a.agent.origin))
                                }
                                if !a.agent.effective { AgentMarker(OuterLoopWord.ineffective(a.agent.ineffectiveReason), tone: .warn) }
                                if a.running { AgentMarker(L("running"), tone: .accent) }
                            }
                            Text(subline(a)).cbFont(12).foregroundStyle(.secondary)
                            // Red, except for an intended end (agenda keeper: abort at the turn, deferral in a busy chat); that one stays calm.
                            if let l = a.lastRun, let f = OuterLoopWord.runError(l) {
                                Text(f.text).cbFont(11.5).foregroundStyle(f.quiet ? Color.secondary : Color.red).lineLimit(2)
                            }
                        }
                    }
                    .disabled(!a.toggleable || toggles == a.id)
                    .accessibilityIdentifier("outerloop-chat-\(a.id)")
                    .contextMenu {
                        if a.agent.origin == "chat" {
                            Button { Task { await openEditor(a.agent) } } label: { Label(L("Edit"), systemImage: "pencil") }
                            Button(role: .destructive) { deleteQuestion = a } label: { Label(L("Delete"), systemImage: "trash") }
                        }
                    }
                }
                if snapshot.targetChat {
                    Button(L("+ Own agent")) { Task { await openEditor(nil) } }
                        .accessibilityIdentifier("outerloop-chat-new")
                }
            } else {
                ProgressView()
            }
        } header: {
            Text(L("Agents"))
        } footer: {
            Text(L("Background agents watching this chat. Their notes are below; only the summarizer's notes are visible to other agents."))
        }
    }

    @ViewBuilder
    private var notesSection: some View {
        Section {
            if let snapshot, snapshot.agents.count > 1 {
                Picker(L("Notes by"), selection: $filter) {
                    Text(L("All agents")).tag("")
                    ForEach(snapshot.agents) { a in Text(a.agent.name).tag(a.id) }
                }
            }
            if notes.isEmpty {
                Text(L("No note on this chat yet.")).cbFont(13).foregroundStyle(.secondary)
            }
            ForEach(notes) { n in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(n.agentName.isEmpty ? name(n.agentId) : n.agentName) · \(OuterLoopWord.time(n.at))")
                        .cbFont(12)
                        .foregroundStyle(.secondary)
                    Text(n.text)
                        .cbFont(14)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if additional {
                Button(L("Load more")) { Task { await more() } }
            }
        } header: {
            Text(L("Notes"))
        }
    }

    private func name(_ agentId: String) -> String {
        snapshot?.agents.first { $0.id == agentId }?.agent.name ?? L("(deleted agent)")
    }

    private func subline(_ a: OuterLoopChatAgent) -> String {
        var parts = [OuterLoopWord.source(a.source)]
        if a.active, let since = a.since { parts.append(L("since {time}", ["time": OuterLoopWord.time(since)])) }
        if let l = a.lastRun {
            parts.append(L("last run {time}, {state}", ["time": OuterLoopWord.time(l.startedAt), "state": OuterLoopWord.state(l.state)]))
        }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        do {
            snapshot = try await OuterLoopAPI.chat(client, chatId: chatId)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        await loadNotes()
    }

    private func loadNotes() async {
        do {
            let s = try await OuterLoopAPI.chatNotes(client, chatId: chatId, agentId: filter)
            notes = s.items
            additional = s.additional
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func more() async {
        guard let last = notes.last else { return }
        do {
            let s = try await OuterLoopAPI.chatNotes(client, chatId: chatId, agentId: filter, before: last.id)
            let present = Set(notes.map(\.id))
            notes += s.items.filter { !present.contains($0.id) }
            additional = s.additional
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggle(_ a: OuterLoopChatAgent) async {
        toggles = a.id
        defer { toggles = nil }
        do {
            try await OuterLoopAPI.chatActive(client, chatId: chatId, agentId: a.id, on: !a.active)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The editor needs the workspace's catalog, fetched only when needed; a chat-own agent comes entirely from the same
    /// inventory.
    private func openEditor(_ agent: OuterLoopAgent?) async {
        do {
            let b = try await OuterLoopAPI.inventory(client, workspaceId: workspaceId)
            inventory = b
            let full = agent.flatMap { a in b.items.first { $0.id == a.id } } ?? agent
            editor = OuterLoopEditorTarget(agent: full, fresh: agent == nil ? .chat(chatId) : nil)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func erase(_ a: OuterLoopChatAgent) async {
        do {
            try await OuterLoopAPI.erase(client, workspaceId: workspaceId, agentId: a.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
