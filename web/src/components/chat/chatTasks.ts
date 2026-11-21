// The running tasks of ONE conversation as a hook, for the Coding chat stage (ChatStage). The calculation itself lives purely in
// lib/running-tasks.ts (bound to iOS, web/test/running-tasks-binding.test.mjs); this file only translates the sources into its input:
//   - the background state (useBackground, chatBackground.ts): subagents, background commands, monitors, wake-ups;
//   - the progress tree of dynamic workflows (useDynTree, chatDynTree.ts). A tree that has not answered yet (`loaded: false`)
//     makes the list incomplete; the pill then says "at least";
//   - the chat's graph runs (useGraphRuns, chatGraphRuns.ts); background runs are counted (lib/running-tasks.ts), a state that is
//     not loaded yet makes the list incomplete like the tree.
// lib/running-tasks.ts still knows the fallbacks (iOS twin).
import { useMemo } from "react";
import type { Agent, BackgroundItem } from "@/lib/agents";
import type { DynTreeStatus } from "@/lib/dyn-tree";
import type { GraphRunsStatus } from "@/lib/graph-runs";
import { runningTasks, type RunningTasks } from "@/lib/running-tasks";

export function useRunningTasks(q: {
  agents: ReadonlyArray<Agent<unknown>>;
  tasks: ReadonlyArray<BackgroundItem>;
  monitors: ReadonlyArray<BackgroundItem>;
  wakeupAt: number;
  wakeup: { reason: string; prompt: string };
  dynTree: DynTreeStatus;
  graphRuns: GraphRunsStatus;
}): RunningTasks {
  const { agents, tasks, monitors, wakeupAt, wakeup, dynTree, graphRuns } = q;
  return useMemo(() => runningTasks({
    agents: agents.map((a) => ({
      key: a.id,
      agentId: a.agentId,
      name: a.job,
      live: a.live,
      foreground: a.foreground === true,
      startedAt: a.startedAt ?? null,
      parkedUntil: a.parkedUntil ?? null,
    })),
    workflows: dynTree.runs.map((l) => ({ runId: l.runId, name: l.name, status: l.status, startedAt: l.startedAt })),
    workflowsLoaded: dynTree.loaded,
    commands: tasks.map((p) => ({ taskId: p.taskId ?? "", description: p.description ?? "" })),
    monitors: monitors.map((p) => ({ taskId: p.taskId ?? "", description: p.description ?? "", startedAt: p.startedAt ?? null })),
    wakeup: { at: wakeupAt, reason: wakeup.reason, prompt: wakeup.prompt },
    graphRuns: graphRuns.runs, graphLoaded: graphRuns.loaded,
  }), [agents, tasks, monitors, wakeupAt, wakeup, dynTree, graphRuns]);
}
