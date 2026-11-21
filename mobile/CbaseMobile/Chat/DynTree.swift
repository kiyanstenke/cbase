import Foundation

// The progress tree of a dynamic workflow as a pure computation — the iOS revision of
// `web/src/lib/dyn-tree.ts`. Foundation only, no SwiftUI: `web/test/dyn-tree-binding.test.mjs` assembles this file
// with `HistoryState.swift` and a driver into one program, runs it with `xcrun swift` and
// requires for the same inputs (answers of the route, `dynwf_tree` events) step by step the same state
// and the same model as the web. Whoever changes something here changes it over there too — otherwise the gate is red.
//
// The server delivers ONE view per run (dynworkflows/tree.js treeView, route `GET /api/chats/:id/dyn-workflows/tree`
// and event `dynwf_tree`): head, phases, the agents FLAT with phase and journal state, the log() rows. From it
// arise here the bands (one per phase), n/m and per agent the display word via the bound table
// (`HistoryState.journalAgent`). The sheet (`Chat/DynWorkflowTree.swift`) computes none of it itself.
//
// The view follows Claude Code's model: phases as cards with one tile per agent, inside the
// table agent · model · tokens · time. Hence also n/m per phase (`Band.finished`), the default "open" per phase
// (`bandDefaultOpen`), the tile kind (`tileKind`), the times (`agentDurationMs`, `runDurationMs`, `durationShort`), the
// token sum (`runTokens`) and the short name of the model (`modelShortName`) — the same functions as on the web.
//
// Decoding is LENIENT: a synthesized `Decodable` demands every key, and a missing field (no
// tokens, no log() rows, an older server) would otherwise make the whole tree unreadable. Only `runId` and
// the list `agents` are mandatory — the same check as `isRun` on the web.
//
// Also the WAIT REASON as text (`waitText` per row, `bandWaitText` per phase — a phase with
// six dashed circles raised the question whether it was skipped; the cap per run was 2): the number comes from the server
// (`Run.cap`, only on the running run), the kind from the journal (`Agent.cap`); if one is missing the text stands without a number. The
// number stands FIRST in the short version ("waiting · 8 per user", not "waiting · user cap 8" — shortened, exactly
// the number would drop). Which reasons and kinds exist is told by the web (`WAIT_REASONS`, `CAP_KINDS`): the binding generates from them
// the flow "wait reason visible"; a reason without its own case in `waitText`/`revision` is red there.
//
// The words from `runWord` and `waitText` are keys for `L(…)` (Kit/LocDE*.swift); `loc-audit.sh`
// sees only literal calls, so the binding checks that every word is translated.
enum DynTree {
    /// The event in the chat's stream (harness subtype) — not "workflow…": that is the graph.
    static let event = "dynwf_tree"

    struct Agent: Decodable, Equatable {
        /// The number of the agent() call in the run (1…).
        let n: Int
        let label: String
        let phase: String?
        /// Journal state: running · waiting · finished · error · skipped · stopped · without-result.
        let status: String
        /// Only for "waiting": cap · storage · stagger · limit · credit-gate · project.
        let reason: String?
        /// Only for reason "cap": the cap that held it at admission (journal) — run · user. The number stands on the run.
        let cap: String?
        let provider: String
        let model: String
        let agentId: String
        let tokens: Int?
        let tokenKind: String?
        let fromCache: Bool
        /// Restarts by the human — 0 without.
        let restarts: Int
        /// First start of its process (ms) — `nil` while it waits, and for a result from the journal.
        let startedAt: Double?
        /// Its end (ms) — `nil` while it runs or waits.
        let endedAt: Double?

