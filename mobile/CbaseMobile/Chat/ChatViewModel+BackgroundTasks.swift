import Foundation

// The ONE "Background Tasks" list of this chat — twin of web/src/components/chat/chatBackgroundTasks.ts (computation in
// web/src/lib/bg-list.ts). ONE place computes the list; the sheet shows it, the header button shows its dot while
// `backgroundRunning > 0`.
//
// The kinds (same as on the web): subagent, dynamic workflow, background graph workflow; without a start time under
// "Running": background commands, monitors, the wakeup timer. Ordered via `BackgroundTasks.list` (bound to the web). Outer
// Loop runs do NOT belong here — they have their own area (chat info).
extension ChatViewModel {

    /// An entry of the list with its key (`agent:<block id>`, `workflow:<run id>`, `graph:<startId>`).
    enum BgTask: Identifiable {
        case agent(SubagentEntry, String)
        case workflow(DynTree.Run, String)
        case graph(GraphRuns.View, String)
        var id: String {
            switch self {
            case .agent(_, let s), .workflow(_, let s), .graph(_, let s): return s
            }
        }
        /// Is the entry still running? Same split as on the web (lib/bg-list.ts) — the dot on the button counts from it.
        var running: Bool {
            switch self {
            case .agent(let e, _): return e.running
            case .workflow(let l, _): return l.status == "running"
            case .graph(let l, _): return GraphRuns.stoppable.contains(l.state)
            }
        }
    }

    /// The list in display order: newest on top, mixed. Runs and graph workflows only in the coding chat.
    func backgroundList(_ list: [SubagentEntry]) -> [BgTask] {
        var byId: [String: BgTask] = [:]
        // Per key, the entry the ordering keeps: the first in collection order of `BackgroundTasks.list` (as on the web).
        func remember(_ t: BgTask) { if byId[t.id] == nil { byId[t.id] = t } }
        let agents = list.map { e -> (BackgroundTasks.Source, BgTask) in
            let s = BackgroundTasks.agentKey(e.blockId ?? e.id)
            return (BackgroundTasks.Source(key: s, start: e.startedAt.map { $0.timeIntervalSince1970 * 1000 }), .agent(e, s))
        }
        let runs = (withDynWorkflows ? dynTree.runs : []).map { l -> (BackgroundTasks.Source, BgTask) in
            let s = BackgroundTasks.workflowKey(l.runId)
            return (BackgroundTasks.Source(key: s, start: l.startedAt), .workflow(l, s))
        }
        let graph = graphCards.map { l -> (BackgroundTasks.Source, BgTask) in
            let s = BackgroundTasks.graphKey(l.startId)
            return (BackgroundTasks.Source(key: s, start: l.startedAt), .graph(l, s))
        }
        let withoutTime = { (q: BackgroundTasks.Source) -> Bool in !(q.start.map { $0.isFinite && $0 > 0 } ?? false) }
        agents.filter { withoutTime($0.0) }.forEach { remember($0.1) }
        runs.reversed().forEach { remember($0.1) }
        graph.reversed().forEach { remember($0.1) }
        agents.filter { !withoutTime($0.0) }.forEach { remember($0.1) }
        return BackgroundTasks.list(agents: agents.map(\.0), runs: runs.map(\.0), graph: graph.map(\.0), followUp: taskSequence)
            .compactMap { byId[$0] }
    }

    /// The running rows of the list: running entries, background commands, monitors, wakeup timer — the dot on the
    /// header button shows exactly then (web: the count on the tab, `bgRunningCount`).
    var backgroundRunning: Int {
        backgroundList(subagents).filter(\.running).count + waitTasks.count + waitMonitors.count + (waitWakeupAt == nil ? 0 : 1)
    }
}
