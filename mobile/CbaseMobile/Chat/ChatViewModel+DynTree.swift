import Foundation

// The progress tree of the dynamic workflows of ONE coding chat — the iOS counterpart of the hook
// `web/src/components/chat/chatDynTree.ts`: loaded from the route (`GET /api/chats/:id/dyn-workflows/tree`) on EVERY
// stream connection (`connected`, the first one too: after a dropped stream the route's state is the truth), updated
// from the `dynwf_tree` event. The transitions are computed by `DynTree` (Chat/DynTree.swift, bound to the web) — only
// the paths live here. Only with `withDynWorkflows`.
extension ChatViewModel {

    func loadDynTree() async {
        guard withDynWorkflows, !isDraft else { return }
        dynTree = DynTree.loading(dynTree)
        do {
            let response: JSONValue = try await client.get("/api/chats/\(chat.id)/dyn-workflows/tree")
            dynTree = DynTree.loaded(dynTree, response: try? JSONEncoder().encode(response))
        } catch {
            // Failed is not empty: the state stays "not loaded" (not "no subagent yet"); the next reconnect asks again.
            dynTree = DynTree.failed(dynTree)
        }
    }

    /// For the `dynwf_tree` event from the stream (ChatViewModel+Stream.swift).
    func dynTreeEvent(_ event: JSONValue) { // internal, for extensions
        guard withDynWorkflows, let data = try? JSONEncoder().encode(event) else { return }
        dynTree = DynTree.afterEvent(dynTree, event: data)
    }

    /// The human stop of a workflow (`POST …/dyn-workflows/runs/:runId/stop` with `from: "human"`). The header shows the
    /// final state from the `dynwf_tree` event, not from the response — one source. `false` = failed (the message is in
    /// `error`).
    func stopDynWorkflow(_ runId: String) async -> Bool {
        guard !isDraft, !runId.isEmpty else { return false }
        struct Body: Encodable { let from: String }
        struct Response: Decodable { let ok: Bool? }
        do {
            let _: Response = try await client.post("/api/chats/\(chat.id)/dyn-workflows/runs/\(runId)/stop", body: Body(from: "human"))
            return true
        } catch {
            self.error = L("Could not stop: {msg}", ["msg": error.localizedDescription])
            return false
        }
    }

    /// Skip or restart ONE workflow agent: `POST …/dyn-workflows/runs/:runId/agents/:n/skip` or `restart`, no body. The
    /// new state comes with the tree (`dynwf_tree` event).
    func dynAgentIntervention(runId: String, n: Int, restart: Bool) async -> Bool {
        guard !isDraft, !runId.isEmpty else { return false }
        struct Empty: Encodable {}
        struct Response: Decodable { let ok: Bool? }
        do {
            let _: Response = try await client.post("/api/chats/\(chat.id)/dyn-workflows/runs/\(runId)/agents/\(n)/\(restart ? "restart" : "skip")", body: Empty())
            return true
        } catch {
            self.error = restart
                ? L("Could not restart: {msg}", ["msg": error.localizedDescription])
                : L("Could not skip: {msg}", ["msg": error.localizedDescription])
            return false
        }
    }

    /// The transcript of ONE workflow agent (`GET …/dyn-workflows/runs/:runId/agents/:n`). Refetched as soon as the
    /// agent's state or tokens change (the sheet calls it with that key) — so it follows the running agent without a
    /// timer of its own. A repeated fetch leaves the shown rows until the response arrives.
    func loadDynTranscript(runId: String, n: Int) async {
        guard !isDraft else { return }
        let key = DynTranscript.key(runId: runId, n: n)
        if dynTranscripts[key] == nil { dynTranscripts[key] = .loading }
        do {
            let response: DynTranscript.Response = try await client.get("/api/chats/\(chat.id)/dyn-workflows/runs/\(runId)/agents/\(n)")
            dynTranscripts[key] = .rows(response.rows)
        } catch {
            dynTranscripts[key] = .error(error.localizedDescription)
        }
    }
}
