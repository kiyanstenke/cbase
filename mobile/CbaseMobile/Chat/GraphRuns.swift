import Foundation

// The graph-workflow starts of ONE coding chat as pure computation: the iOS counterpart of
// `web/src/lib/graph-runs.ts`. Foundation only, no SwiftUI, no `L(…)`. It is BOUND to the web:
// `web/test/graph-runs-binding.test.mjs` assembles it with a driver into a program (like
// `dyn-tree-binding`) and demands the same answer as the web for state, row, card, response form and
// request.
//
// The server delivers ONE view per start (workflows/graph-start.js graphRunView): through the route
// `GET /api/chats/:id/graph-workflows` (`{ runs }`, newest first, at most 50) and the event
// `{ type: "harness", subtype: "graph_run", run }` after EVERY change of a row. From these come the
// state (`Stand`, `loading`/`loaded`/`failed`/`afterEvent`) and the ONE row above the input field
// (`foregroundRow`): a foreground start that begins after the turn or waits on a lock; from
// `running` on the existing workflow strip (`workflowRun`) takes over. The composer
// (`Chat/ChatComposer.swift`) computes none of this itself.
//
// Decoding is LENIENT like `DynTree`: a synthesized `Decodable` demands every key, and a missing
// field (an older server) would make the whole state unreadable. Only `startId` and `state` are
// mandatory. Of `run` it reads only what the card shows (step, total, title), `wait` in full.
//
// The German words in `stateWord` are keys for `L(…)` (Kit/LocDEBase.swift); `loc-audit.sh` sees
// only literal calls, so they are entered in the dictionary by hand and the binding checks it; the
// same holds for the words and placeholders of the response form (`responseForm`).
enum GraphRuns {
    /// The event in the chat stream (harness subtype), not "workflow_run": that is the running graph itself.
    static let event = "graph_run"

    /// The nine states of the run view, in the order of the contract.
    static let states = ["earmarked", "waiting_lock", "waiting_storage", "running", "waiting", "finished", "failed", "stopped", "dismissed"]

    /// The display word per state (key for `L(…)`, the same words as `STATE_WORD` on the web).
    static let stateWord: [String: String] = [
        "earmarked": "Scheduled##earmarked",
        "waiting_lock": "Waiting for lock",
        "waiting_storage": "Waiting for memory",
        "running": "Running",
        "waiting": "Waiting for you",
        "finished": "Done",
        "failed": "Failed",
        "stopped": "Stopped",
        "dismissed": "Discarded",
    ]

    /// Finished: the row no longer changes afterwards (except a worktree that stays).
    static let toEnd: Set<String> = ["finished", "failed", "stopped", "dismissed"]

    struct View: Decodable, Equatable {
        /// The id of the row in `graph_starts`, exposed as `startId`.
        let startId: String
        let background: Bool
        let worktree: Bool
        let worktreePath: String
        let workflowId: String
        /// The workflow's real name.
        let name: String
        let shortName: String
        /// The input, truncated by the server to 400 characters.
        let input: String
        /// One of the nine states (`states`); an unknown one is kept but ends up in no row.
        let state: String
        let reason: String
        /// The chat the run executes in: the child chat in the background, otherwise this one.
        let chatId: String
        /// The graph run (workflows/run-state.js workflowRunView); `nil` before the start.
        let run: Run?
        /// What a waiting run waits for; `nil` while nothing or something unreadable arrives.
        let wait: Wait?
        let stoppedOf: String
        let startedAt: Double
        let updatedAt: Double
        /// `nil` until the run has ended.
        let endedAt: Double?

