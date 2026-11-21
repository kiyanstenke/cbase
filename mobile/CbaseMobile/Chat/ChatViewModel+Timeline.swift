import Foundation

extension ChatViewModel {

    func buildTimeline(_ entries: [LogEntry]) -> [TimelineItem] { // internal, for extensions
        var result: [TimelineItem] = []
        lastClearAt = 0

        // STABLE identity per row: "row-<database row id>". Without it every
        // reconciliation with the server gave every row a fresh UUID and SwiftUI rebuilt the whole
        // history (visible flicker). Old servers without a row id fall back to the
        // position — which is also stable across an unchanged history.
        var position = 0
        var rowKey = "row-0"

        func ensureAssistant() -> Int {
            if result.last?.role != .assistant {
                // An assistant bubble bundles several log rows; its identity is the
                // FIRST of them — as long as nothing is inserted before it, it stays the same.
                result.append(TimelineItem(id: rowKey, role: .assistant))
            }
            return result.index(before: result.endIndex)
        }

        // Question cards: the selection stands as its own row ("ask_answer") after the question, and
        // a user message after it makes the card inert (the same rule as on the server).
        // EXCEPTION while a workflow runs (row kind "start" without "end"): there the
        // card survives an INTERJECTION by the user, because the server holds the step at it
        // (openAskOf). Otherwise the card would look dead while the run waits for exactly it.
        var askIndexByRequest: [String: Int] = [:]
        var approvalIndexByRequest: [String: Int] = [:]
        var runOpen = false
        func closeAsks() {
            for index in askIndexByRequest.values { result[index].ask?.answerable = false }
        }

        // The time per row (day separator, Chat/DaySeparator.swift): every row a log entry creates carries ITS time —
        // stamped at the head of the NEXT entry (and after the loop), so an append behind `continue` counts too
        // (the same pattern as `melde` in web/src/components/chat/chatBubbles.ts).
        var fromRow = 0
        var ofTime = 0.0
        func stamp() {
            let ms = DaySeparator.timeMs(ofTime) ?? 0 // without a time: unknown (0), never "now" from the default
            if fromRow < result.count { for k in fromRow..<result.count { result[k].at = ms } }
            fromRow = result.count
        }

        for entry in entries {
            stamp()
            ofTime = entry.ts
            position += 1
            rowKey = entry.id > 0 ? "row-\(entry.id)" : "pos-\(position)"
            switch entry.role {
            case "user" where InboundAgentMessage.isMessage(entry.text):
                // The third kind: the message of an agent is a card, not a
                // user bubble, and it closes no question (Chat/InboundAgentMessage.swift).
                result.append(TimelineItem(id: rowKey, role: .message, message: InboundAgentMessage.card(entry.text)))
            case "user" where CompletionNotice.isNotice(entry.text):
                // Two kinds under one role: the completion notice of a subagent is a system row,
                // not a user bubble, and it closes no question (nobody wrote anything). Directly behind the
                // end marker of its workflow it is dropped (`CompletionNotice.duplicate`).
                if !CompletionNotice.duplicate(markerTaskId: result.last?.endMarkerTaskId, entry.text) {
                    result.append(TimelineItem(id: rowKey, role: .divider, label: CompletionNotice.row(entry.text), tone: CompletionNotice.tone(entry.text)))
                }
            case "user":
                if !runOpen { closeAsks() }
                result.append(TimelineItem(
                    id: rowKey,
                    role: .user,
                    // Blocks carry the same STABLE id as their log row ("b-<rowKey>",
                    // at most one block arises per row): with a fresh UUID per reconciliation
                    // the block views lost identity and state at every server sync
                    // (see ChatBlock.id).
                    blocks: [ChatBlock(id: "b-" + rowKey, kind: .text, text: entry.text)],
                    attachments: entry.attachments ?? []
                ))
            case "ask":
                guard let object = parseJSON(entry.text),
                      let requestId = object["requestId"]?.stringValue, !requestId.isEmpty else { continue }
                closeAsks()
                result.append(TimelineItem(id: rowKey, role: .ask, ask: AskCardState(
                    requestId: requestId,
                    questions: (object["questions"]?.arrayValue ?? []).map(AskQuestion.init(json:)),
                    answers: nil,
                    answerable: true
                )))
                askIndexByRequest[requestId] = result.index(before: result.endIndex)
            case "ask_answer":
                guard let object = parseJSON(entry.text),
                      let requestId = object["requestId"]?.stringValue,
                      let index = askIndexByRequest[requestId] else { continue }
                result[index].ask?.answers = (object["answers"]?.arrayValue ?? []).map(AskAnswer.init(json:))
                result[index].ask?.answerable = false
            case "capture":
                // Capture card: screenshot/video of an agent, shown at the turn end.
                guard let object = parseJSON(entry.text) else { continue }
                result.append(TimelineItem(id: rowKey, role: .capture, capture: CaptureState(json: object)))
            case "channel":
                // Channel card: a message from a channel between two chats —
                // "sent" at the sender, "from …" at the receiver, system notices with a marker.
                guard let object = parseJSON(entry.text) else { continue }
                result.append(TimelineItem(id: rowKey, role: .channel, channel: ChannelCard(json: object)))
            case "approval":
                // Approval card: open until a decision row follows. A
                // user message does NOT close it — typing is queued, the card stays.
                guard let object = parseJSON(entry.text),
                      let requestId = object["requestId"]?.stringValue, !requestId.isEmpty else { continue }
                result.append(TimelineItem(id: rowKey, role: .approval, approval: ApprovalCardState(json: object, open: true)))
                approvalIndexByRequest[requestId] = result.index(before: result.endIndex)
            case "approval_ruling":
                guard let object = parseJSON(entry.text),
                      let requestId = object["requestId"]?.stringValue,
                      let index = approvalIndexByRequest[requestId] else { continue }
                result[index].approval?.open = false
                result[index].approval?.ruling = ApprovalRuling(json: object)
            case "clear":
                closeAsks()
                for index in result.indices { result[index].dimmed = true }
                result.append(TimelineItem(id: rowKey, role: .clear, label: "Chat cleared up to here"))
                let marker = parseJSON(entry.text)
                lastClearAt = max(lastClearAt, marker?["at"]?.doubleValue ?? entry.ts)
            case "assistant":
                let index = ensureAssistant()
                result[index].blocks.append(ChatBlock(id: "b-" + rowKey, kind: .text, text: entry.text))
            case "thinking":
                let object = parseJSON(entry.text)
                let text = object?["text"]?.stringValue ?? entry.text
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let parent = object?["parent"]?.stringValue
                let block = ChatBlock(id: "b-" + rowKey, kind: .thinking, text: text)
                if let parent {
                    // Across ALL bubbles, and discarded without a parent — never into the main reply.
                    if Self.attachUnderParent(block, parent: parent, in: &result) { continue }
                    continue
                }
                result[ensureAssistant()].blocks.append(block)
            case "sub_text":
                // Interim text of a subagent — belongs under its call block, not in the
                // main reply (see server side: own role, because `assistant` knows no parent).
                let subObject = parseJSON(entry.text)
                let subText = subObject?["text"]?.stringValue ?? entry.text
                guard !subText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let subBlock = ChatBlock(id: "b-" + rowKey, kind: .text, text: subText)
                // Without a call block (compacted history) it is DISCARDED: a 12 KB report
                // in a foreign bubble is worse than none, and the agents bar
                // shows it anyway.
                if let parent = subObject?["parent"]?.stringValue {
                    _ = Self.attachUnderParent(subBlock, parent: parent, in: &result)
                    continue
                }
                result[ensureAssistant()].blocks.append(subBlock)
            case "tool":
                guard let object = parseJSON(entry.text),
                      let name = object["name"]?.stringValue,
                      !name.isEmpty else { continue }
                let block = ChatBlock(
                    id: "b-" + rowKey,
                    kind: .tool,
                    toolUseId: object["id"]?.stringValue,
                    toolName: name,
                    detail: object["detail"]?.stringValue ?? deriveDetail(object["input"]),
                    input: object["input"]
                )
                if let parent = object["parent"]?.stringValue {
                    _ = Self.attachUnderParent(block, parent: parent, in: &result)
                    continue
                }
                result[ensureAssistant()].blocks.append(block)
            case "tool_result":
                guard let object = parseJSON(entry.text),
                      let id = object["id"]?.stringValue else { continue }
                // Backwards across ALL assistant bubbles, like `setToolResult` in the live stream: if
                // a card (question, approval, capture, channel) stands between call and result,
                // `ensureAssistant` would otherwise create an EMPTY bubble, the result would land there,
                // and the call before it would keep spinning as "running" after every reload.
                for index in result.indices.reversed() where result[index].role == .assistant {
                    let hit = Self.updateTool(id: id, in: &result[index].blocks) { tool in
                        tool.result = object["result"]?.stringValue ?? ""
                        tool.resultIsError = object["isError"]?.boolValue == true
                        tool.done = true
                        tool.truncated = entry.truncated != nil ? entry.id : nil
                    }
                    if hit { break }
                }
            case "hint":
                // Hint row of the server, already translated — e.g. "Effort level now medium (was: none)" from the
                // migration after "Auto" was removed (server/backend/electron/server/chats/auto-gone.js). As a divider.
                if !entry.text.isEmpty {
                    result.append(TimelineItem(id: rowKey, role: .divider, label: entry.text))
                }
            case WorkflowApprovalState.role:
                // Approval card of a dynamic workflow: open until decided, no message closes it.
                if let card = WorkflowApprovalState(text: entry.text), !result.contains(where: { $0.wfApproval?.requestId == card.requestId }) {
                    result.append(TimelineItem(id: rowKey, role: .workflowApproval, wfApproval: card))
                }
            case WorkflowApprovalState.rulingRole:
                // The FIRST decision counts (as on the server).
                if let e = WorkflowApprovalState.ruling(text: entry.text),
                   let index = result.lastIndex(where: { $0.wfApproval?.requestId == e.requestId }), result[index].wfApproval?.decision == nil {
                    result[index].wfApproval?.decision = e.decision
                }
            case WorkflowMarker.role:
                // Start/end marker of a dynamic workflow: own role, as a divider with the marker —
                // no user or reply bubble, closes no question, attaches to no parent block.
                if let marker = WorkflowMarker(text: entry.text) {
                    result.append(TimelineItem(id: rowKey, role: .divider, label: marker.row, marker: marker, tone: marker.tone))
                }
            case "meta":
                if let object = parseJSON(entry.text), object["compacted"]?.boolValue == true {
                    result.append(TimelineItem(id: rowKey, role: .divider, label: Self.compactedLabel(auto: object["auto"]?.boolValue)))
                } else if let data = entry.text.data(using: .utf8),
                          var summary = try? JSONDecoder().decode(RunSummary.self, from: data),
                          let index = result.lastIndex(where: { $0.role == .assistant }) {
                    // The end of the run is the `ts` of the meta row (it is written before `run_done`), as on the web.
                    if summary.at == nil, entry.ts > 0 { summary.at = entry.ts }
                    result[index].summary = summary
                }
            case "goal":
                guard let object = parseJSON(entry.text) else { continue }
                result.append(TimelineItem(
                    id: rowKey,
                    role: .goal,
                    label: object["note"]?.stringValue ?? "",
                    achieved: object["achieved"]?.boolValue == true,
                    turns: object["turns"]?.intValue,
                    continuing: object["continuing"]?.boolValue == true
                        ? "\(object["attempt"]?.intValue ?? 0)/\(object["max"]?.intValue ?? 0)"
                        : nil
                ))
            case "monitor":
                guard let object = parseJSON(entry.text) else { continue }
                result.append(TimelineItem(
                    id: rowKey,
                    role: .monitor,
                    label: object["description"]?.stringValue ?? "",
                    event: object["event"]?.stringValue,
                    status: object["status"]?.stringValue
                ))
            case "workflow":
                guard let object = parseJSON(entry.text) else { continue }
                // Run window for the card exception above. When the run ends, the
                // normal rule applies again — a card still open then is settled.
                switch object["kind"]?.stringValue {
                case "start": runOpen = true
                case "end": runOpen = false; closeAsks()
                default: break
                }
                result.append(TimelineItem(id: rowKey, role: .workflow, workflow: WorkflowLine(json: object)))
            case "limit":
                guard let object = parseJSON(entry.text) else { continue }
                result.append(TimelineItem(id: rowKey, role: .limit, limit: LimitLine(json: object)))
            default:
                break
            }
        }
        stamp()
        return result
    }

    func parseJSON(_ text: String) -> JSONValue? { // internal, for extensions (ChatViewModel+Window.swift)
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}

extension TimelineItem {
    /// The task id if this row is the END marker of a dynamic workflow — else `nil`
    /// (`CompletionNotice.duplicate`: a completion notice directly behind it is a duplicate).
    var endMarkerTaskId: String? { marker?.phase == "end" ? marker?.taskId : nil }
}
