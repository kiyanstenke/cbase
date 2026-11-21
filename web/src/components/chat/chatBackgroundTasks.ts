// The "Background Tasks" list of ONE coding chat as a hook. Called ONCE in the right chat bar (ChatRightSidebar): the bar
// shows the state (components/AgentBar.tsx, prop `bg`), the tab counts FROM THE SAME state (`running`, lib/bg-rows.ts
// `bgRunningCount`).
//
// The sources: subagents (useBackground), the dynamic-workflow tree (useDynTree), graph starts (useGraphRuns), the
// run's background commands, monitors and wakeup (useBackground). The computation lives purely in lib/bg-list.ts and
// lib/bg-rows.ts. Outer-loop runs are NOT in it (their own area).
//
// Empty is not unknown: `unloaded` is true while a source with its own route (graph starts) has not answered
// yet; then the bar does not say "no background task ran yet".
import { useMemo } from "react";
import type { Agent, BackgroundItem } from "@/lib/agents";
import type { DynTreeRun, DynTreeStatus } from "@/lib/dyn-tree";
import { graphOpen, backgroundRuns, type GraphRunsStatus, type GraphRunView } from "@/lib/graph-runs";
import { agentKey, graphKey, workflowKey } from "@/lib/background-tasks";
import { bgList, type BgInput } from "@/lib/bg-list";
import { bgRunningCount, bgRows } from "@/lib/bg-rows";

/** An entry of the list with the data of its card. */
export type BgTask<B> =
  | { kind: "agent"; agent: Agent<B> }
  | { kind: "workflow"; run: DynTreeRun }
  | { kind: "graph"; graph: GraphRunView };
export type BgEntry<B> = BgInput<BgTask<B>>;

export type BackgroundTasksState<B> = {
  list: BgEntry<B>[];
  active: BgEntry<B>[];
  finished: BgEntry<B>[];
  commands: ReadonlyArray<BackgroundItem>;
  monitors: ReadonlyArray<BackgroundItem>;
  /** The wakeup time of the scheduled continuation in ms, 0 = none; plus the reason the agent gave (title of the card). */
  wakeup: number;
  wakeupReason: string;
  /** The number on the tab: the running rows of the list (tasks, commands, monitors, wakeup). */
  running: number;
  /** A source with its own route has not answered yet; "none" is then not known. */
  unloaded: boolean;
};

export function useBackgroundTasks<B>(q: {
  agents: ReadonlyArray<Agent<B>>;
  dynTree: DynTreeStatus;
  graphRuns: GraphRunsStatus;
  taskSequence: readonly string[];
  commands: ReadonlyArray<BackgroundItem>;
  monitors: ReadonlyArray<BackgroundItem>;
  wakeup: number;
  wakeupReason: string;
}): BackgroundTasksState<B> {
  const { agents, dynTree, graphRuns, taskSequence, commands, monitors, wakeup, wakeupReason } = q;
  return useMemo(() => {
    const e = <T extends BgTask<B>>(key: string, start: number | null | undefined, running: boolean, data: T): BgEntry<B> => ({ key, start, running, data });
    // A subagent without an id (the list then knows neither block nor agent) gets a placeholder key by its position.
    const ag = agents.map((a, i) => e(agentKey(a.id || `#${i}`), a.startedAt, a.live, { kind: "agent", agent: a }));
    const wf = dynTree.runs.map((l) => e(workflowKey(l.runId), l.startedAt, l.status === "running", { kind: "workflow", run: l }));
    const gr = backgroundRuns(graphRuns).map((g) => e(graphKey(g.startId), g.startedAt, graphOpen(g), { kind: "graph", graph: g }));
    const { list, active, finished } = bgList({ agents: ag, runs: wf, graph: gr, followUp: taskSequence });
    const running = bgRunningCount(bgRows({ active, finished, commands, monitors, wakeup, endedClosed: true, key: (t) => t.key }));
    const unloaded = !graphRuns.loaded;
    return { list, active, finished, commands, monitors, wakeup, wakeupReason, running, unloaded };
  }, [agents, dynTree, graphRuns, taskSequence, commands, monitors, wakeup, wakeupReason]);
}
