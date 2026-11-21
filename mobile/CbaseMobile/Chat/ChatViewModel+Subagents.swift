import Foundation

extension ChatViewModel {

    // ── Subagents: pace, merging, stop ──────────────────────────────────────────────
    //
    // The place for subagents is the sheet behind the header button. It shows
    // RUNNING ones (event stream) and FINISHED ones (from the history of THIS chat) — no new
    // server state, no new table: the numbers of a finished subagent already stand in
    // its report (`totalTokens`, `totalDurationMs`, `totalToolUseCount`).

    /// Window of the pace smoothing. 60 s: short enough that a pace change arrives, long enough
    /// that a single jump does not determine it.
    private static let tempoWindow: TimeInterval = 60
    /// Without this minimum gap between two sample points the rate is noise.
    private static let tempoMinimumGap: TimeInterval = 5
    /// And above this gap it is no longer a pace but an average over a phase
    /// in which nothing was reported — then the display stays empty instead.
    private static let tempoMaxGap: TimeInterval = 300
    /// Cap of the trace per agent — it grows with every report, the window alone does not
    /// tame it if the server reports densely.
    private static let tempoPointsCap = 120

    /// Pace (tokens/minute) from two sample points over the sliding window. A value only
    /// becomes a sample point if it has CHANGED: two equal readings say nothing about the
    /// pace, and strung together they would push it toward zero.
    func measureTempo(_ agents: [SubagentLive]) { // internal, for extensions
        let now = Date()
        let limit = now.addingTimeInterval(-Self.tempoWindow)
        var lane: [String: [(time: Date, tokens: Int)]] = [:]
        var tempo: [String: Int] = [:]
        for agent in agents where !agent.id.isEmpty {
            var points = tempoLane[agent.id] ?? []
            if points.last?.tokens != agent.tokens { points.append((now, agent.tokens)) }
            var keep = points.filter { $0.time >= limit }
            // ONE anchor before the window stays, otherwise the pace would fall to empty as soon as
            // the second-to-last sample point has rolled out of the window.
            if keep.count < 2, let anchor = points.last(where: { $0.time < limit }) {
                keep.insert(anchor, at: 0)
            }
            keep = Array(keep.suffix(Self.tempoPointsCap))
            lane[agent.id] = keep
            guard let first = keep.first, let last = keep.last else { continue }
            let duration = last.time.timeIntervalSince(first.time)
            guard duration >= Self.tempoMinimumGap, duration <= Self.tempoMaxGap,
                  last.tokens > first.tokens else { continue }
            tempo[agent.id] = Int((Double(last.tokens - first.tokens) / duration * 60).rounded())
        }
        tempoLane = lane   // finished agents drop out with their trace
        agentTempo = tempo
    }

    /// All subagent calls of the history — top level, because their children ARE the steps —,
    /// each with the answer whether its turn is still running. "Running" is the SAME question the marker in the
    /// history asks with `live` (`item.streaming || item.id == liveId` in the stage): the newest
    /// reply as long as `busy` holds — per `HistoryState.runningResponseId`, the rule with two
    /// readers (here and `ChatTimelineStage.liveItemId`).
    private var agentBlocks: [(block: ChatBlock, turnRunning: Bool)] {
        let running = runningResponseId
        return timeline.flatMap { item -> [(block: ChatBlock, turnRunning: Bool)] in
            guard item.role == .assistant else { return [] }
            let turnRunning = item.streaming || item.id == running
            return item.blocks.filter { $0.kind == .tool && $0.isAgentCall }.map { ($0, turnRunning) }
        }
    }

    /// The running reply as the stage determines it: the same rows (only what draws,
    /// `rendersContent`), newest first, through `HistoryState.runningResponseId`. The rule
    /// ends at the first user or reply row — no more is handed to it in the first place.
    var runningResponseId: String? {
        guard busy else { return nil }
        var rows: [(role: String, id: String)] = []
        for item in timeline.reversed() where item.rendersContent {
            rows.append((role: item.role.rawValue, id: item.id))
            if item.role == .user || item.role == .assistant { break }
        }
        return HistoryState.runningResponseId(newestFirst: rows, busy: busy)
    }

