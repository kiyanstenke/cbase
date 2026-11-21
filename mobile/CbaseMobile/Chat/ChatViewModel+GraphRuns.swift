import Foundation

// The graph-workflow starts of ONE coding chat — the iOS counterpart of the hook
// `web/src/components/chat/chatGraphRuns.ts`: loaded from the route (`GET /api/chats/:id/graph-workflows`) on EVERY
// stream connection (`connected`, the first one too, hence on a chat switch: each chat has its own model and stream),
// updated from the `graph_run` event. The transitions are computed by `GraphRuns` (Chat/GraphRuns.swift) — only the
// paths live here. Only with `withDynWorkflows` (the coding chat); an agent chat starts no graph workflows. A draft
// without an id does not load.
//
// Also the paths of the card of a background run under "Background Tasks" (Chat/GraphRunCard.swift) and of its row in
// the sheet of running tasks: which runs get a card (`graphCards`), which chat "Open" leads to (`graphChildChat`) and
// whether one needs the human's attention (`graphBackgroundActive`). Stopping goes the same way as the queued start
// (`stopGraphStart`) — the route hangs on the chat whose turn started it, so on THIS one. The reply from the card's
// form (`respondGraphRun`) goes to the child chat, not to this one.
extension ChatViewModel {

    /// The background runs of this chat — one card each under "Background Tasks", newest first. Foreground runs have
    /// strips and banners, no card; a chat without `withDynWorkflows` has no graph starts.
    var graphCards: [GraphRuns.View] {
        withDynWorkflows ? GraphRuns.backgroundRuns(graphRuns) : []
    }

    /// The view for a `startId` (the handle of the tasks row) — `nil` if it is no longer in the state.
    func graphView(_ startId: String) -> GraphRuns.View? {
        graphRuns.runs.first { $0.startId == startId }
    }

    /// The chat that "Open" shows: the child chat of a background run. `nil` if there is none — the view then names THIS
    /// chat (before the start, after the child was deleted) or none; both open nothing.
    func graphChildChat(_ run: GraphRuns.View) -> String? {
        guard run.background, !run.chatId.isEmpty, run.chatId != chat.id else { return nil }
        return run.chatId
    }

    /// Is a graph workflow running or waiting in the background? Then the dot sits on the header's agents button, and the
    /// run times of the cards tick.
    var graphBackgroundActive: Bool {
        graphCards.contains { $0.state == "running" || $0.state == "waiting" }
    }

    func loadGraphRuns() async {
        guard withDynWorkflows, !isDraft else { return }
        graphRuns = GraphRuns.loading(graphRuns)
        do {
            let response: JSONValue = try await client.get("/api/chats/\(chat.id)/graph-workflows")
            graphRuns = GraphRuns.loaded(graphRuns, response: try? JSONEncoder().encode(response))
        } catch {
            // Failed is not empty: the state stays "not loaded"; the next connection asks again.
            graphRuns = GraphRuns.failed(graphRuns)
        }
    }

    /// For the `graph_run` event from the stream (ChatViewModel+Stream.swift).
    func graphEvent(_ event: JSONValue) { // internal, for extensions
        guard withDynWorkflows, let data = try? JSONEncoder().encode(event) else { return }
        graphRuns = GraphRuns.afterEvent(graphRuns, event: data)
    }

    /// The row above the input field (composer strip) — `nil` if none fits.
    var graphStartRow: GraphRuns.Row? {
        GraphRuns.foregroundRow(graphRuns, hidden: graphHidden)
    }

    /// "Cancel" on a queued or waiting start: `POST …/graph-workflows/:startId/stop` with `from: "human"`. Response
    /// (`{ run }`) and event bring the new state — both through the same path (`GraphRuns.including`), a duplicate only
    /// replaces itself. A refusal (409, e.g. already ended) goes to the error display. `false` = failed.
    func stopGraphStart(_ startId: String) async -> Bool {
        guard !isDraft, !startId.isEmpty, !graphStopRunning else { return false }
        struct Body: Encodable { let from: String }
        struct Response: Decodable { let run: GraphRuns.Possible<GraphRuns.View>? }
        graphStopRunning = true
        defer { graphStopRunning = false }
        // Do NOT pre-encode: `APIClient.makeURL` sets `components.path` and encodes it itself (otherwise `%252D`).
        do {
            let response: Response = try await client.post("/api/chats/\(chat.id)/graph-workflows/\(startId)/stop", body: Body(from: "human"))
            if let run = response.run?.value { graphRuns = GraphRuns.including(graphRuns, run: run) }
            return true
        } catch {
            self.error = L("Cancelling failed: {msg}", ["msg": error.localizedDescription])
            return false
        }
    }

    /// How a reply from the card went. `noLongerOpen`: another device (or the run itself) was faster — 409 from the route,
    /// `{ ok: false }` for the permission; the state is then reloaded. `error`: any other refusal, with the server's text.
    enum GraphResponseResult: Equatable {
        case sent
        case noLongerOpen
        case error(String)
    }

    /// The reply from the form of a waiting background run (Chat/GraphRunCard.swift): `GraphRuns.responseRequest`
    /// computes path and body — via the EXISTING routes on the child chat (`/message`, `/ask-answer`,
    /// `/permission-decision`, `/dyn-workflows/approval`), there is no route of its own. `nil` = nothing to send (empty
    /// free text, no form, no child chat). The new state comes with the `graph_run` event; only on "no longer open" is it
    /// reloaded here, so the card stops offering the stale form.
    func respondGraphRun(_ run: GraphRuns.View, input: GraphRuns.Input) async -> GraphResponseResult? {
        guard !isDraft, let request = GraphRuns.responseRequest(run, input) else { return nil }
        struct Receipt: Decodable { let ok: Bool? }
        // Do NOT pre-encode: `APIClient.makeURL` sets `components.path` and encodes it itself (otherwise `%252D`).
        do {
            let data = try await client.send(request.path, body: request.body)
            // `/permission-decision` answers 200 for a card that is no longer open too — `{ ok: false }`.
            if request.body.behavior != nil, (try? JSONDecoder().decode(Receipt.self, from: data))?.ok == false {
                await loadGraphRuns()
                return .noLongerOpen
            }
            return .sent
        } catch let error as APIError where error.status == 409 {
            await loadGraphRuns()
            return .noLongerOpen
        } catch {
            return .error(error.localizedDescription)
        }
    }

    /// "Hide" on the worktree row: only in this model's memory, per `startId` (the worktree itself stays).
    func fadeGraphStartOut(_ startId: String) {
        graphHidden.insert(startId)
    }
}
