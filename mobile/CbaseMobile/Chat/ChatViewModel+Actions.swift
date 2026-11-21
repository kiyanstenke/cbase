// Chat actions of ChatViewModel: rename, pin, move, fork, delete, settings, goal, @-mentions.
import Foundation

extension ChatViewModel {

    func rename(_ title: String) async throws {
        struct Body: Encodable { let title: String }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(title: title))
        chat = updated
        onChanged()
    }

    func togglePin() async throws {
        struct Body: Encodable { let pinned: Bool }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(pinned: !chat.pinned))
        chat = updated
        onChanged()
    }

    func move(to projectId: String?) async throws {
        struct Body: Encodable { let projectId: String? }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(projectId: projectId))
        chat = updated
        onChanged()
    }

    func fork() async throws -> Chat {
        let child: Chat = try await client.post("/api/chats/\(chat.id)/fork")
        onChanged()
        return child
    }

    func delete() async throws {
        let _: OKResponse = try await client.delete("/api/chats/\(chat.id)")
        onChanged()
    }

    func updateSettings(
        provider: String,
        model: String,
        permissionMode: String,
        effort: String,
        browserMode: String,
        preserveContextOnProviderSwitch: Bool,
        /// Ultracode: `nil` = unchanged (field absent from the PATCH), `true` = on, `false` = off. Independent of the effort
        /// level: the level next to it is sent as is, and the switch never touches it.
        ultracode: Bool? = nil,
        /// The EXPLICIT choice of the level (`/effort <level>`, `/effort ultracode`, the effort picker of the chat sheet).
        /// Goes out with `effortChoice: true` as on the web (`effortChoiceBody`).
        effortChoice: Bool = false
    ) async throws {
        await waitForCreation()
        if isDraft {
            // The draft sends every value in the `POST` (`createChatNow`); until then it only lives here.
            chat.provider = provider
            chat.model = model
            chat.permissionMode = permissionMode
            chat.effort = effort
            chat.browserMode = browserMode
            if let ultracode { chat.ultracode = ultracode }
            return
        }
        if preserveContextOnProviderSwitch && provider != chat.provider && timeline.contains(where: { $0.role == .user || $0.role == .assistant }) {
            try await compact()
        }
        struct Body: Encodable {
            let provider: String
            let model: String
            let permissionMode: String
            /// `nil` is omitted (synthesized `Encodable`): an empty level is a 400 on the server, so a chat on a model without
            /// levels (Haiku) sends none and keeps the current one.
            let effort: String?
            let browserMode: String
            /// `nil` is omitted — "unchanged".
            let ultracode: Bool?
            /// `true` only on the explicit path and only next to `effort` or `ultracode` (alone it is a 400 on the server);
            /// otherwise omitted — then only a NEW value counts as an explicit choice on the server.
            let effortChoice: Bool?
        }
        // An empty level is never sent (400). Next to Ultracode it goes out as is (two independent axes).
        let level: String? = effort.isEmpty ? nil : effort
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(
            provider: provider,
            model: model,
            permissionMode: permissionMode,
            effort: level,
            browserMode: browserMode,
            ultracode: ultracode,
            effortChoice: effortChoice && (level != nil || ultracode != nil) ? true : nil
        ))
        chat = updated
        contextTokens = updated.contextTokens
        onChanged()
    }

    func setGoal(_ goal: String) async throws {
        await waitForCreation()
        if isDraft {
            // A new or cleared goal is never paused — same rule as on the server (`goal` without `goalPaused` lifts the
            // pause), applied locally because the draft has no server yet.
            chat.goal = goal
            chat.goalPaused = false
            return
        }
        // Take goal AND pause from the response: lifting the pause locally before the PATCH would leave "pursuing goal"
        // on screen if the PATCH failed while the server kept the goal paused.
        struct Body: Encodable { let goal: String }
        let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(goal: goal))
        chat = updated
        onChanged()
    }

    /// Trash button of the goal row: like `/goal clear`, but a failure shows in the timeline instead of being swallowed
    /// by a `try?`. Same error line as for the pause.
    func deleteTarget() async {
        do { try await setGoal("") } catch { self.error = error.localizedDescription }
    }

    /// Pause or resume the goal (pause button of the goal row in the composer): `PATCH /api/chats/:id {goalPaused}`.
    /// Optimistic — the row flips at once; if the call fails the old state returns and the error shows in the timeline.
    /// A draft remembers the choice locally and sends it after creation (`createDraftAn`).
    ///
    /// Exception: a 400 on `true` almost always means the goal is gone meanwhile ("achieved" beat the tap; the server
    /// answers that there is nothing to pause). Then no error line — silently reload the chat; the row disappears with
    /// the goal. Detected by the outcome (goal is empty), not by the message text, which is localized. If the goal is
    /// still there it was another 400 and is shown.
    func setGoalPaused(_ paused: Bool) async {
        let prior = chat.goalPaused
        chat.goalPaused = paused
        await waitForCreation()
        if isDraft { return }
        struct Body: Encodable { let goalPaused: Bool }
        do {
            let updated: Chat = try await client.patch("/api/chats/\(chat.id)", body: Body(goalPaused: paused))
            chat = updated
            onChanged()
        } catch let error as APIError where error.status == 400 && paused {
            if let fresh: Chat = try? await client.get("/api/chats/\(chat.id)"),
               fresh.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                chat = fresh
                onChanged()
                return
            }
            chat.goalPaused = prior
            self.error = error.localizedDescription
        } catch {
            chat.goalPaused = prior
            self.error = error.localizedDescription
        }
    }

    func updateMention(for text: String) {
        mentionTask?.cancel()
        guard let query = mentionQuery(in: text) else {
            mentionResults = []
            return
        }
        mentionTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 160_000_000)
            guard let self, !Task.isCancelled else { return }
            do {
                let response: FileSearchResponse = try await self.client.get(
                    "/api/workspaces/\(self.workspace.id)/file-search",
                    query: [URLQueryItem(name: "q", value: query)]
                )
                guard !Task.isCancelled else { return }
                self.mentionResults = response.results
            } catch {
                self.mentionResults = []
            }
        }
    }

    func insertMention(_ path: String) {
        guard let range = mentionRange(in: input) else { return }
        input.replaceSubrange(range, with: "@\(path) ")
        mentionResults = []
    }
}
