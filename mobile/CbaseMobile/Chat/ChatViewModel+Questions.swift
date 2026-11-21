import Foundation

extension ChatViewModel {

    // ── Questions with a choice card (cbase_ask) ──────────────────────────────
    // An open card is only tappable as long as the user has not written anything else
    // — the server computes the same rule from the history (openAskOf). Otherwise skipped
    // cards would stay tappable forever and the server would reject the answer later.
    func closeOpenAsks() { // internal, for extensions
        for index in timeline.indices where timeline[index].role == .ask {
            if timeline[index].ask?.answerable == true { timeline[index].ask?.answerable = false }
        }
    }

    /// Does a running workflow hold the step at an open card? Then an interjection by the user does NOT
    /// invalidate it (server side: openAskOf) — it must stay tappable,
    /// or the run waits for an answer nobody can give any more.
    private var askHeldByRun: Bool {
        workflowRun?.status == "running" || workflowRun?.status == "waiting"
    }

    func closeOpenAsksOnUserText() { // internal, for extensions
        if askHeldByRun { return }
        closeOpenAsks()
    }

    func pushAsk(requestId: String, questions: [AskQuestion]) { // internal, for extensions
        // A still-running assistant block is closed: following text starts a
        // new bubble instead of mutating into the card.
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty { timeline.remove(at: last) }
            else { timeline[last].streaming = false }
        }
        streamOpen = false
        streamingText = false
        guard !timeline.contains(where: { $0.ask?.requestId == requestId }) else { return }
        closeOpenAsks()
        timeline.append(TimelineItem(role: .ask, ask: AskCardState(requestId: requestId, questions: questions, answers: nil, answerable: true)))
    }

    /// Append a capture card — same mechanics as pushAsk: the running assistant bubble
    /// is closed, following text starts a new one (live order = persisted order).
    func pushCapture(_ capture: CaptureState) { // internal, for extensions
        guard !capture.captureId.isEmpty else { return }
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty { timeline.remove(at: last) }
            else { timeline[last].streaming = false }
        }
        streamOpen = false
        streamingText = false
        guard !timeline.contains(where: { $0.capture?.captureId == capture.captureId }) else { return }
        timeline.append(TimelineItem(role: .capture, capture: capture))
    }

    /// Append an approval card — same mechanics as pushAsk: the running assistant bubble is
    /// closed, following text starts a new one. Open question cards stay as they are:
    /// an approval is not a user message.
    func pushApproval(_ card: ApprovalCardState) { // internal, for extensions
        guard !card.requestId.isEmpty else { return }
        if let last = timeline.indices.last, timeline[last].role == .assistant, timeline[last].streaming {
            if timeline[last].blocks.isEmpty { timeline.remove(at: last) }
            else { timeline[last].streaming = false }
        }
        streamOpen = false
        streamingText = false
        guard !timeline.contains(where: { $0.approval?.requestId == card.requestId }) else { return }
        timeline.append(TimelineItem(role: .approval, approval: card))
    }

    func markApprovalDecided(requestId: String, ruling: ApprovalRuling?) { // internal, for extensions
        for index in timeline.indices where timeline[index].approval?.requestId == requestId {
            timeline[index].approval?.open = false
            if let ruling { timeline[index].approval?.ruling = ruling }
        }
    }

    /// Decision on an approval card: allow (optionally with changed parameters) or reject
    /// with a reason. Closed optimistically; if the call fails, the card reopens.
    func decideApproval(requestId: String, allow: Bool, reason: String = "", updatedInput: JSONValue? = nil) async {
        struct Body: Encodable {
            let requestId: String
            let behavior: String
            let message: String?
            let updatedInput: JSONValue?
        }
        guard let index = timeline.firstIndex(where: { $0.approval?.requestId == requestId }) else { return }
        let prior = timeline[index].approval
        var optimistic = ApprovalRuling(json: .object([:]))
        optimistic.behavior = allow ? "allow" : "deny"
        optimistic.reason = reason
        optimistic.origin = "user"
        optimistic.updatedInput = allow ? (updatedInput ?? prior?.input) : nil
        optimistic.at = Date().timeIntervalSince1970 * 1000
        markApprovalDecided(requestId: requestId, ruling: optimistic)
        do {
            let _: OKResponse = try await client.post(
                "/api/chats/\(chat.id)/permission-decision",
                body: Body(
                    requestId: requestId,
                    behavior: allow ? "allow" : "deny",
                    message: reason.isEmpty ? nil : reason,
                    updatedInput: allow ? updatedInput : nil
                )
            )
        } catch {
            for i in timeline.indices where timeline[i].approval?.requestId == requestId {
                timeline[i].approval = prior
            }
            addError(error.localizedDescription)
        }
    }

    func markAskAnswered(requestId: String, answers: [AskAnswer]) { // internal, for extensions
        for index in timeline.indices where timeline[index].ask?.requestId == requestId {
            timeline[index].ask?.answers = answers
            timeline[index].ask?.answerable = false
        }
    }

    /// Submit the selection. The server delivers it as an ordinary user message: if a
    /// turn is still running it is queued/injected, otherwise it starts a new run.
    func answerAsk(requestId: String, answers: [AskAnswer]) async {
        struct AnswerBody: Encodable {
            let selected: [String]
            let text: String
        }
        struct Body: Encodable {
            let requestId: String
            let answers: [AnswerBody]
        }
        markAskAnswered(requestId: requestId, answers: answers)
        do {
            let _: APIMessageResponse = try await client.post(
                "/api/chats/\(chat.id)/ask-answer",
                body: Body(requestId: requestId, answers: answers.map { AnswerBody(selected: $0.selected, text: $0.text) })
            )
        } catch {
            // Failed (e.g. the card was no longer open) → make it tappable again.
            for index in timeline.indices where timeline[index].ask?.requestId == requestId {
                timeline[index].ask?.answers = nil
                timeline[index].ask?.answerable = true
            }
            addError(error.localizedDescription)
        }
    }

    /// On a rejection `reason` goes to the MODEL (otherwise "rejected" cannot be told apart
    /// from "broken"), `remember` stores the approval permanently — both as on the desktop.
    func decidePermission(_ request: PermissionRequest, allow: Bool, reason: String = "", remember: String = "") async {
        struct Body: Encodable {
            let requestId: String
            let behavior: String
            let message: String?
            let remember: String?
        }
        permissionRequests.removeAll { $0.id == request.id }
        do {
            let _: OKResponse = try await client.post(
                "/api/chats/\(chat.id)/permission-decision",
                body: Body(
                    requestId: request.requestId,
                    behavior: allow ? "allow" : "deny",
                    message: reason.isEmpty ? nil : reason,
                    remember: remember.isEmpty ? nil : remember
                )
            )
        } catch {
            addError(error.localizedDescription)
        }
    }
}
