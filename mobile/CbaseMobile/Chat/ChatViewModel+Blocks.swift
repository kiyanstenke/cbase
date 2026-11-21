// Folding stream events into timeline blocks: text, thinking, tool calls and results, injected turns.
import Foundation

extension ChatViewModel {

    func handleStreamEvent(_ event: JSONValue) { // internal, for extensions
        let stream = event["event"] ?? .object([:])
        let type = stream["type"]?.stringValue ?? ""
        let parentId = event["parent_tool_use_id"]?.stringValue
        switch type {
        case "message_start":
            guard parentId == nil else { return }
            messageOutputBaseline = outputTokens
            if let usage = stream["message"]?["usage"] {
                inputTokens = totalInputTokens(usage)
            }
        case "message_delta":
            guard parentId == nil, let current = stream["usage"]?["output_tokens"]?.intValue else { return }
            outputTokens = messageOutputBaseline + current
            contextTokens = inputTokens + outputTokens - messageOutputBaseline
        case "content_block_delta":
            let delta = stream["delta"] ?? .object([:])
            if delta["type"]?.stringValue == "text_delta" {
                if parentId == nil { streamingText = true }
                appendText(delta["text"]?.stringValue ?? "", parentId: parentId)
            } else if delta["type"]?.stringValue == "thinking_delta" {
                if parentId == nil { streamingText = false }
                appendThinking(delta["thinking"]?.stringValue ?? "", parentId: parentId)
            }
        case "content_block_start":
            let block = stream["content_block"] ?? .object([:])
            if block["type"]?.stringValue == "tool_use" {
                if parentId == nil { streamingText = false }
                addTool(
                    id: block["id"]?.stringValue,
                    name: block["name"]?.stringValue ?? "Tool",
                    input: block["input"],
                    parentId: parentId
                )
            }
        default:
            break
        }
    }

    func handleAssistant(_ event: JSONValue) { // internal, for extensions
        let parentId = event["parent_tool_use_id"]?.stringValue
        var hasTool = false
        for block in event["message"]?["content"]?.arrayValue ?? [] where block["type"]?.stringValue == "tool_use" {
            upsertTool(
                id: block["id"]?.stringValue,
                name: block["name"]?.stringValue ?? "Tool",
                input: block["input"] ?? .object([:]),
                parentId: parentId
            )
            hasTool = true
        }
        if hasTool && parentId == nil { streamingText = false }
        if parentId == nil, let usage = event["message"]?["usage"] {
            inputTokens = totalInputTokens(usage)
            contextTokens = inputTokens
        }
    }

    func handleToolResults(_ event: JSONValue) { // internal, for extensions
        for block in event["message"]?["content"]?.arrayValue ?? []
        where block["type"]?.stringValue == "tool_result" {
            guard let id = block["tool_use_id"]?.stringValue else { continue }
            let result = resultText(block["content"])
            setToolResult(id: id, result: result, isError: block["is_error"]?.boolValue == true)
        }
    }

    func startAssistant() { // internal, for extensions
        streamOpen = true
        streamGotText = false
        timeline.append(TimelineItem(role: .assistant, streaming: true))
    }

    /// Content WITHOUT a parent while the stream is closed. The stream is closed mid-turn when this client did not see the
    /// turn boundary — the chat was opened during the run or the history was re-adopted (`takeOverHistory` resets
    /// `streamOpen`). Then the last row is the STORED answer of this turn, and `startAssistant` would put a second one
    /// next to it; the history (`buildTimeline`) appends the same rows to the last answer. Hence the same rule: if the
    /// last row is an answer it becomes the open one again — only a pure error row (`addError`, in no server row) stays
    /// closed. Identical to the web (`web/src/components/chat/chatBubbles.ts` `openResponse`).
    func openResponse() { // internal, for extensions
        if let last = timeline.indices.last, timeline[last].role == .assistant,
           !(!timeline[last].blocks.isEmpty && timeline[last].blocks.allSatisfy { $0.kind == .error }) {
            streamOpen = true
            streamGotText = false
            timeline[last].streaming = true
            return
        }
        startAssistant()
    }