    /// Merging stream ↔ history: per running agent its block (or none), plus the
    /// blocks that no running one claims. The ONE mapping for sheet and marker.
    ///
    /// First via ids (report, tool_use id, block id), only then via the task: otherwise a
    /// task match would pull in the block that another agent owns by id.
    private var assignment: (live: [(SubagentLive, ChatBlock?, Bool)], open: [(block: ChatBlock, turnRunning: Bool)]) {
        var open = agentBlocks
        var assigned: [Int: (block: ChatBlock, turnRunning: Bool)] = [:]   // index in waitAgentsLive -> block
        for (index, live) in waitAgentsLive.enumerated() {
            guard let hits = open.firstIndex(where: { Self.matchesPerId($0.block, live) }) else { continue }
            assigned[index] = open.remove(at: hits)
        }
        for (index, live) in waitAgentsLive.enumerated() where assigned[index] == nil {
            guard let hits = open.firstIndex(where: { Self.matchesPerJob($0.block, live) }) else { continue }
            assigned[index] = open.remove(at: hits)
        }
        let live = waitAgentsLive.enumerated().map { index, agent in
            (agent, assigned[index]?.block, assigned[index]?.turnRunning ?? false)
        }
        return (live, open)
    }

    /// The subagents of this chat: running ones first, then the finished ones in history order.
    ///
    /// Merged via the call id — an agent that is reported live AND stands as a
    /// block in the history appears EXACTLY ONCE; the live numbers win, report and
    /// steps come from the block. Without this check the duplication would arise that the move
    /// has just removed.
    var subagents: [SubagentEntry] {
        let z = assignment
        return z.live.map { entry(live: $0.0, block: $0.1, turnRunning: $0.2) }
            + z.open.map { entry(block: $0.block, turnRunning: $0.turnRunning) }
    }

    /// The arrival order of the "Background Tasks" list in the agents sheet: per reply its
    /// subagent calls (the same as `agentBlocks`: top level), per divider row the START markers of a dynamic
    /// workflow. A finished subagent knows no start time — it stands after this spot (Chat/BackgroundTasks.swift).
    /// Web twin: `taskSequence` in the hook web/src/components/chat/chatBackground.ts.
    var taskSequence: [String] {
        BackgroundTasks.followUp(timeline.map { item in
            BackgroundTasks.SequenceRow(
                agents: item.role == .assistant ? item.blocks.filter { $0.kind == .tool && $0.isAgentCall }.map(\.id) : [],
                workflowStart: item.role == .divider && item.marker?.phase == "start" ? item.marker?.runId : nil
            )
        })
    }

    /// The card for the marker in the history (environment `chatAgentStates`, set per cell in
    /// `ChatTimelineStage.rowView`): block id → identifier or "finished". The same mapping and
    /// the SAME computation as `subagents` (`state(…)`) — just without report, numbers and steps,
    /// since the stage asks at every token.
    var agentStates: [String: String] {
        let z = assignment
        var card: [String: String] = [:]
        for (agent, block, turnRunning) in z.live {
            guard let block else { continue }
            card[block.id] = Self.identifier(state(live: agent, block: block, turnRunning: turnRunning))
        }
        for (block, turnRunning) in z.open {
            card[block.id] = Self.identifier(state(live: nil, block: block, turnRunning: turnRunning))
        }
        return card
    }

    private static func identifier(_ state: HistoryState.Agent?) -> String { state?.identifier ?? "finished" }

    /// THE state of a subagent (chain in `HistoryState.agent`). If it is in the stream, the server
    /// reports it as alive (`inStream: true`); otherwise there is a list and it is not in it
    /// (`inStream: false`) — `nil` ("no list") never occurs here, that is the fallback of the
    /// marker outside the stage.
    private func state(live: SubagentLive?, block: ChatBlock?, turnRunning: Bool) -> HistoryState.Agent? {
        HistoryState.agent(
            error: block?.resultIsError ?? false,
            rawStatus: block.map { rawStatus($0) } ?? "",
            done: block?.done ?? false,
            inStream: live != nil,
            turnRunning: turnRunning
        )
    }

