import SwiftUI

// ── The runs of an outer-loop agent ─────────────────────────────────────────────────────────────────────────────────
// One sheet, newest first: time, chat, trigger, tokens/cost, error. "Load more" pages via `after` (id of the last run); expanded it
// shows the toolset the run REALLY had (after the fence cut) and what was dropped. Cost `nil` means subscription or no price, shown as "—".
// For the agenda keeper the sheet starts with its tally and each run shows "3 changes · 1 corrected" (the run's `upkeep`; absent for
// other agents); a run aborted by a turn in the observed chat is shown quietly as "Stopped: the chat went back to work", not as a red
// "turn" error. Web counterpart: components/outerloop/OuterLoopRuns.tsx.
struct OuterLoopRuns: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var state: AppState
    let client: APIClient
    let workspaceId: String
    let agent: OuterLoopAgent

    @State private var items: [OuterLoopRun] = []
    @State private var additional = false
    @State private var sum: OuterLoopSum?
    @State private var loaded = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            CbList {
                if let sum {
                    Section {
                        Text(L("{n} runs · {in} tokens in · {out} out · cost {cost}", [
                            "n": "\(sum.runs)", "in": OuterLoopWord.token(sum.input), "out": OuterLoopWord.token(sum.output),
                            "cost": OuterLoopWord.cost(sum.cost),
                        ]))
                        .cbFont(13)
                        .foregroundStyle(.secondary)
                        if agent.agendaKeeper, let tally = agent.upkeepTally {
                            Text(OuterLoopWord.upkeepTally(tally))
                                .cbFont(13)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("outerloop-runs-upkeep-tally")
                        }
                    }
                }
                Section {
                    if loaded && items.isEmpty {
                        Text(L("No run yet.")).cbFont(13).foregroundStyle(.secondary)
                    }
                    ForEach(items) { l in row(l) }
                    if additional {
                        Button(L("Load more")) { Task { await more() } }
                    }
                }
                if !error.isEmpty {
                    Section { InlineError(message: error) }
                }
            }
            .navigationTitle(L("Runs of {name}", ["name": agent.name]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                SheetClose(label: L("Done")) { dismiss() }
            }
            .task { await load() }
            .onChange(of: state.outerLoopTick) { Task { await load() } }
        }
    }

    private func row(_ l: OuterLoopRun) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 4) {
                if !l.model.isEmpty { field(L("Model"), "\(l.provider)::\(l.model)") }
                field(L("cbase"), l.set.cbase.isEmpty ? "—" : l.set.cbase.joined(separator: " · "))
                field(L("Built-in"), l.set.builtin.isEmpty ? "—" : l.set.builtin.joined(separator: " · "))
                if !l.set.extern.isEmpty { field(L("External"), l.set.extern.joined(separator: " · ")) }
                if !l.set.droppedFence.isEmpty { field(L("Blocked by the fence"), l.set.droppedFence.joined(separator: " · ")) }
                if !l.set.droppedApproval.isEmpty { field(L("Dropped for an approval mark"), l.set.droppedApproval.joined(separator: " · ")) }
                if !l.set.droppedLocked.isEmpty { field(L("Deselected for coding chats at the server (Coding → MCP)"), l.set.droppedLocked.joined(separator: " · ")) }
                if l.state == "parked", let until = l.parkedUntil { Text(L("Parked until {time}", ["time": OuterLoopWord.time(until)])).cbFont(12) }
                if !l.chatId.isEmpty && !l.chatTitle.isEmpty && OuterLoopWord.jumpable(l.chatKind) {
                    Button(L("Back to chat")) {
                        dismiss()
                        state.openChat(l.chatId)
                    }
                    .buttonStyle(.borderless)
                    .cbFont(13)
                }
            }
            .foregroundStyle(.secondary)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(l.chatTitle.isEmpty ? L("(deleted chat)") : l.chatTitle)
                        .cbFont(14)
                        .lineLimit(1)
                    AgentMarker(OuterLoopWord.state(l.state), tone: tone(l.state))
                }
                Text([
                    OuterLoopWord.time(l.startedAt),
                    OuterLoopWord.kindName(l.trigger),
                    L("{in} in · {out} out", ["in": OuterLoopWord.token(l.input), "out": OuterLoopWord.token(l.output)]),
                    OuterLoopWord.cost(l.cost),
                ].joined(separator: " · "))
                .cbFont(12)
                .foregroundStyle(.secondary)
                if let upkeep = l.upkeep {
                    Text(OuterLoopWord.runUpkeep(upkeep))
                        .cbFont(12)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("outerloop-run-upkeep-\(l.id)")
                }
                // Red, except for an intended end (abort at a turn, deferral in a busy chat), which is shown quietly (`OuterLoopWord.runError`).
                if let f = OuterLoopWord.runError(l) {
                    Text(f.text).cbFont(12).foregroundStyle(f.quiet ? Color.secondary : Color.red).lineLimit(3)
                }
            }
        }
    }

    private func field(_ marker: String, _ value: String) -> some View {
        (Text(marker + ": ") + Text(value).monospaced())
            .cbFont(12)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func tone(_ z: String) -> AgentMarker.Tone {
        switch z {
        case "running": return .accent
        case "finished": return .ok
        case "parked": return .warn
        case "error": return .danger
        default: return .neutral
        }
    }

    private func load() async {
        do {
            let s = try await OuterLoopAPI.runs(client, workspaceId: workspaceId, agentId: agent.id)
            items = s.items
            additional = s.additional
            sum = s.sum
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func more() async {
        guard let last = items.last else { return }
        do {
            let s = try await OuterLoopAPI.runs(client, workspaceId: workspaceId, agentId: agent.id, after: last.id)
            let present = Set(items.map(\.id))
            items += s.items.filter { !present.contains($0.id) }
            additional = s.additional
        } catch {
            self.error = error.localizedDescription
        }
    }
}