    /// Adopt the already streamed answer text of a running turn (from `connected`).
    ///
    /// Exactly ONCE: a second `connected` after a stream gap would find the bubble open and append the same text a second
    /// time below it. If it is open, the live stream leads (`reconcileHistory` then adds at most the missing end), and at
    /// the end of the run `joinedMidRun` reconciles the whole history with the server.
    ///
    /// The guard hangs on the BUBBLE (`openBubble`), not on `streamOpen`: with `!streamOpen`, after `onDisappear` and a new
    /// `.task` the load removed the open bubble, `streamOpen` stayed true, and the buffer text was missing until
    /// `run_done`; the following deltas attached to the last stored answer.
    ///
    /// Empty text means "nothing came yet", not "the answer is empty": then the bubble is created on the first delta.
    func takeOverStreamText(_ text: String, truncated: Bool) { // internal, for extensions
        guard !text.isEmpty, openBubble == nil else { return }
        // A leftover flag without a bubble: `appendText` opens one itself (`openResponse`) — if the last row is the stored
        // answer of this turn, the buffer belongs in it (as after a reload), otherwise in a new bubble.
        streamOpen = false
        appendText(text, parentId: nil)
        // The server's buffer stopped at 200,000 characters; whatever came after is missing between this text and the next
        // delta. A cap has to say that it is one — otherwise a truncated text cannot be told from a complete one, and
        // the gap would sit in the MIDDLE of a sentence.
        if truncated {
            appendText(Self.bufferGapMarker, parentId: nil)
        }
    }

    /// The marker behind a truncated server buffer (`streamTextTruncated`) — ONE wording for the adoption on open
    /// (`takeOverStreamText`) and for patching an open bubble after a stream gap (`supplementOpenBubble`). The paragraph
    /// breaks separate it from the deltas that continue behind the gap.
    static var bufferGapMarker: String {
        "\n\n" + L("… a piece is missing here: the running turn's buffer was full. The complete answer appears in the history once the run has finished.") + "\n\n"
    }

