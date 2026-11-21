import Foundation

/// The running tasks of ONE conversation as ONE computation: the Swift twin of `web/src/lib/running-tasks.ts` (the work
/// row of Claude Code). Bound: `web/test/running-tasks-binding.test.mjs` compiles this file with `xcrun swiftc`, feeds
/// the same inputs through both versions and demands the same answer row by row. Hence ONLY Foundation, no SwiftUI, no
/// `L(…)`: the words here are the German keys, translated where they are displayed.
///
/// What counts, always BESIDE the main agent: a background subagent (not the foreground agent, which a call of the turn
/// waits for), a running dynamic workflow, a BACKGROUND graph workflow while it runs or waits (a foreground run has
/// strip and banner), a background command, a monitor, a wakeup. The pill in the run row (`RunIndicator`) says "N running tasks", its sheet (`RunningTasksSheet`) lists them.
///
/// Empty is not unknown: `workflowsLoaded == false` (the tree has not answered yet) ⇒ `complete == false`, the pill
/// says "at least …". A conversation without a workflow source passes an empty list with `workflowsLoaded: true`; there
/// "none" is known.
enum RunningTasks {
    enum Kind: String, Hashable, Sendable, CaseIterable {
        case agent, workflow, graph, command, monitor, wakeup
    }

    /// A subagent. `key`: the view's handle for "Open"; times in milliseconds, `nil` = unknown.
    struct AgentInput: Hashable, Sendable {
        let key: String
        let agentId: String
        let name: String
        let live: Bool
        let foreground: Bool
        let startedAt: Double?
        let parkedUntil: Double?
    }

    struct WorkflowInput: Hashable, Sendable {
        let runId: String
        let name: String
        let status: String
        let startedAt: Double?
    }

    /// A graph start as the run view carries it (`GraphRuns.View`).
    struct GraphInput: Hashable, Sendable {
        let startId: String
        let name: String
        let shortName: String
        let state: String
        let background: Bool
        let startedAt: Double?
    }

    /// A background command or monitor. Only a monitor carries `startedAt` (ms); `nil` = unknown.
    struct ItemInput: Hashable, Sendable {
        let taskId: String
        let description: String
        var startedAt: Double? = nil
    }

    /// The scheduled continuation; `at` 0 = none.
    struct Wakeup: Hashable, Sendable {
        let at: Double
        let reason: String
        let prompt: String
    }

    struct Input: Hashable, Sendable {
        var agents: [AgentInput]
        var workflows: [WorkflowInput]
        var workflowsLoaded: Bool
        var commands: [ItemInput]
        var monitors: [ItemInput]
        var wakeup: Wakeup
        /// The chat's graph starts; empty = none.
        var graphRuns: [GraphInput] = []
        /// Has the graph-starts route answered? `false` ⇒ incomplete, like `workflowsLoaded`.
        var graphLoaded: Bool = true
    }

    /// States of a background graph run that count as a running task. Like `GRAPH_TASK_STATES`.
    static let graphTaskStates: Set<String> = ["running", "waiting", "waiting_lock", "waiting_storage"]

    /// An entry. Empty `name` = no description. `since`: start (ms), `nil` for commands and monitors (the server reports
    /// none). `until`: wake time or "waits until" of a parked agent. `reference`: the server's handle for the stop;
    /// `anchor`: the view's handle for "Open".
    struct Item: Hashable, Sendable, Identifiable {
        let kind: Kind
        let key: String
        let name: String
        let since: Double?
        let until: Double?
        let reference: String
        let anchor: String
        let reason: String
        let prompt: String
        var id: String { key }
    }

    struct Result: Hashable, Sendable {
        var item: [Item]
        var complete: Bool
        static let empty = Result(item: [], complete: true)
    }

    private static func time(_ v: Double?) -> Double? {
        guard let v, v.isFinite, v > 0 else { return nil }
        return v
    }

