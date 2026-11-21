import Foundation

extension ChatViewModel {

    // ── The running workflow of this chat ──
    /// Load the running workflow. While the chat is a DRAFT it does not exist
    /// server side — and so there is no run either. The SELECTABLE workflows are fetched by
    /// the slash picker on opening (`loadSlashWorkflows`); the choice in the composer is gone.
    func loadWorkflows() async {
        if isDraft {
            workflowRun = nil
            return
        }
        let response: WorkflowRunResponse? = try? await client.get("/api/chats/\(chat.id)/workflow")
        applyWorkflowRun(response?.run)
        // The wait state at the limit is loaded by the composer ITSELF, for every kind of chat —
        // it used to hang here behind the workflow fetch and thus behind the guard that lets only
        // the working chat through. A second fetch at this spot would be a second source.
    }

    // ── Skills of this chat (slash picker) ──
    /// The same two-way split as with the workflows: the existing chat asks the chat route, the
    /// DRAFT the workspace route with the focus project — the picker is available before the first
    /// message, the chat is only created by sending.
    ///
    /// Fetched on OPENING the picker, not once on entering the chat: as measured,
    /// the Claude CLI answers a "/name" it does not know with "Unknown command"
    /// and swallows the whole rest of the message. A stale list would thus not be
    /// an inaccuracy but a lost message.
    func loadSkills() async {
        if isDraft {
            slashSkills = (try? await client.get(
                "/api/workspaces/\(chat.workspaceId)/effective-skills",
                query: [URLQueryItem(name: "projectId", value: chat.projectId ?? "")]
            )) ?? []
            return
        }
        slashSkills = (try? await client.get("/api/chats/\(chat.id)/skills")) ?? []
    }

    /// The graph workflows of the slash picker — the same two-way split as with the skills: the
    /// existing chat asks the chat route, the DRAFT the effective view of the workspace with the focus project. Both
    /// routes carry per entry the `shortName`, which the server computes ONCE over the effective set; an entry without
    /// it is dropped (the picker would otherwise insert a guessed name that the server rejects).
    func loadSlashWorkflows() async {
        guard withDynWorkflows else { slashWorkflows = []; return }
        let list: [WorkflowSummary]
        if isDraft {
            list = (try? await client.get(
                "/api/workspaces/\(chat.workspaceId)/effective-workflows",
                query: [URLQueryItem(name: "projectId", value: chat.projectId ?? "")]
            )) ?? []
        } else {
            list = (try? await client.get("/api/chats/\(chat.id)/workflows")) ?? []
        }
        slashWorkflows = list.filter { $0.shortName != nil }
    }

    /// Is this chat waiting for the reset of a usage limit?
    func loadLimitWait() async {
        guard !isDraft else { limitWait = nil; return }
        let response: LimitWaitResponse? = try? await client.get("/api/chats/\(chat.id)/auto-continue")
        applyLimitWait(response?.wait)
    }

    /// Adopt only FORWARD, as with the workflow run — a slow GET must not turn back a newer
    /// SSE state.
    func applyLimitWait(_ next: LimitWaitState?) { // internal, for extensions
        if let current = limitWait, let next, next.updatedAt < current.updatedAt { return }
        limitWait = next
    }

    /// "Try now" or "Start anyway (costs credit)" at the wait strip — the same
    /// route, ONE difference in the body.
    ///
    /// `anyway` is the one-time approval of the credit gate: the server bypasses the
    /// gate ONLY if the call carries `{"anyway": true}` — the approval is an argument of exactly
    /// the start it approves, not a remembered state. Without the field a turn parks at the gate
    /// again at once; iOS used to send no body at all and relied on the
    /// server concluding an approval itself from `reason == "credit"` — a mark that
    /// stayed around and let a foreign turn past the gate hours later.
    ///
    /// Non-optional Bool in the body, for the same reason as with the toggles in
    /// `AutoContinueSection`: a synthesized Encodable would silently omit a `nil` field, and
    /// then the server would hear nothing again.
    func retryLimitNow(anyway: Bool = false) async {
        guard !isDraft, !limitBusy else { return }
        limitBusy = true
        defer { limitBusy = false }
        struct Body: Encodable { let anyway: Bool }
        do {
            let response: LimitWaitResponse = try await client.post(
                "/api/chats/\(chat.id)/auto-continue/now", body: Body(anyway: anyway))
            applyLimitWait(response.wait)
        } catch {
            addError(error.localizedDescription)
        }
    }

    func cancelLimitWait() async {
        guard !isDraft, !limitBusy else { return }
        limitBusy = true
        defer { limitBusy = false }
        do {
            let _: LimitWaitResponse = try await client.delete("/api/chats/\(chat.id)/auto-continue")
            limitWait = nil
        } catch {
            addError(error.localizedDescription)
        }
    }

    /// Adopt states of the same run ONLY forward: the HTTP response of the start still carries
    /// step 0 and regularly arrives AFTER the first SSE events — without this barrier
    /// the strip jumped back to "step 0" and stayed there.
    func applyWorkflowRun(_ next: WorkflowRunState?) { // internal, for extensions
        if let current = workflowRun, let next, current.id == next.id, next.updatedAt < current.updatedAt { return }
        workflowRun = next
    }

    /// Skip the current step or cancel the whole workflow.
    func skipWorkflowStep() async { await workflowAction("skip") }
    func cancelWorkflow() async { await workflowAction("cancel") }

    private func workflowAction(_ action: String) async {
        guard !isDraft else { return }
        workflowBusy = true
        defer { workflowBusy = false }
        do {
            let response: WorkflowRunResponse = try await client.post("/api/chats/\(chat.id)/workflow/\(action)")
            applyWorkflowRun(response.run)
        } catch {
            addError(error.localizedDescription)
        }
    }
}