        private enum CodingKeys: String, CodingKey {
            case startId, background, worktree, worktreePath, workflowId, name, shortName, input, state, reason, chatId, run, wait, stoppedOf, startedAt, updatedAt, endedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // Mandatory: without an id nothing can be inserted, without a state there is nothing to say. An EMPTY id counts
            // as none (like `isView` on the web).
            startId = try c.decode(String.self, forKey: .startId)
            guard !startId.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .startId, in: c, debugDescription: "empty startId")
            }
            state = try c.decode(String.self, forKey: .state)
            background = (try? c.decodeIfPresent(Bool.self, forKey: .background)) == true
            worktree = (try? c.decodeIfPresent(Bool.self, forKey: .worktree)) == true
            worktreePath = (try? c.decodeIfPresent(String.self, forKey: .worktreePath)) ?? ""
            workflowId = (try? c.decodeIfPresent(String.self, forKey: .workflowId)) ?? ""
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            shortName = (try? c.decodeIfPresent(String.self, forKey: .shortName)) ?? ""
            input = (try? c.decodeIfPresent(String.self, forKey: .input)) ?? ""
            reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? ""
            chatId = (try? c.decodeIfPresent(String.self, forKey: .chatId)) ?? ""
            run = (try? c.decodeIfPresent(Run.self, forKey: .run)) ?? nil
            wait = (try? c.decodeIfPresent(Wait.self, forKey: .wait)) ?? nil
            stoppedOf = (try? c.decodeIfPresent(String.self, forKey: .stoppedOf)) ?? ""
            startedAt = (try? c.decodeIfPresent(Double.self, forKey: .startedAt)) ?? 0
            updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
            endedAt = try? c.decodeIfPresent(Double.self, forKey: .endedAt)
        }
    }

    /// A number of the view that counts as whole: finite and at least 1 (truncated), otherwise `nil`. Like `wholeNumber`.
    static func wholeNumber(_ v: Double?) -> Int? {
        guard let v, v.isFinite, v >= 1 else { return nil }
        return Int(v)
    }

    /// The run fields the card reads (`{step}/{total}: {nodeTitle}`).
    struct Run: Decodable, Equatable {
        let status: String
        let step: Int?
        let total: Int?
        let nodeTitle: String

        private enum CodingKeys: String, CodingKey { case status, step, total, nodeTitle }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
            step = GraphRuns.wholeNumber((try? c.decodeIfPresent(Double.self, forKey: .step)) ?? nil)
            total = GraphRuns.wholeNumber((try? c.decodeIfPresent(Double.self, forKey: .total)) ?? nil)
            nodeTitle = (try? c.decodeIfPresent(String.self, forKey: .nodeTitle)) ?? ""
        }
    }

    /// A question of an agent's ask card (runs/ask.js normalizeAskQuestions).
    struct AskQuestion: Decodable, Equatable {
        struct Option: Decodable, Equatable {
            let label: String
            let description: String
            private enum CodingKeys: String, CodingKey { case label, description }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
                description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
            }
        }
        let header: String
        let question: String
        let multiSelect: Bool
        let options: [Option]

        private enum CodingKeys: String, CodingKey { case header, question, multiSelect, options }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
            question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
            multiSelect = (try? c.decodeIfPresent(Bool.self, forKey: .multiSelect)) == true
            options = ((try? c.decodeIfPresent([Possible<Option>].self, forKey: .options)) ?? nil)?.compactMap(\.value) ?? []
        }
    }

    /// What is being waited for. Only `kind` is mandatory; without it there is no `wait`.
    struct Wait: Decodable, Equatable {
        let kind: String
        let question: String
        let requestId: String
        let questions: [AskQuestion]
        let tool: String
        let input: String
        let dynName: String
        let dynDescription: String

        private enum CodingKeys: String, CodingKey { case kind, question, requestId, questions, tool, input, dynName, dynDescription }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            question = (try? c.decodeIfPresent(String.self, forKey: .question)) ?? ""
            requestId = (try? c.decodeIfPresent(String.self, forKey: .requestId)) ?? ""
            questions = ((try? c.decodeIfPresent([Possible<AskQuestion>].self, forKey: .questions)) ?? nil)?.compactMap(\.value) ?? []
            tool = (try? c.decodeIfPresent(String.self, forKey: .tool)) ?? ""
            input = (try? c.decodeIfPresent(String.self, forKey: .input)) ?? ""
            dynName = (try? c.decodeIfPresent(String.self, forKey: .dynName)) ?? ""
            dynDescription = (try? c.decodeIfPresent(String.self, forKey: .dynDescription)) ?? ""
        }
    }

    /// An element that cannot be read drops out instead of taking the whole list with it.
    struct Possible<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    /// The client state. `loaded` false means "the route has not answered yet", NOT "no start" (empty is not
    /// unknown). `loading`: a request is in flight; events then ALSO go into `buffer` and are laid over the
    /// response afterwards (otherwise a message between request and response would be lost).
    struct Snapshot: Equatable {
        var loaded = false
        var loading = false
        var runs: [View] = []
        var buffer: [View] = []
    }

    /// Newest first (by `startedAt`); on equal time the existing order stays.
    private static func sorted(_ runs: [View]) -> [View] {
        runs.enumerated()
            .sorted { $0.element.startedAt != $1.element.startedAt ? $0.element.startedAt > $1.element.startedAt : $0.offset < $1.offset }
            .map(\.element)
    }

    /// Put a view into the list: it replaces the one with the same `startId`, a new one is inserted at the FRONT (so on equal
    /// `startedAt` it ends up on top, like `place` on the web).
    private static func place(_ runs: [View], _ run: View) -> [View] {
        var fresh = runs
        if let i = fresh.firstIndex(where: { $0.startId == run.startId }) { fresh[i] = run } else { fresh.insert(run, at: 0) }
        return sorted(fresh)
    }

    /// A request to the route begins (chat switch, connection): the shown state stays, events are remembered.
    static func loading(_ s: Snapshot) -> Snapshot {
        var fresh = s
        fresh.loading = true
        fresh.buffer = []
        return fresh
    }

    /// The request failed: not empty, the state stays as it was (the next connection asks again).
    static func failed(_ s: Snapshot) -> Snapshot {
        var fresh = s
        fresh.loading = false
        fresh.buffer = []
        return fresh
    }

    private struct Response: Decodable {
        let runs: [Possible<View>]
    }

    /// The route's response (JSON): its starts, with every event that arrived during the request laid over them. A response
    /// without a list changes nothing (it is not an empty one).
    static func loaded(_ s: Snapshot, response: Data?) -> Snapshot {
        guard let response, let a = try? JSONDecoder().decode(Response.self, from: response) else { return failed(s) }
        var runs = sorted(a.runs.compactMap(\.value))
        for l in s.buffer { runs = place(runs, l) }
        return Snapshot(loaded: true, loading: false, runs: runs, buffer: [])
    }

    /// A single view (response of the stop, `{ run }`) into the state, the same path as an event.
    static func including(_ s: Snapshot, run: View) -> Snapshot {
        var fresh = s
        fresh.runs = place(s.runs, run)
        if s.loading { fresh.buffer = s.buffer + [run] }
        return fresh
    }

    private struct Envelope: Decodable {
        let type: String?
        let subtype: String?
        let run: Possible<View>?
    }

    /// An event from the stream (JSON). Only `graph_run` counts; everything else leaves the state unchanged.
    static func afterEvent(_ s: Snapshot, event data: Data) -> Snapshot {
        guard let u = try? JSONDecoder().decode(Envelope.self, from: data),
              u.type == "harness", u.subtype == event, let run = u.run?.value else { return s }
        return including(s, run: run)
    }

    /// Which of the three rows above the input field is shown.
    enum Kind: Equatable {
        /// "starts when the turn ends", button "Cancel".
        case earmarked
        /// "waiting — {reason}", button "Cancel".
        case waitingLock
        /// "Worktree with changes stays: {path}", button "Hide" (in memory only, per `startId`).
        case worktreeStays
    }

    struct Row: Equatable {
        let kind: Kind
        let startId: String
        let name: String
        let state: String
        /// Filled only for `waitingLock` (empty if the server names no reason).
        let reason: String
        /// Filled only for `worktreeStays`.
        let path: String
    }

    /// The row above the input field, for foreground starts only (`background: false`): an OPEN start (earmarked,
    /// waiting_lock) takes precedence over a worktree hint, even a newer one; otherwise the newest finished start with a
    /// worktree. `hidden`: the `startId`s whose worktree row the human hid. An unknown state and
    /// `running`/`waiting`/`waiting_storage` yield no row (from `running` on the workflow strip shows the run). Without a
    /// name the short name is shown. Like `foregroundRow` on the web.
    static func foregroundRow(_ s: Snapshot, hidden: Set<String> = []) -> Row? {
        let front = s.runs.filter { !$0.background }
        if let l = front.first(where: { $0.state == "earmarked" || $0.state == "waiting_lock" }) {
            let name = l.name.isEmpty ? l.shortName : l.name
            return l.state == "earmarked"
                ? Row(kind: .earmarked, startId: l.startId, name: name, state: l.state, reason: "", path: "")
                : Row(kind: .waitingLock, startId: l.startId, name: name, state: l.state, reason: l.reason, path: "")
        }
        if let l = front.first(where: { toEnd.contains($0.state) && !$0.worktreePath.isEmpty && !hidden.contains($0.startId) }) {
            return Row(kind: .worktreeStays, startId: l.startId, name: l.name.isEmpty ? l.shortName : l.name, state: l.state, reason: "", path: l.worktreePath)
        }
        return nil
    }

    // MARK: - Card and response of a background run
    //
    // What the card under "Background Tasks" shows and which response it offers: the same computation as
    // `cardOf`/`responseForm`/`responseRequest` in web/src/lib/graph-runs.ts, bound in graph-runs-binding. Answers go
    // through the EXISTING routes on the child chat (`chatId`): `/message` (question, cap, review, completion, stop),
    // `/ask-answer`, `/permission-decision`, `/dyn-workflows/freigabe`. Foreground runs have no card, an unknown
    // wait kind has no form (only "Open").

    /// The tone of the card: blue = running, warning = waits for the human, calm = not started yet, then the outcomes.
    enum Tone: String, Equatable {
        case running, waiting, quiet, finished, error, muted
    }

    static let tone: [String: Tone] = [
        "running": .running, "waiting": .waiting, "earmarked": .quiet, "waiting_lock": .quiet, "waiting_storage": .quiet,
        "finished": .finished, "failed": .error, "stopped": .muted, "dismissed": .muted,
    ]

    /// Stoppable is whatever has not ended: earmarked, waiting, running.
    static let stoppable: Set<String> = ["earmarked", "waiting_lock", "waiting_storage", "waiting", "running"]

    /// The number on the cap button "{n} more", when the human picks none; the largest that gets sent.
    static let moreDefault = 2
    static let moreMax = 99

    /// A button: `id` = handle (`responseRequest`), `word` = key for `L(…)` with `params`, `send` = the word sent to the server.
    struct Button: Equatable {
        let id: String
        let word: String
        let params: [String: String]
        let send: String
    }

    struct Option: Equatable {
        let label: String
        let description: String
    }

    /// A question of the ask card as the form shows it: one button per option, multiple choice per `multiple`.
    struct QuestionForm: Equatable {
        let header: String
        let question: String
        let multiple: Bool
        let options: [Option]
    }

    /// The form per wait kind. `route` is the sub-route on the child chat, `placeholder` the key of the free-text field (empty =
    /// no free text), `requestId` empty where the kind carries none.
    struct Form: Equatable {
        let kind: String
        let route: String
        let requestId: String
        let buttons: [Button]
        let freeText: Bool
        let placeholder: String
        let questions: [QuestionForm]
    }

    /// The card. `stateWord`: key (an unknown state is shown raw); `row2`: reason or "{step}/{total}: {nodeTitle}" (empty =
    /// no row); `worktree`: the path (empty = none); `response`: `nil` = only "Open".
    struct Card: Equatable {
        let title: String
        let stateWord: String
        let tone: Tone
        let warningDot: Bool
        let row2: String
        let worktree: String
        let stop: Bool
        let response: Form?
    }

    /// What the human did in the form: a button (`button` = `id`, with the chosen number `n` for "more"), a free text, and for
    /// the ask card the chosen labels per question (`selection`) and one own text per question (`texts`, otherwise `text` goes to the first).
    struct Input: Equatable {
        var button: String? = nil
        var n: Int? = nil
        var text: String? = nil
        var selection: [[String]]? = nil
        var texts: [String]? = nil
    }

    /// One answer per question to `/ask-answer`.
    struct AskResponse: Encodable, Equatable {
        let selected: [String]
        let text: String
    }

    /// The body: a synthesized `Encodable` OMITS `nil` keys, so each route gets exactly its fields
    /// (`{text}`, `{requestId, answers}`, `{requestId, behavior}`, `{requestId, decision}`).
    struct Body: Encodable, Equatable {
        var text: String? = nil
        var requestId: String? = nil
        var answers: [AskResponse]? = nil
        var behavior: String? = nil
        var decision: String? = nil
    }

    /// `POST path` with `body`. The path is NOT pre-encoded: `APIClient.makeURL` encodes itself (otherwise `%252D`).
    struct Request: Equatable {
        let path: String
        let body: Body
    }

    /// The background runs of the state, the cards, in the state's order (newest first).
    static func backgroundRuns(_ s: Snapshot) -> [View] {
        s.runs.filter(\.background)
    }

    private static func button(_ id: String, _ word: String, _ send: String, _ params: [String: String] = [:]) -> Button {
        Button(id: id, word: word, params: params, send: send)
    }

    private static func moreButton(_ n: Int) -> Button { button("more", "{n} more", "more \(n)", ["n": String(n)]) }

    private static func questionsForm(_ questions: [AskQuestion]) -> [QuestionForm] {
        questions.map { q in
            QuestionForm(header: q.header, question: q.question, multiple: q.multiSelect,
                      options: q.options.filter { !$0.label.isEmpty }.map { Option(label: $0.label, description: $0.description) })
        }
    }

    /// The response form of a waiting run; `nil` if it is not waiting, `wait` is missing, the kind is unknown, or a card
    /// without `requestId` (permission, approval) could not be answered. Like `responseForm`.
    static func responseForm(_ run: View) -> Form? {
        guard run.state == "waiting", let w = run.wait else { return nil }
        func form(_ route: String, _ buttons: [Button], _ placeholder: String, _ questions: [QuestionForm] = []) -> Form {
            Form(kind: w.kind, route: route, requestId: w.requestId, buttons: buttons, freeText: !placeholder.isEmpty,
                 placeholder: placeholder, questions: questions)
        }
        switch w.kind {
        case "question": return form("message", [], "Answer …")
        case "cap": return form("message", [button("further", "Continue", "continue"), moreButton(moreDefault), button("complete", "Finish", "finish")], "")
        case "review": return form("message", [button("matches", "Looks good", "looks good")], "Remarks …")
        case "done", "stopped": return form("message", [button("further", "Continue", "continue")], "Instruction …")
        case "agent_ask": return form("ask-answer", [], "Own answer …", questionsForm(w.questions))
        case "permission":
            return w.requestId.isEmpty ? nil : form("permission-decision", [button("allow", "Allow", "allow"), button("reject", "Deny", "deny")], "")
        case "dyn_approval":
            return w.requestId.isEmpty ? nil : form("dyn-workflows/approval", [button("accept", "Accept", "accept"), button("reject", "Deny", "reject")], "")
        default: return nil
        }
    }

    /// The request for an input; `nil` if there is nothing to send: no form, no child chat, a foreign button, an empty free
    /// text (for the ask card: neither selection nor text) or free text where the form has none. A button takes precedence
    /// over a text; a selection that is no option drops; without multiple choice the first counts. Like `responseRequest`.
    static func responseRequest(_ run: View, _ input: Input) -> Request? {
        guard let f = responseForm(run), !run.chatId.isEmpty else { return nil }
        let path = "/api/chats/\(run.chatId)/\(f.route)"
        let text = (input.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if f.route == "ask-answer" {
            let answers: [AskResponse]
            if f.questions.isEmpty {
                // Without questions (a sparse view): the free text as the first answer.
                answers = [AskResponse(selected: [], text: text)]
            } else {
                answers = f.questions.enumerated().map { i, q in
                    let labels = Set(q.options.map(\.label))
                    var selected: [String] = []
                    let raw = (input.selection ?? []).indices.contains(i) ? input.selection![i] : []
                    for l in raw where labels.contains(l) && !selected.contains(l) { selected.append(l) }
                    let own = (input.texts ?? []).indices.contains(i) ? input.texts![i].trimmingCharacters(in: .whitespacesAndNewlines) : nil
                    return AskResponse(selected: q.multiple ? selected : Array(selected.prefix(1)), text: own ?? (i == 0 ? text : ""))
                }
            }
            guard answers.contains(where: { !$0.selected.isEmpty || !$0.text.isEmpty }) else { return nil }
            return Request(path: path, body: Body(requestId: f.requestId, answers: answers))
        }
        if let id = input.button, !id.isEmpty {
            guard let k = f.buttons.first(where: { $0.id == id }) else { return nil }
            let send: String
            if k.id == "more", let n = input.n, n >= 1 { send = "more \(min(n, moreMax))" } else { send = k.send }
            switch f.route {
            case "permission-decision": return Request(path: path, body: Body(requestId: f.requestId, behavior: send))
            case "dyn-workflows/approval": return Request(path: path, body: Body(requestId: f.requestId, decision: send))
            default: return Request(path: path, body: Body(text: send))
            }
        }
        guard f.freeText, !text.isEmpty else { return nil }
        return Request(path: path, body: Body(text: text))
    }

    private static func row2(_ run: View) -> String {
        if !run.reason.isEmpty { return run.reason }
        guard let run = run.run else { return "" }
        let count = run.step.map { step in run.total.map { "\(step)/\($0)" } ?? String(step) } ?? ""
        if !count.isEmpty && !run.nodeTitle.isEmpty { return "\(count): \(run.nodeTitle)" }
        return count.isEmpty ? run.nodeTitle : count
    }

    /// The card of a run; `nil` for a foreground run (strip and banner, no card). Like `cardOf`.
    static func cardOf(_ run: View) -> Card? {
        guard run.background else { return nil }
        let z = run.state
        return Card(
            title: run.name.isEmpty ? run.shortName : run.name,
            stateWord: stateWord[z] ?? z,
            tone: tone[z] ?? .muted,
            warningDot: z == "waiting",
            row2: row2(run),
            worktree: run.worktreePath,
            stop: stoppable.contains(z),
            response: responseForm(run)
        )
    }
}