        private enum CodingKeys: String, CodingKey { case n, label, phase, status, reason, cap, provider, model, agentId, tokens, tokenKind, fromCache, restarts, startedAt, endedAt }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            n = (try? c.decodeIfPresent(Int.self, forKey: .n)) ?? 0
            label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
            phase = try? c.decodeIfPresent(String.self, forKey: .phase)
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
            reason = try? c.decodeIfPresent(String.self, forKey: .reason)
            cap = try? c.decodeIfPresent(String.self, forKey: .cap)
            provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
            model = (try? c.decodeIfPresent(String.self, forKey: .model)) ?? ""
            agentId = (try? c.decodeIfPresent(String.self, forKey: .agentId)) ?? ""
            tokens = try? c.decodeIfPresent(Int.self, forKey: .tokens)
            tokenKind = try? c.decodeIfPresent(String.self, forKey: .tokenKind)
            fromCache = (try? c.decodeIfPresent(Bool.self, forKey: .fromCache)) == true
            restarts = (try? c.decodeIfPresent(Int.self, forKey: .restarts)) ?? 0
            startedAt = try? c.decodeIfPresent(Double.self, forKey: .startedAt)
            endedAt = try? c.decodeIfPresent(Double.self, forKey: .endedAt)
        }
    }

    /// The numbers of the caps that apply NOW (dynworkflows/cap.js) — only on the running run. Lenient: whatever
    /// is not a whole number is missing (like `wholeNumber` on the web; the lower bound 1 is checked by `waitText`).
    struct Cap: Decodable, Equatable {
        let run: Int?
        let user: Int?

        private enum CodingKeys: String, CodingKey { case run, user }

        init(run: Int? = nil, user: Int? = nil) {
            self.run = run
            self.user = user
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            run = try? c.decodeIfPresent(Int.self, forKey: .run)
            user = try? c.decodeIfPresent(Int.self, forKey: .user)
        }
    }

    struct LogRow: Decodable, Equatable {
        let text: String
        let phase: String?
        let at: Double

        private enum CodingKeys: String, CodingKey { case text, phase, at }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            phase = try? c.decodeIfPresent(String.self, forKey: .phase)
            at = (try? c.decodeIfPresent(Double.self, forKey: .at)) ?? 0
        }
    }

    struct Run: Decodable, Equatable {
        let runId: String
        let name: String
        /// running · finished · stopped · failed · interrupted
        let status: String
        let stoppedOf: String
        /// The current phase: the last phase() row of the script, `nil` before the first.
        let phase: String?
        let phases: [String]
        let agents: [Agent]
        let logs: [LogRow]
        /// So many older log() rows were left out by the server (cap).
        let logsTruncated: Int
        let warning: String?
        /// Start and end of the run (ms) — `nil` in a sparse view; `endedAt` also while it runs.
        let startedAt: Double?
        let endedAt: Double?
        /// meta.description — empty without (an older server delivers none).
        let description: String
        /// The caps that apply now — `nil` on a finished run and with an older server.
        let cap: Cap?

        private enum CodingKeys: String, CodingKey { case runId, name, status, stoppedOf, phase, phases, agents, logs, logsTruncated, warning, startedAt, endedAt, description, cap }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // Mandatory like `isRun` on the web: without run id and agent list it is no run.
            runId = try c.decode(String.self, forKey: .runId)
            agents = try c.decode([Possible<Agent>].self, forKey: .agents).compactMap(\.value)
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
            status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
            stoppedOf = (try? c.decodeIfPresent(String.self, forKey: .stoppedOf)) ?? ""
            phase = try? c.decodeIfPresent(String.self, forKey: .phase)
            phases = ((try? c.decodeIfPresent([Possible<String>].self, forKey: .phases)) ?? []).compactMap(\.value)
            logs = ((try? c.decodeIfPresent([Possible<LogRow>].self, forKey: .logs)) ?? []).compactMap(\.value)
            logsTruncated = (try? c.decodeIfPresent(Int.self, forKey: .logsTruncated)) ?? 0
            warning = try? c.decodeIfPresent(String.self, forKey: .warning)
            startedAt = try? c.decodeIfPresent(Double.self, forKey: .startedAt)
            endedAt = try? c.decodeIfPresent(Double.self, forKey: .endedAt)
            description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? ""
            cap = try? c.decodeIfPresent(Cap.self, forKey: .cap)
        }
    }

    /// An element that cannot be read drops out instead of taking the whole list with it.
    struct Possible<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }

    /// The state of the tree in the client. `loaded` false means "the route has not answered yet" — NOT "without
    /// workflow" (empty is not unknown). `loading`: a request is in flight, events then go ALSO into `buffer`
    /// and are laid over after the answer (otherwise a message between request and answer would be lost).
    struct Snapshot: Equatable {
        var loaded = false
        var loading = false
        var runs: [Run] = []
        /// So many older runs are not shown by the route (cap).
        var additional = 0
        var buffer: [Run] = []
    }

    /// Put a run into the list: replaces the one with the same run id in its place, a new one goes first (newest first).
    private static func place(_ runs: [Run], _ run: Run) -> [Run] {
        guard let i = runs.firstIndex(where: { $0.runId == run.runId }) else { return [run] + runs }
        var fresh = runs
        fresh[i] = run
        return fresh
    }

    /// A request to the route begins (open, reconnect): the shown state stays, events are remembered.
    static func loading(_ s: Snapshot) -> Snapshot {
        var fresh = s
        fresh.loading = true
        fresh.buffer = []
        return fresh
    }

    /// The request failed: not empty — the state stays as it was (the next reconnect asks again).
    static func failed(_ s: Snapshot) -> Snapshot {
        var fresh = s
        fresh.loading = false
        fresh.buffer = []
        return fresh
    }

    private struct Response: Decodable {
        let runs: [Possible<Run>]
        let additional: Int
        private enum CodingKeys: String, CodingKey { case runs, additional }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            runs = try c.decode([Possible<Run>].self, forKey: .runs)
            additional = (try? c.decodeIfPresent(Int.self, forKey: .additional)) ?? 0
        }
    }

    /// The answer of the route (JSON): its runs, above them every event that arrived during the request. An answer without
    /// a list changes nothing (it is not an empty one).
    static func loaded(_ s: Snapshot, response: Data?) -> Snapshot {
        guard let response, let a = try? JSONDecoder().decode(Response.self, from: response) else { return failed(s) }
        var runs = a.runs.compactMap(\.value)
        for l in s.buffer { runs = place(runs, l) }
        return Snapshot(loaded: true, loading: false, runs: runs, additional: a.additional, buffer: [])
    }

    private struct Envelope: Decodable {
        let type: String?
        let subtype: String?
        let tree: Possible<Run>?
    }

    /// An event from the stream (JSON). Only `dynwf_tree` counts; everything else leaves the state unchanged.
    static func afterEvent(_ s: Snapshot, event data: Data) -> Snapshot {
        guard let u = try? JSONDecoder().decode(Envelope.self, from: data),
              u.type == "harness", u.subtype == event, let run = u.tree?.value else { return s }
        var fresh = s
        fresh.runs = place(s.runs, run)
        if s.loading { fresh.buffer = s.buffer + [run] }
        return fresh
    }

    /// Does the chat carry a workflow? `nil` = not loaded yet — NOT "no".
    static func carriesWorkflow(_ s: Snapshot) -> Bool? {
        if !s.runs.isEmpty { return true }
        return s.loaded ? false : nil
    }

    /// The running workflow agents of all running runs (the dot on the agents button). Waiting ones do not run.
    static func runningWorkflowAgents(_ s: Snapshot) -> Int {
        s.runs.filter { $0.status == "running" }.reduce(0) { $0 + $1.agents.filter { $0.status == "running" }.count }
    }

    struct Row: Equatable {
        let agent: Agent
        /// The display word from the bound table; `nil` means finished.
        let state: HistoryState.Agent?
    }

    /// A phase without an agent() call (twin of `BandEmpty` in web/src/lib/dyn-tree.ts): `running` = the current one,
    /// still without agents; `withoutAgents` = already passed; `pending` = still to come; `notReached` = the run ended before it.
    enum Empty: String, Equatable {
        case running, withoutAgents = "without_agents", pending, notReached = "not_reached"

        /// The word (key for `L`) — the same as `BAND_EMPTY_WORD` on the web.
        var word: String {
            switch self {
            case .running: return "running"
            case .withoutAgents: return "no agents"
            case .pending: return "pending"
            case .notReached: return "not reached"
            }
        }
    }

    struct Band: Equatable {
        /// `nil` = the band of the agents without a phase (stands last).
        let title: String?
        let rows: [Row]
        /// n of the card's n/m: "finished" as at the head; m is the rows.
        let finished: Int
        /// Stands at exactly one phase without rows.
        var empty: Empty? = nil
    }

    struct Header: Equatable {
        let runId: String
        let name: String
        let phase: String?
        /// n/m: n = agents with a result (only "finished" — skipped, failed, stopped do NOT count), m = agent() calls.
        let finished: Int
        let started: Int
        let status: String
        let running: Bool
        let stoppedOf: String
        let logs: [LogRow]
        let logsTruncated: Int
        /// Empty is not a warning.
        let warning: String?
        /// meta.description, trimmed — empty without.
        let description: String
    }

    /// What the sheet shows of ONE run: head and bands (one per phase, in the order of the phases — also those
    /// in which no agent ran yet, with `empty`; agents without a phase in the last band without a title), per agent the display word.
    static func model(_ run: Run) -> (header: Header, bands: [Band]) {
        let rows = run.agents.map { Row(agent: $0, state: HistoryState.journalAgent(status: $0.status)) }
        var title = run.phases
        for z in rows { if let p = z.agent.phase, !title.contains(p) { title.append(p) } }
        let finished = { (rowList: [Row]) in rowList.filter { $0.agent.status == "finished" }.count }
        let running = run.status == "running"
        let current = run.phase.flatMap { title.firstIndex(of: $0) } ?? -1
        // How far the run got: the current phase or the last one with an agent, whichever lies further back.
        let reached = title.indices.reduce(current) { m, i in rows.contains { $0.agent.phase == title[i] } ? max(m, i) : m }
        var bands: [Band] = title.indices.map { i in
            let t = title[i]
            let inside = rows.filter { $0.agent.phase == t }
            if !inside.isEmpty { return Band(title: t, rows: inside, finished: finished(inside)) }
            let empty: Empty = i == current && running ? .running : i <= reached ? .withoutAgents : running ? .pending : .notReached
            return Band(title: t, rows: [], finished: 0, empty: empty)
        }
        let without = rows.filter { $0.agent.phase == nil }
        if !without.isEmpty { bands.append(Band(title: nil, rows: without, finished: finished(without))) }
        let header = Header(
            runId: run.runId,
            name: run.name,
            phase: run.phase,
            finished: run.agents.filter { $0.status == "finished" }.count,
            started: run.agents.count,
            status: run.status,
            running: run.status == "running",
            stoppedOf: run.stoppedOf,
            logs: run.logs,
            logsTruncated: run.logsTruncated,
            warning: (run.warning ?? "").isEmpty ? nil : run.warning,
            description: run.description.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        return (header, bands)
    }

    /// Does a phase card stand open by itself? Only in the running run and only while something runs or waits in it —
    /// the running phase open, a finished one closed. The human's choice goes first (the view holds it). As on the web.
    static func bandDefaultOpen(_ band: Band, runRunning: Bool) -> Bool {
        runRunning && band.rows.contains { $0.agent.status == "running" || $0.agent.status == "waiting" }
    }

    /// The tile of an agent (colored by state): running (blue) · finished (green) · waiting (gray
    /// outlined) · error (red) · aborted (amber: stopped, without result) · muted (skipped, unknown).
    /// Twin: web `tileKind` in `lib/dyn-tree.ts`.
    static func tileKind(_ status: String) -> String {
        switch status {
        case "running", "finished", "waiting", "error": return status
        case "stopped", "without-result": return "aborted"
        default: return "muted"
        }
    }

    /// The time of ONE agent in ms: first start to end; without an end until `now` in a running run, else until the end of the
    /// run. `nil` = never started — the column then shows a dash.
    static func agentDurationMs(_ a: Agent, run: Run, now: Double) -> Double? {
        guard let start = a.startedAt else { return nil }
        let end: Double? = a.endedAt ?? (run.status == "running" ? now : run.endedAt)
        guard let end else { return nil }
        return max(0, end - start)
    }

    /// The runtime of the workflow in ms — until `now` while it runs; `nil` without a start time or without the end of a finished one.
    static func runDurationMs(_ run: Run, now: Double) -> Double? {
        guard let start = run.startedAt, start > 0 else { return nil }
        guard let end = run.status == "running" ? now : run.endedAt else { return nil }
        return max(0, end - start)
    }

    /// The tokens of the whole run: sum of the reported numbers, lower bound ("only_output") as soon as one of them is not reported as
    /// complete ("full"); `nil` if no agent carries a number.
    static func runTokens(_ run: Run) -> (tokens: Int, tokenKind: String)? {
        let counted = run.agents.filter { $0.tokens != nil }
        guard !counted.isEmpty else { return nil }
        let sum = counted.reduce(0) { $0 + ($1.tokens ?? 0) }
        return (sum, counted.allSatisfy { $0.tokenKind == "full" } ? "full" : "only_output")
    }

    /// The model for the narrow column: without provider, without router path, without doubled prefix ("claude" +
    /// "claude-opus-5-5" → "opus-5-5"); without a model (or with a placeholder in brackets) the provider.
    static func modelShortName(provider: String, model: String) -> String {
        let m = model.hasPrefix("(") ? "" : model
        if m.isEmpty { return provider }
        let name = m.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? m
        let prefix = "\(provider)-"
        return !provider.isEmpty && name.hasPrefix(prefix) && name.count > prefix.count ? String(name.dropFirst(prefix.count)) : name
    }

    /// Runtime short for the column: m:ss, from one hour h:mm:ss — like `durationShort` in web/src/lib/agents.ts.
    static func durationShort(_ ms: Double) -> String {
        let s = max(0, Int((ms / 1000).rounded()))
        let two = { (n: Int) in String(format: "%02d", n) }
        if s < 3600 { return "\(s / 60):\(two(s % 60))" }
        return "\(s / 3600):\(two((s % 3600) / 60)):\(two(s % 60))"
    }

    /// The word for the outcome of a run at the head — a key for `L(…)`.
    static func runWord(_ status: String) -> String {
        switch status {
        case "running": return "running"
        case "finished": return "done"
        case "stopped": return "stopped"
        case "failed": return "failed"
        case "interrupted": return "interrupted"
        default: return status
        }
    }

    /// The two handles on ONE agent row — twin of `agentHandles` in web/src/lib/dyn-tree.ts
    /// (bound in web/test/dyn-tree-binding.test.mjs): only in the running run and only on a started agent;
    /// skip while it runs or is parked at the limit, restart only mid-attempt. No "stop per agent".
    static func handles(_ agent: Agent, runRunning: Bool) -> (skip: Bool, restart: Bool) {
        let started = runRunning && !agent.agentId.isEmpty
        return (started && (agent.status == "running" || agent.status == "waiting"), started && agent.status == "running")
    }

    /// What a waiting agent waits for, as text — twin of `WaitText` in web/src/lib/dyn-tree.ts, bound
    /// in web/test/dyn-tree-binding.test.mjs. Three revisions, each a key for `L(…, values)`: `short` in the row, `lang` at the
    /// phase head, read aloud and in the "message" sheet, `explanation` as a hint. `n` = the number of the cap that holds (only if
    /// kind AND number are known), `reason` an unknown reason verbatim.
    struct WaitText: Equatable {
        let short: String
        let lang: String
        let explanation: String
        let n: Int?
        let reason: String?

        var values: [String: CustomStringConvertible] {
            var w: [String: CustomStringConvertible] = [:]
            if let n { w["n"] = n }
            if let reason { w["reason"] = reason }
            return w
        }
    }

    /// The texts per revision — short, long, explanation; verbatim identical with `WAIT_TEXTS` on the web.
    private static func revision(_ f: String, n: Int? = nil, reason: String? = nil) -> WaitText {
        let t: (String, String, String)
        switch f {
        case "run": t = ("waiting · {n} at a time", "waiting for a free slot · {n} at a time",
                          "Cap per workflow: {n} at a time. The agent starts as soon as a slot frees up.")
        case "user": t = ("waiting · {n} per user", "waiting for a free slot · {n} per user",
                            "Cap across all workflows: {n} at a time (setting “Concurrent workflow agents”). The agent starts as soon as a slot frees up.")
        case "cap": t = ("waiting for a slot", "waiting for a free slot", "All slots are taken — the agent starts as soon as one frees up.")
        case "stagger": t = ("waiting · prompt cache", "waiting for the prompt cache",
                             "Agents with the same model start staggered: the first writes the prompt cache, the others read it afterwards.")
        case "limit": t = ("waiting · limit", "waiting at the usage limit", "The provider is at its usage limit — it continues after the reset.")
        case "credit-gate": t = ("waiting · credit gate", "waiting at the credit gate",
                                   "The credit gate holds back new starts — the agent starts after the window resets.")
        case "project": t = ("waiting · project", "waiting for the project", "The project's container is not ready yet — the agent starts as soon as it is.")
        case "storage": t = ("waiting · memory", "waiting for free memory",
                              "Memory is tight (container above 80 % of its limit or host below 20 % free) — the agents start one after another as soon as there is room again.")
        case "without": t = ("waiting", "waiting", "waiting")
        default: t = ("waiting · {reason}", "waiting · {reason}", "waiting · {reason}")
        }
        return WaitText(short: t.0, lang: t.1, explanation: t.2, n: n, reason: reason)
    }

    /// The wait reason of ONE row — `nil` if the agent does not wait. With reason "cap" with a number only if the kind
    /// (journal) AND its number (on the run, whole and ≥ 1) are known; otherwise without a number. Like `waitText` on the web.
    static func waitText(_ agent: Agent, cap: Cap?) -> WaitText? {
        guard agent.status == "waiting" else { return nil }
        let reason = agent.reason ?? ""
        switch reason {
        case "cap":
            let n: Int? = agent.cap == "run" ? cap?.run : agent.cap == "user" ? cap?.user : nil
            if let n, n >= 1, let kind = agent.cap { return revision(kind, n: n) }
            return revision("cap")
        case "stagger", "limit", "credit-gate", "project", "storage": return revision(reason)
        case "": return revision("without")
        default: return revision("otherwise", reason: reason)
        }
    }

    /// The wait reason at the head of a PHASE: only in the running run, only if something waits in it and nothing runs — then that of the
    /// first waiting one (the one that starts next). Like `bandWaitText` on the web.
    static func bandWaitText(_ band: Band, runRunning: Bool, cap: Cap?) -> WaitText? {
        guard runRunning, !band.rows.contains(where: { $0.agent.status == "running" }) else { return nil }
        guard let first = band.rows.first(where: { $0.agent.status == "waiting" }) else { return nil }
        return waitText(first.agent, cap: cap)
    }

    /// "provider::model" — like `modelText` on the web (a placeholder in brackets is no model).
    static func modelText(provider: String, model: String) -> String {
        let m = model.hasPrefix("(") ? "" : model
        if !m.isEmpty && !provider.isEmpty { return "\(provider)::\(m)" }
        return m.isEmpty ? provider : m
    }
}