    /// `status` from the report of a call — remembered per block with the length of the result
    /// (`reportStatusRemembered`): if the result changes, its length practically always changes.
    private func rawStatus(_ block: ChatBlock) -> String {
        let length = block.result?.utf8.count ?? -1
        if let remembered = reportStatusRemembered[block.id], remembered.length == length { return remembered.status }
        let status = block.agentReport?["status"]?.stringValue ?? ""
        reportStatusRemembered[block.id] = (length, status)
        return status
    }

    /// A call block belongs to this running agent if one of its identifiers matches.
    /// The report of a background agent carries its `agentId` from the start (status
    /// "running"), a foreground call carries it only at the end.
    private static func matchesPerId(_ block: ChatBlock, _ live: SubagentLive) -> Bool {
        let identifiers = Set([live.agentId, live.taskId].filter { !$0.isEmpty })
        guard !identifiers.isEmpty else { return false }
        if let reportId = block.agentReport?["agentId"]?.stringValue, identifiers.contains(reportId) { return true }
        if let toolUseId = block.toolUseId, identifiers.contains(toolUseId) { return true }
        return identifiers.contains(block.id)
    }

    /// Fallback for the foreground agent whose block has no result yet and thus no id:
    /// the task. Only for a block that is still RUNNING — otherwise a second agent with
    /// the same task would pull in the long-finished first one.
    private static func matchesPerJob(_ block: ChatBlock, _ live: SubagentLive) -> Bool {
        guard !block.done, !live.description.isEmpty else { return false }
        return block.input?["description"]?.stringValue == live.description
    }

    private func entry(live: SubagentLive, block: ChatBlock?, turnRunning: Bool) -> SubagentEntry {
        let model = live.modelText.isEmpty ? (block?.agentModel ?? "") : live.modelText
        let job = [live.description, block?.description ?? "", live.name]
            .first(where: { !$0.isEmpty }) ?? ""
        // The stream reports it ⇒ "running" (first step of the chain). The sheet's section follows
        // the state — it used to read `status`, and an agent that the stream still reported as
        // "completed" stood under "Finished" while the bar on the web said "running".
        let state = self.state(live: live, block: block, turnRunning: turnRunning)
        return SubagentEntry(
            id: live.id.isEmpty ? (block?.id ?? job) : live.id,
            blockId: block?.id,
            agentId: live.agentId.isEmpty ? live.taskId : live.agentId,
            job: job,
            model: model,
            status: live.status,
            running: state?.identifier == "running",
            startedAt: live.startedAt,
            runtime: nil,
            tokens: live.tokens,
            onlyOutput: Self.tokenLowerLimit(live.tokenKind),
            tempo: agentTempo[live.id],
            tools: live.toolUses,
            report: Self.reportText(block),
            steps: block?.children ?? [],
            error: block?.resultIsError ?? false,
            state: state,
            parkedUntil: live.parkedUntil,
            foreground: live.foreground,
            waitingForCpu: live.waitingForCpu
        )
    }

    private func entry(block: ChatBlock, turnRunning: Bool) -> SubagentEntry {
        let report = block.agentReport
        let agentId = report?["agentId"]?.stringValue ?? ""
        let durationMs = report?["totalDurationMs"]?.intValue
        let state = self.state(live: nil, block: block, turnRunning: turnRunning)
        return SubagentEntry(
            id: block.id,
            blockId: block.id,
            agentId: agentId,
            job: block.description,
            model: block.agentModel,
            status: report?["status"]?.stringValue ?? "",
            // Without a live report it only works if the chain says so: a call without a result
            // in the RUNNING reply (not `busy && !block.done` — which also held in an older
            // reply that was no longer running). Otherwise it stands under "Finished", and the word says
            // whether done, stopped, error or without result.
            running: state?.identifier == "running",
            startedAt: nil,
            runtime: durationMs.map { max(0, $0 / 1000) },
            tokens: report?["totalTokens"]?.intValue,
            onlyOutput: Self.onlyOutput(report: report, seen: tokenKindSeen[agentId]),
            tempo: nil,
            tools: report?["totalToolUseCount"]?.intValue ?? block.visibleChildren.count,
            report: Self.reportText(block),
            steps: block.children,
            error: block.resultIsError,
            state: state
        )
    }