    func finishAssistant() { // internal, for extensions
        busy = false
        guard streamOpen else { return }
        streamOpen = false
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty {
                timeline.remove(at: last)
            } else {
                timeline[last].streaming = false
            }
        }
    }

    func startInjectedTurn(text: String, attachments: [Attachment], silent: Bool = false) { // internal, for extensions
        // If the bubble still stands as an unredeemed echo at the END of the timeline (the server did inject it into the
        // running turn after all, see `send`), it is re-sorted here: first the running answer closes, then the message
        // follows. Without removing it, it would appear twice — and before the answer it belongs to.
        if let index = pendingEchoes.firstIndex(where: { $0.text == text }) {
            let echo = pendingEchoes.remove(at: index)
            timeline.removeAll { $0.id == echo.id }
        }
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty {
                timeline.remove(at: last)
            } else {
                timeline[last].streaming = false
            }
        }
        // Without a timeline row there is nothing an open question could close — and an empty bubble cannot be told from
        // a lost message.
        if !silent, let message = InboundAgentMessage.card(text) {
            // The message of an agent (third kind, Chat/InboundAgentMessage.swift): a card instead of a user bubble, closes
            // no question.
            timeline.append(TimelineItem(role: .message, message: message))
        } else if !silent, CompletionNotice.isNotice(text) {
            // The completion notice of a subagent: a system row instead of a user bubble, closes no question. Directly
            // after the end marker of its workflow it is dropped (`CompletionNotice.duplicate`).
            if !CompletionNotice.duplicate(markerTaskId: timeline.last?.endMarkerTaskId, text) {
                timeline.append(TimelineItem(role: .divider, label: CompletionNotice.row(text), tone: CompletionNotice.tone(text)))
            }
        } else if !silent, !text.isEmpty {
            closeOpenAsksOnUserText()
            timeline.append(TimelineItem(role: .user, blocks: [ChatBlock(kind: .text, text: text)], attachments: attachments))
        }
        streamOpen = true
        streamGotText = false
        streamingText = false
        timeline.append(TimelineItem(role: .assistant, streaming: true))
    }

    func appendText(_ text: String, parentId: String?) { // internal, for extensions
        guard !text.isEmpty else { return }
        // Text of a subagent opens NO answer and does not count as "gotText": otherwise it would begin an empty bubble of
        // the main agent, and the result fallback at turn end would swallow its final text.
        if let parentId {
            mutateUnderParent(parentId) { children in
                if let last = children.indices.last, children[last].kind == .text {
                    children[last].text += text
                } else {
                    children.append(ChatBlock(kind: .text, text: text))
                }
            }
            return
        }
        if !streamOpen { openResponse() }
        streamGotText = true
        mutateAssistantBlocks { blocks in
            if let last = blocks.indices.last, blocks[last].kind == .text {
                blocks[last].text += text
            } else {
                blocks.append(ChatBlock(kind: .text, text: text))
            }
        }
    }

    private func appendThinking(_ text: String, parentId: String?) {
        guard !text.isEmpty else { return }
        if let parentId {
            mutateUnderParent(parentId) { children in
                if let last = children.indices.last, children[last].kind == .thinking {
                    children[last].text += text
                } else {
                    children.append(ChatBlock(kind: .thinking, text: text))
                }
            }
            return
        }
        if !streamOpen { openResponse() }
        mutateAssistantBlocks { blocks in
            if let last = blocks.indices.last, blocks[last].kind == .thinking {
                blocks[last].text += text
            } else {
                blocks.append(ChatBlock(kind: .thinking, text: text))
            }
        }
    }

    private func addTool(id: String?, name: String, input: JSONValue?, parentId: String?) {
        if parentId == nil, !streamOpen { openResponse() }
        let block = ChatBlock(
            kind: .tool,
            toolUseId: id,
            toolName: name,
            detail: deriveDetail(input),
            input: input
        )
        if let parentId {
            mutateUnderParent(parentId) { $0.append(block) }
            return
        }
        mutateAssistantBlocks { blocks in
            blocks.append(block)
        }
    }

    private func upsertTool(id: String?, name: String, input: JSONValue, parentId: String?) {
        // Patch first — across ALL bubbles, not only the last: a subagent's call is regularly one bubble further up. Only
        // into an OPEN block (repeated Codex ids, see `updateTool`).
        if let id {
            for index in timeline.indices.reversed() where timeline[index].role == .assistant {
                let hit = Self.updateTool(id: id, in: &timeline[index].blocks, onlyOpen: true) { tool in
                    tool.input = input
                    let detail = deriveDetail(input)
                    if !detail.isEmpty { tool.detail = detail }
                }
                if hit { return }
            }
        }
        let block = ChatBlock(kind: .tool, toolUseId: id, toolName: name, detail: deriveDetail(input), input: input)
        if let parentId {
            mutateUnderParent(parentId) { $0.append(block) }
            return
        }
        mutateAssistantBlocks { blocks in
            blocks.append(block)
        }
    }

    /// Search backwards through the timeline, not only the last bubble: if a row of its own (question card, monitor row)
    /// slips between call and result, the result would land nowhere — the call would stay "running" forever (and
    /// `mutateAssistantBlocks` would create an empty bubble for it). The normal case hits the last bubble at once.
    private func setToolResult(id: String, result: String, isError: Bool) {
        for index in timeline.indices.reversed() where timeline[index].role == .assistant {
            let hit = Self.updateTool(id: id, in: &timeline[index].blocks) { tool in
                tool.result = result
                tool.resultIsError = isError
                tool.done = true
            }
            if hit { return }
        }
    }

    /// Sort the content of ONE subagent into its call block.
    /// File the content of ONE subagent into its call block.
    ///
    /// Like `setToolResult`: backwards through ALL assistant bubbles, recursively over all levels. Returns `false` if the
    /// call is nowhere — then the content is DROPPED. Otherwise it would fall into the main agent's bubble via
    /// `mutateAssistantBlocks`, which would even create a new empty bubble: two streams in ONE text block, interleaved
    /// character by character. Whatever carries a `parent` belongs to the subagent — which has its own place (the agents
    /// bar) where nothing gets lost.
    @discardableResult
    private func mutateUnderParent(_ parentId: String, _ mutate: (inout [ChatBlock]) -> Void) -> Bool {
        for index in timeline.indices.reversed() where timeline[index].role == .assistant {
            if Self.mutateChildren(of: parentId, in: &timeline[index].blocks, mutate: mutate) { return true }
        }
        return false
    }

    func attachSummary(_ summary: RunSummary) { // internal, for extensions
        guard let index = timeline.lastIndex(where: { $0.role == .assistant }) else { return }
        timeline[index].summary = summary
    }

    /// Not private: the view reports through this too (e.g. a photo that exists only in iCloud).
    func addError(_ text: String) {
        timeline.append(TimelineItem(role: .assistant, blocks: [ChatBlock(kind: .error, text: text)]))
    }

    func pushInfo(title: String, body: String) { // internal, for extensions
        timeline.append(TimelineItem(role: .info, blocks: [ChatBlock(kind: .text, text: body)], label: title))
    }

    private func mutateAssistantBlocks(_ mutate: (inout [ChatBlock]) -> Void) {
        if timeline.last?.role != .assistant { startAssistant() }
        guard let index = timeline.indices.last else { return }
        mutate(&timeline[index].blocks)
    }

    func refreshChatOnly() async { // internal, for extensions
        guard !isDraft else { return }
        do {
            chat = try await client.get("/api/chats/\(chat.id)")
            contextTokens = chat.contextTokens
            onChanged()
        } catch {}
    }

    func reloadQueueFromStreamState() async { // internal, for extensions
        // The connected SSE stream sends the authoritative queue on the next change. On a race we therefore do not let
        // the locally removed entry reappear.
    }
}
