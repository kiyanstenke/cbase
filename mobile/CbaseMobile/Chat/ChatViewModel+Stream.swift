import Foundation

extension ChatViewModel {

    /// How long a connection must have held before its end resets the wait time (`listen`).
    static let streamHoldSeconds: TimeInterval = 10

    func listen() async { // internal, for extensions
        var retry: UInt64 = 500_000_000
        while !Task.isCancelled {
            var connectedSince: Date?
            var streamError: Error?
            do {
                eventStreamConnected = false
                for try await event in client.stream("/api/chats/\(chat.id)/stream") {
                    if event["type"]?.stringValue == "harness", event["subtype"]?.stringValue == "connected" {
                        connectedSince = Date()
                        // AWAITED, not on the side: the reconciliation fetches the history, and the events behind it (deltas of the
                        // running turn) wait in the stream's buffer until it is done — otherwise it would replace them again.
                        await connected(event)
                    } else {
                        handle(event)
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                streamError = error
            }
            if Task.isCancelled { return }
            // The wait time falls back after a successful connection — otherwise after a few
            // dead spots it stayed at 8 s for good. But only once the connection HELD: if it fell back
            // at `connected`, a stream that is accepted and breaks off again at once (gateway replaces the
            // container, backend dies while writing) would reconnect every 0.5 s without limit — each round reconciling, artifacts,
            // chat, tree, graph runs and agenda; a clean end without holding even with no pause at all.
            let held = connectedSince.map { Date().timeIntervalSince($0) >= Self.streamHoldSeconds } ?? false
            if held { retry = 500_000_000 }
            if let streamError {
                self.error = streamError.localizedDescription
                // Curable: the next successful `connected` takes it back (`connected`).
                reconcileError = self.error
            } else if held {
                continue // a clean end of a held connection: reconnect at once
            }
            try? await Task.sleep(nanoseconds: retry)
            retry = min(retry * 2, 8_000_000_000)
        }
    }

    private func handle(_ event: JSONValue) {
        let type = event["type"]?.stringValue ?? ""
        if type == "row" {
            // A row written OUTSIDE the turn stream (notice of a subagent at the limit, of a dynamic workflow, of a graph run,
            // of a migration …) — `ChatViewModel+Reconcile`.
            rowFromStream(event)
        } else if type == "harness" {
            handleHarness(event)
        } else if type == "stream_event" {
            handleStreamEvent(event)
        } else if type == "assistant" {
            handleAssistant(event)
        } else if type == "user" {
            handleToolResults(event)
        } else if type == "result",
                  streamOpen,
                  !streamGotText,
                  let result = event["result"]?.stringValue {
            appendText(result, parentId: nil)
        }
    }

    /// The first event of EVERY connection. The server keeps no backlog — what happened before it no longer arrives as an
    /// event. So `connected` carries the server state (`lastId`/`total`), and `reconcileHistory` fetches what is missing
    /// (`ChatViewModel+Reconcile.swift`); without it everything between `GET /log` and the first `connected` (turn end, message
    /// from another device, completion notice, channel, "context compacted" …) would be missing until the next open, and mid-run the
    /// blocks from the gap until `run_done`.
    func connected(_ event: JSONValue) async { // internal, for extensions
        let reconnected = hadStreamConnection
        hadStreamConnection = true
        eventStreamConnected = true
        let running = event["running"]?.boolValue == true
        busy = running
        waiting = event["waiting"]?.boolValue == true
        // Compacting survives a reload too: it keeps running on the server, and the
        // chat accepts only queued messages meanwhile.
        compacting = event["compacting"]?.boolValue == true
        applyWaitState(event)
        queued = decodeArray(event["queued"], as: QueuedMessage.self) ?? []
        // Context state of the RUNNING run (the server tracks it continuously). Without it
        // re-entering mid-run showed "0 / 1M" until the next usage event came.
        if let tokens = event["contextTokens"]?.intValue, tokens > 0 { contextTokens = tokens }
        // The reconciliation — and afterwards what the running turn has written so far, as an open bubble (`streamText`): before
        // the bubble the first delta would open anyway — which can be minutes away if a tool runs in between.
        await reconcileHistory(event, running: running)
        if Task.isCancelled { return }
        // The stream is back and the history is there: an error of the stream or the first fetch is thereby healed — only
        // THIS text (`reconcileError`), an error after it stays. Without a loaded history something is still missing: then it stays.
        if logLoaded, !reconcileError.isEmpty {
            if error == reconcileError { error = "" }
            reconcileError = ""
        }
        // Joined mid-run (or returned): at the run end fetch the whole history — it then also carries what the
        // stream does not deliver (the run summary, role `meta`).
        joinedMidRun = running
        if reconnected {
            // Artifacts do NOT hang on the history: an "artifact_changed" from the gap is gone for good. So is the chat itself (title,
            // goal, context) — without a running turn; mid-run the stream tracks the context state.
            Task { await loadArtifacts() }
            if !running { Task { await refreshChatOnly() } }
        }
        // The progress tree: on EVERY connection from the route — also the first; an event from the
        // gap is otherwise gone for good. Only in the Coding chat (the function checks `withDynWorkflows`).
        Task { await loadDynTree() }
        // The graph workflow starts likewise: on EVERY connection from the route — only in the
        // Coding chat, never in the draft (the function checks both).
        Task { await loadGraphRuns() }
        // The agenda likewise: on EVERY connection from the route — an event from the gap is otherwise gone for good.
        // Only in the Coding chat, never in the draft (the function checks both).
        Task { await loadAgenda() }
    }

    private func handleHarness(_ event: JSONValue) {
        let subtype = event["subtype"]?.stringValue ?? ""
        switch subtype {
        case DynTree.event:
            dynTreeEvent(event)
        case GraphRuns.event:
            graphEvent(event)
        case Agenda.event:
            agendaEvent(event)
        case "run_started":
            busy = true
            waiting = false
            stopping = false
            // Monitors, commands and wakeups belong to the previous run — otherwise the new run would count
            // phantoms. The agents do NOT: a background agent survives its turn,
            // the server reports its end (a `background` without it).
            clearForeground()
            startAssistant()
            joinedMidRun = false
            runStartedAt = Date()
            inputTokens = 0
            outputTokens = 0
            messageOutputBaseline = 0
            streamingText = false
        case "run_done", "run_aborted":
            let aborted = subtype == "run_aborted"
            let summary: RunSummary? = runStartedAt.map {
                RunSummary(
                    secs: max(1, Int(Date().timeIntervalSince($0).rounded())),
                    inTok: inputTokens,
                    outTok: outputTokens,
                    aborted: aborted,
                    compacted: nil,
                    at: Date().timeIntervalSince1970 * 1000 // the end of the run, as live on the web
                )
            }
            runStartedAt = nil
            streamingText = false
            stopping = false
            waiting = false
            // `run_done` clears only the foreground (like `backgroundAfter` on the web): the background agents
            // live on. An abort clears everything — if one survives, the server reports it anew after the turn.
            if aborted { clearWaitState() } else { clearForeground() }
            permissionRequests = []
            finishAssistant()
            // `historyAfterRun`: an instance switch came mid-turn — its separator only stands in the stored history.
            // Reloading brings the run summary along (role `meta`, written before `run_done`).
            if joinedMidRun || historyAfterRun {
                joinedMidRun = false
                historyAfterRun = false
                Task { await reloadChatAndLog() }
            } else {
                if let summary { attachSummary(summary) }
                // Reconcile once at the run end — catches artifact events that were lost in a
                // stream gap during the run (`reloadChatAndLog` fetches them above as well).
                Task { await loadArtifacts() }
            }
            Task { await refreshChatOnly() }
        case "run_error":
            runStartedAt = nil
            streamingText = false
            stopping = false
            waiting = false
            clearWaitState()
            permissionRequests = []
            let code = event["code"]?.stringValue ?? "?"
            let stderr = event["stderr"]?.stringValue ?? L("Unknown error")
            let notice = L("Error (exit {code}):\n{stderr}", ["code": code, "stderr": stderr])
            // Joined mid-run also means here "the stream was incomplete" — `run_done` alone used to reload,
            // and a run that ended with an error kept its gap for good. The error row is not
            // in the database: it is added AFTER the reload, otherwise the new history would sweep it away again.
            if joinedMidRun || historyAfterRun {
                joinedMidRun = false
                historyAfterRun = false
                finishAssistant()
                Task {
                    await reloadChatAndLog()
                    addError(notice)
                }
                return
            }
            // First close the bubble, then the error row (as in the branch above): the other way round
            // `finishAssistant` saw the error row as the last row, left the reply `streaming` (no copying, shown as "running")
            // and still set `streamOpen = false` — and `openBubble` no longer found it either.
            finishAssistant()
            addError(notice)
        case "compacting":
            compacting = true
        case "compacted":
            compacting = false
            contextTokens = 0
            timeline.append(TimelineItem(role: .divider, label: Self.compactedLabel(auto: event["auto"]?.boolValue)))
        case "cleared":
            applyClear(at: event["at"]?.doubleValue ?? Date().timeIntervalSince1970 * 1000)
        case "compact_failed":
            compacting = false
        case "permission_request":
            let requestId = event["requestId"]?.stringValue ?? ""
            guard !requestId.isEmpty else { return }
            // Approval of a tool with an approval mark: a card IN THE HISTORY, not a transient
            // approval row — it also stands after a restart until someone decides.
            if event["approval"]?.boolValue == true {
                pushApproval(ApprovalCardState(json: event))
                return
            }
            let request = PermissionRequest(
                requestId: requestId,
                toolName: event["toolName"]?.stringValue ?? "Tool",
                input: event["input"] ?? .object([:]),
                toolUseId: event["toolUseId"]?.stringValue,
                suggestedRule: event["suggestedRule"]?.stringValue ?? ""
            )
            permissionRequests.removeAll { $0.requestId == requestId }
            permissionRequests.append(request)
            // … and as a card into the history, at its place: the server persists
            // the Coding approval like the approval card. While the transient card sits at the
            // composer, the history row stays hidden (`timelineRows` in ChatView);
            // with the decision it becomes visible — and after a restart it stands exactly there.
            pushApproval(ApprovalCardState(json: event))
        case "permission_resolved":
            if let id = event["requestId"]?.stringValue {
                permissionRequests.removeAll { $0.requestId == id }
                // Fallback for the approval card: the decision itself arrives as its own event
                // with origin and parameters; here the card only closes.
                markApprovalDecided(requestId: id, ruling: nil)
            }
        case "approval_ruling":
            guard let id = event["requestId"]?.stringValue, !id.isEmpty else { return }
            markApprovalDecided(requestId: id, ruling: ApprovalRuling(json: event))
        case "ask_request":
            // Question with answer options → tappable card in the history.
            guard let requestId = event["requestId"]?.stringValue, !requestId.isEmpty else { return }
            pushAsk(requestId: requestId, questions: (event["questions"]?.arrayValue ?? []).map(AskQuestion.init(json:)))
        case "ask_resolved":
            // Also answered at the desktop — update the card here too.
            guard let requestId = event["requestId"]?.stringValue else { return }
            markAskAnswered(requestId: requestId, answers: (event["answers"]?.arrayValue ?? []).map(AskAnswer.init(json:)))
        case "capture_message":
            // Capture of an agent (shown at the turn end) → card in the history.
            pushCapture(CaptureState(json: event))
        case "channel_message":
            // Channel message → card in the history; the next server reconciliation replaces
            // the live row with the persisted one (same message, stable id). De-duplicated via
            // `ChannelCard.key` (messageId, else noteId — the archive note has no message).
            if let card = event["card"] {
                let k = ChannelCard(json: card)
                if !timeline.contains(where: { $0.channel?.key == k.key }) {
                    timeline.append(TimelineItem(role: .channel, channel: k))
                }
            }
        case "message_queue":
            queued = decodeArray(event["queued"], as: QueuedMessage.self) ?? []
        case "message_injected":
            queued = decodeArray(event["queued"], as: QueuedMessage.self) ?? []
            // `silent` means: the server deliberately did NOT write this message into the history,
            // because the card it belongs to is already there (channel message,
            // answer to a question). A bubble for it would be visible live and gone after the
            // next load — the truth nowhere. The turn itself begins
            // anyway, just without a user row before it.
            startInjectedTurn(
                text: event["text"]?.stringValue ?? "",
                attachments: decodeArray(event["attachments"], as: Attachment.self) ?? [],
                silent: event["silent"]?.boolValue == true
            )
        case "user_message":
            let text = event["text"]?.stringValue ?? ""
            // The own submission is already in the history (optimistic, see `send`) — its
            // echo is redeemed and NOT appended. Foreign rows (another client, answer
            // to a question card, adopted task) have no echo and are added.
            guard !claimEcho(text) else { return }
            if let message = InboundAgentMessage.card(text) {
                // The third kind: card instead of user bubble, closes no question (Chat/InboundAgentMessage.swift).
                timeline.append(TimelineItem(role: .message, message: message))
                return
            }
            if CompletionNotice.isNotice(text) {
                // Two kinds under one role: system row instead of user bubble — none directly behind the end marker
                // of its workflow (`CompletionNotice.duplicate`).
                if !CompletionNotice.duplicate(markerTaskId: timeline.last?.endMarkerTaskId, text) {
                    timeline.append(TimelineItem(role: .divider, label: CompletionNotice.row(text), tone: CompletionNotice.tone(text)))
                }
                return
            }
            closeOpenAsksOnUserText()
            timeline.append(TimelineItem(
                role: .user,
                blocks: [ChatBlock(kind: .text, text: text)],
                attachments: decodeArray(event["attachments"], as: Attachment.self) ?? []
            ))
        case "title":
            if let title = event["title"]?.stringValue {
                chat.title = title
                onChanged()
            }
        case "chat_settings":
            // The server reports here every change of `chats.instance` (head of another device,
            // `cbase_switch_instance`, move in, move out when the copy is deleted, project switch — runs/instance-switch.js). Head and
            // git sheet read `chat.instance`; the separator "now working in …" is fetched by `historyAfterInstanceSwitch`. A `chat_settings` without
            // the field (run fields of the workflow driver) says nothing about the instance (`ChatInstanceRules.announcement`).
            guard case .instance(let fresh) = ChatInstanceRules.announcement(event) else { break }
            if chat.instance != fresh {
                chat.instance = fresh
                onChanged()
            }
            historyAfterInstanceSwitch()
        case "provider":
            // The provider of the last reply (router) and its window (runs/do-run.js) — only the
            // context bar reads them (`contextDisplay`); computation uses the catalog figure.
            chat.upstreamProvider = event["provider"]?.stringValue ?? ""
            chat.upstreamWindow = event["window"]?.intValue ?? 0
        case "goal_check":
            let achieved = event["achieved"]?.boolValue == true
            timeline.append(TimelineItem(
                role: .goal,
                label: event["note"]?.stringValue ?? "",
                achieved: achieved,
                turns: event["turns"]?.intValue,
                continuing: event["continuing"]?.boolValue == true
                    ? "\(event["attempt"]?.intValue ?? 0)/\(event["max"]?.intValue ?? 0)"
                    : nil
            ))
            if achieved {
                chat.goal = ""
                chat.goalPaused = false
            }
        case "target":
            // Goal and pause after every PATCH that changes one of them — from another
            // device, from the web or as an echo of the own. Only the state on the chat, NO row in the history. Without `goal` the
            // event says nothing; an empty goal is never paused (as on the server).
            guard let target = event["goal"]?.stringValue else { break }
            chat.goal = target
            chat.goalPaused = !target.isEmpty && event["goalPaused"]?.boolValue == true
        case "run_waiting":
            // Turn over — no text streams any more. Without this reset the
            // wait row would stay hidden behind the streaming state.
            streamingText = false
            waiting = true
            applyWaitState(event)
        case "run_busy":
            waiting = false
        case "background":
            // Running background work, independent of the wait state: the main agent can
            // keep working while agents run in the background. Only so can the display
            // "N agents working" show them — their tool block counts as finished at once.
            applyWaitState(event)
        case "monitor":
            timeline.append(TimelineItem(
                role: .monitor,
                label: event["description"]?.stringValue ?? "",
                event: event["event"]?.stringValue,
                status: event["status"]?.stringValue
            ))
        case "workflow_step":
            // The row arrives nested (`line`) — it carries a field `type` itself, which would have overwritten
            // the "harness" in the envelope.
            timeline.append(TimelineItem(role: .workflow, workflow: WorkflowLine(json: event["line"] ?? event)))
        case "workflow_run":
            if let run = event["run"], let data = try? JSONEncoder().encode(run) {
                applyWorkflowRun(try? JSONDecoder().decode(WorkflowRunState.self, from: data))
            } else {
                applyWorkflowRun(nil)
            }
        case "workflow_marker":
            // Start/end marker of a dynamic workflow, nested under `marker`.
            pushWorkflowMarker(event["marker"])
        case "workflow_approval":
            // Approval card of a dynamic workflow, nested under `card`.
            pushWorkflowApproval(event["card"])
        case "workflow_approval_decided":
            if let e = WorkflowApprovalState.ruling(json: event["ruling"]) {
                markWorkflowApproval(requestId: e.requestId, decision: e.decision)
            }
        case "limit_line":
            // Here too the row arrives nested (`line`).
            timeline.append(TimelineItem(role: .limit, limit: LimitLine(json: event["line"] ?? event)))
        case "limit_wait":
            if let wait = event["wait"], let data = try? JSONEncoder().encode(wait) {
                applyLimitWait(try? JSONDecoder().decode(LimitWaitState.self, from: data))
            } else {
                limitWait = nil
            }
        case "artifact_changed":
            Task { await loadArtifacts() }
        default:
            break
        }
    }

    /// The four reasons of a wait phase arrive in `connected` (re-entry), `run_waiting` and
    /// `background` (background work mid-turn) — to be unpacked the same way each time.
    private func applyWaitState(_ event: JSONValue) {
        let names: (String) -> [String] = { key in
            event[key]?.arrayValue?.compactMap { $0["description"]?.stringValue } ?? []
        }
        monitors = event["monitors"]?.arrayValue?.map(MonitorView.init(json:)) ?? []
        // Subagents arrive as whole records: task, provider, model,
        // status, start time, tokens and token kind. This spot used to squeeze task and model
        // into ONE text and throw the id away — making neither a stop nor the mapping to the
        // call in the history possible.
        let agents = event["agents"]?.arrayValue?.map(SubagentLive.init(json:)) ?? []
        waitAgentsLive = agents
        measureTempo(agents)
        for agent in agents where !agent.id.isEmpty {
            // The token kind survives the agent: a FINISHED agent comes from the history, and
            // its report does not say whether the number is complete. Without this memory
            // Codex would suddenly show "12k" instead of "at least 12k" — an understated number
            // posing as a complete one.
            tokenKindSeen[agent.id] = agent.tokenKind
        }
        waitTasks = names("tasks")
        let wakeup = event["wakeupAt"]?.doubleValue ?? 0
        waitWakeupAt = wakeup > 0 ? Date(timeIntervalSince1970: wakeup / 1000) : nil
        waitWakeupReason = event["wakeupReason"]?.stringValue ?? ""
        waitWakeupPrompt = event["wakeupPrompt"]?.stringValue ?? ""
    }

    private func clearWaitState() {
        clearForeground()
        waitAgentsLive = []
        tempoLane = [:]
        agentTempo = [:]
    }

    /// What belongs to the TURN: background commands. The agents stay, as do the monitors and the
    /// wakeup — they belong to the chat (Chat/ChatMonitors.swift, server runs/wakeup.js); the server reports their end with
    /// a `background` without them (the wakeup: `wakeupAt` 0). Like `backgroundAfter` on the web.
    private func clearForeground() {
        waitTasks = []
    }
}
