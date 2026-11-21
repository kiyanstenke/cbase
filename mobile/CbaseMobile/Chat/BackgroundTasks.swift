// The ONE "Background Tasks" list in a chat's agent sheet — the ordering as pure computation. Twin of
// web/src/lib/background-tasks.ts, bound in web/test/background-tasks-binding.test.mjs (both sides REALLY executed: tsc and
// xcrun swiftc). Imports only Foundation and translates nothing (no L(…)) — otherwise it could not be run on its own there.
//
// The rule (in detail at the top of the web file): NEWEST FIRST, subagents and workflow runs mixed. The item's own start time
// counts where there is one (a running subagent from the stream, every workflow run); an item without a time (a finished
// subagent from the timeline) counts as at least as new as everything that arrived in the timeline BEFORE it, and on a tie the
// later arrival is on top. What the timeline does not know comes after all known ones, in input order: first subagents without
// a time, then the runs from old to new, then the background graph workflows from old to new — they always carry their start
// time; outer-loop runs do not belong here —, last subagents with a time.
import Foundation

enum BackgroundTasks {
    /// An item of the list: key (`agent:<block id>`, `workflow:<run id>` or `graph:<startId>`) and its own start time in ms.
    struct Source: Equatable {
        let key: String
        let start: Double?
    }

    /// A timeline row, as far as it counts for arrival: its subagent calls (top level) and the run id if it is a workflow's
    /// START marker.
    struct SequenceRow: Equatable {
        let agents: [String]
        let workflowStart: String?
    }

    static func agentKey(_ id: String) -> String { "agent:\(id)" }
    static func workflowKey(_ runId: String) -> String { "workflow:\(runId)" }
    static func graphKey(_ startId: String) -> String { "graph:\(startId)" }

    private static func time(_ v: Double?) -> Double? {
        guard let v, v.isFinite, v > 0 else { return nil }
        return v
    }

    /// The arrival order from the timeline. Every key once (the first counts), empty ids do not count.
    static func followUp(_ rows: [SequenceRow]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()
        func alongside(_ s: String) { if seen.insert(s).inserted { out.append(s) } }
        for z in rows {
            for id in z.agents where !id.isEmpty { alongside(agentKey(id)) }
            if let run = z.workflowStart, !run.isEmpty { alongside(workflowKey(run)) }
        }
        return out
    }

    /// The core: the inputs' indices in display order (newest first).
    static func arrange(_ inputs: [Source], followUp: [String]) -> [Int] {
        var pos: [String: Int] = [:]
        for (i, s) in followUp.enumerated() where pos[s] == nil { pos[s] = i }
        let idx = Array(inputs.indices)
        let place = { (i: Int) -> Int in pos[inputs[i].key] ?? Int.max }
        let arrival = idx.sorted { a, b in
            let sa = place(a), sb = place(b)
            return sa != sb ? sa < sb : a < b
        }
        var eff = [Double](repeating: -.infinity, count: inputs.count)
        var rank = [Int](repeating: 0, count: inputs.count)
        var last = -Double.infinity
        for (k, i) in arrival.enumerated() {
            let s = time(inputs[i].start)
            if let s, s > last { last = s }
            eff[i] = s ?? last
            rank[i] = k
        }
        return idx.sorted { a, b in
            eff[a] != eff[b] ? eff[a] > eff[b] : rank[a] > rank[b]
        }
    }

    /// The sheet's list: keys in display order. `agents` in the order of the subagent list (`ChatViewModel.subagents`), `runs` in
    /// the order of the tree (newest first, `DynTree`), `graph` in the order of the graph-start state (newest first,
    /// `GraphRuns.backgroundRuns`). Every key once.
    static func list(agents: [Source], runs: [Source], graph: [Source] = [], followUp: [String]) -> [String] {
        var inputs: [Source] = []
        var seen = Set<String>()
        func alongside(_ q: Source) { if seen.insert(q.key).inserted { inputs.append(q) } }
        for a in agents where time(a.start) == nil { alongside(a) }
        for l in runs.reversed() { alongside(l) }
        for g in graph.reversed() { alongside(g) }
        for a in agents where time(a.start) != nil { alongside(a) }
        return arrange(inputs, followUp: followUp).map { inputs[$0].key }
    }
}