    /// The list in a fixed order of kinds (agent, workflow, graph, command, monitor, wakeup), within a kind in input
    /// order; every entry EXACTLY ONCE (same key ⇒ the first counts). Like `runningTasks`.
    static func compute(_ e: Input) -> Result {
        var item: [Item] = []
        var seen = Set<String>()
        func alongside(_ p: Item) {
            guard !seen.contains(p.key) else { return }
            seen.insert(p.key)
            item.append(p)
        }
        for (i, a) in e.agents.enumerated() where a.live && !a.foreground {
            let id = !a.agentId.isEmpty ? a.agentId : !a.key.isEmpty ? a.key : String(i)
            alongside(Item(kind: .agent, key: "agent:\(id)", name: a.name, since: time(a.startedAt), until: time(a.parkedUntil),
                        reference: a.agentId, anchor: a.key.isEmpty ? a.agentId : a.key, reason: "", prompt: ""))
        }
        for w in e.workflows where w.status == "running" && !w.runId.isEmpty {
            alongside(Item(kind: .workflow, key: "workflow:\(w.runId)", name: w.name, since: time(w.startedAt), until: nil,
                        reference: w.runId, anchor: w.runId, reason: "", prompt: ""))
        }
        for g in e.graphRuns where g.background && !g.startId.isEmpty && graphTaskStates.contains(g.state) {
            alongside(Item(kind: .graph, key: "graph:\(g.startId)", name: g.name.isEmpty ? g.shortName : g.name, since: time(g.startedAt),
                        until: nil, reference: g.startId, anchor: g.startId, reason: "", prompt: ""))
        }
        for (i, b) in e.commands.enumerated() {
            alongside(Item(kind: .command, key: "command:\(b.taskId.isEmpty ? String(i) : b.taskId)", name: b.description,
                        since: nil, until: nil, reference: b.taskId, anchor: "", reason: "", prompt: ""))
        }
        for (i, m) in e.monitors.enumerated() {
            alongside(Item(kind: .monitor, key: "monitor:\(m.taskId.isEmpty ? String(i) : m.taskId)", name: m.description,
                        since: time(m.startedAt), until: nil, reference: m.taskId, anchor: "", reason: "", prompt: ""))
        }
        if time(e.wakeup.at) != nil {
            alongside(Item(kind: .wakeup, key: "wakeup", name: "", since: nil, until: e.wakeup.at, reference: "wakeup", anchor: "",
                        reason: e.wakeup.reason, prompt: e.wakeup.prompt))
        }
        return Result(item: item, complete: e.workflowsLoaded && e.graphLoaded)
    }

    /// The pill's wording as a key with a number; `nil` if nothing is known to run. Incomplete ⇒ "at least".
    static func pillsText(_ t: Result) -> (key: String, n: Int)? {
        let n = t.item.count
        guard n > 0 else { return nil }
        if t.complete { return (n == 1 ? "1 running task" : "{n} running tasks", n) }
        return (n == 1 ? "at least 1 running task" : "at least {n} running tasks", n)
    }

    enum Part: String, Hashable, Sendable {
        case hex, time, pill, word
    }

    /// The parts of the run row in the original's order: [hexagon] "12s · 5k tokens" [pill] "Thinking…".
    /// `running`: `HistoryState.runRowVisible`; `time`: the run start is known. Without a run but with tasks:
    /// only hexagon (resting) and pill. Empty = no row.
    static func rowsParts(running: Bool, time: Bool, tasks: Int) -> [Part] {
        if !running && tasks <= 0 { return [] }
        var parts: [Part] = [.hex]
        if running && time { parts.append(.time) }
        if tasks > 0 { parts.append(.pill) }
        if running { parts.append(.word) }
        return parts
    }

    /// The word per kind, a German key.
    static let kindWord: [Kind: String] = [
        .agent: "Subagent",
        .workflow: "Workflow",
        .graph: "Graph workflow",
        .command: "Background command",
        .monitor: "Monitor",
        .wakeup: "Alarm",
    ]

    /// Is there a human stop? Today for subagent (`POST …/agent/stop`), workflow (`POST …/dyn-workflows/runs/:runId/stop`),
    /// graph workflow (`POST …/graph-workflows/:startId/stop` on the start's chat), monitor (`POST …/monitor/stop`) and wakeup (`POST …/wakeup/stop`, `from: "human"`; it belongs to the
    /// chat, server runs/wakeup.js); commands have none. Like `hasStop`.
    static func hasStop(_ p: Item) -> Bool {
        (p.kind == .agent || p.kind == .workflow || p.kind == .graph || p.kind == .monitor || p.kind == .wakeup) && !p.reference.isEmpty
    }
}