    /// Is the token count of a FINISHED agent a lower bound? The report says so itself (`tokenKind` next to `totalTokens`,
    /// agent-runtime.js) — the app used to read only what it had seen in the running stream,
    /// and after a restart a lower bound could not be told from a full number.
    /// If the field is missing (old data), the value seen in the stream applies; if that is missing too, the kind is UNKNOWN — then
    /// no marker stands, because nobody measured a lower bound. That is not "full": `true` only for an
    /// explicit lower bound. The UNKNOWN kind carries the marker as well (`tokenLowerLimit`): a number from
    /// old data used to stand there like a measured full one. Web counterpart: `tokenKindFromReport` in `web/src/lib/agents.ts`.
    static func onlyOutput(report: JSONValue?, seen: String?) -> Bool {
        tokenLowerLimit(report?["tokenKind"]?.stringValue ?? seen)
    }

    /// Does a token count carry the "at least"/"≥" marker? For every kind except "full" — the lower bound ("only_output") and
    /// the unknown one (missing, empty, foreign): nobody measured there whether it is complete, and "at least"
    /// is true for any counted number. The ONE rule for live row and report; web twin `tokenLowerLimit` in
    /// `web/src/lib/agents.ts`, bound in `web/test/token-kind-binding.test.mjs`.
    static func tokenLowerLimit(_ kind: String?) -> Bool {
        kind != SubagentLive.tokenKindFull
    }

    /// The report is what the MAIN AGENT read: the `report` field of the result,
    /// and if there is none (foreign provider, error case), the raw result.
    private static func reportText(_ block: ChatBlock?) -> String {
        guard let block, let result = block.result, !result.isEmpty else { return "" }
        if let report = block.agentReport?["report"]?.stringValue, !report.isEmpty { return report }
        return result
    }

    /// Abort a running subagent by hand. The server then reports a result to the main agent,
    /// so its run continues instead of running into a deadline.
    ///
    /// `from: "human"` is not decorative: ONLY with it does the report say "stopped by the
    /// human". Without the field the main agent reads a result that cannot be told from "finished
    /// without findings" — and the confirmation dialog beside it promises the human exactly
    /// this difference. The web sends it too.
    func stopAgent(_ agentId: String) async {
        guard !isDraft, !agentId.isEmpty else { return }
        struct Body: Encodable { let agentId: String; let from: String }
        do {
            let _: OKResponse = try await client.post("/api/chats/\(chat.id)/agent/stop", body: Body(agentId: agentId, from: "human"))
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// "Move to background" (the Ctrl+B of Claude Code): a foreground agent switches at once, its waiting
    /// tool call returns with "keeps running in the background", the main agent keeps working; its report arrives
    /// later as a completion notice. `ok: false` means: it was no longer running — the display says so.
    func intoTheBackground(_ agentId: String) async {
        guard !isDraft, !agentId.isEmpty else { return }
        struct Body: Encodable { let agentId: String }
        struct Response: Decodable { let ok: Bool? }
        do {
            let response: Response = try await client.post("/api/chats/\(chat.id)/agent/background", body: Body(agentId: agentId))
            if response.ok == false { self.error = L("The subagent was no longer running — it has already finished.") }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// "Stop all background agents": the server stops the background agents of THIS chat — even
    /// without a running turn — and names the stopped ones. The originator is mandatory (400 without); only "human" leaves
    /// the silent hint for the next turn. Nothing stopped means: no background agent was alive — the
    /// display says so, instead of making an ineffective tap look like an effective one.
    func stopAllBackgroundAgents() async {
        guard !isDraft else { return }
        struct Body: Encodable { let from: String }
        struct Response: Decodable { let stopped: [String]? }
        do {
            let response: Response = try await client.post("/api/chats/\(chat.id)/agents/stop", body: Body(from: "human"))
            if (response.stopped ?? []).isEmpty {
                self.error = L("No background agent was running — foreground agents are ended by stopping the chat.")
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}
