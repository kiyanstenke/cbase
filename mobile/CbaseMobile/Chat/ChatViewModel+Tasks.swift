import Foundation

// The running tasks of this conversation — the pill "N running tasks" in the run row (`RunIndicator`)
// and its sheet (`RunningTasksSheet`). The computation lives purely in `RunningTasks` (bound to the web); here only the
// translation of the model into its input — the counterpart to `useRunningTasks` (web/src/components/chat/chatTasks.ts).
//
// Two differences from the web, both from the model, not the computation: iOS knows background commands and
// monitors only as a description (`waitTasks`/`waitMonitors`, no taskId — the key is then the index, the same in both
// versions), and the subagents come from the stream (`waitAgentsLive`, all alive). Workflows only in the
// Coding chat (`withDynWorkflows`). Likewise the graph starts of this chat (`graphRuns`, Chat/ChatViewModel+GraphRuns.swift):
// which of them count (only background, running or waiting) is decided by the computation; a route that has not yet answered
// makes the list incomplete ("at least …"), never empty.
extension ChatViewModel {
    var runningTasks: RunningTasks.Result {
        let ms: (Date?) -> Double? = { $0.map { $0.timeIntervalSince1970 * 1000 } }
        return RunningTasks.compute(RunningTasks.Input(
            agents: waitAgentsLive.map { a in
                RunningTasks.AgentInput(
                    key: a.id,
                    agentId: a.agentId.isEmpty ? a.taskId : a.agentId,
                    name: a.description.isEmpty ? a.name : a.description,
                    live: true,
                    foreground: a.foreground,
                    startedAt: ms(a.startedAt),
                    parkedUntil: ms(a.parkedUntil)
                )
            },
            workflows: withDynWorkflows
                ? dynTree.runs.map { RunningTasks.WorkflowInput(runId: $0.runId, name: $0.name, status: $0.status, startedAt: $0.startedAt) }
                : [],
            workflowsLoaded: withDynWorkflows ? dynTree.loaded : true,
            commands: waitTasks.map { RunningTasks.ItemInput(taskId: "", description: $0) },
            monitors: monitors.map { RunningTasks.ItemInput(taskId: $0.taskId, description: $0.description, startedAt: $0.startedAt) },
            wakeup: RunningTasks.Wakeup(at: ms(waitWakeupAt) ?? 0, reason: waitWakeupReason, prompt: waitWakeupPrompt),
            graphRuns: withDynWorkflows
                ? graphRuns.runs.map {
                    RunningTasks.GraphInput(startId: $0.startId, name: $0.name, shortName: $0.shortName, state: $0.state,
                                               background: $0.background, startedAt: $0.startedAt)
                }
                : [],
            graphLoaded: withDynWorkflows && !isDraft ? graphRuns.loaded : true
        ))
    }

    /// The block in the history a running subagent belongs to — "Open" in the sheet selects exactly it
    /// in the subagents sheet (`SubagentsSheet(initialSelection:)`). `""` if none is known: then the list opens.
    func blockIdOfAgent(_ agentId: String) -> String {
        guard !agentId.isEmpty else { return "" }
        return subagents.first(where: { $0.agentId == agentId })?.blockId ?? ""
    }
}
