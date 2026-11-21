// The ONE "Background Tasks" list in the agents tab of the right chat bar: the order as a pure calculation, without React and DOM, so
// the gate (web/test/background-tasks.test.mjs) can compile and check it with tsc. A leaf module without imports. Its twin is iOS
// `Chat/BackgroundTasks.swift`, bound in web/test/background-tasks-binding.test.mjs (both sides REALLY executed).
//
// All cards share one design and appear in one list without distinguishing subagents from workflows; the main run is not shown.
//
// The rule: NEWEST ON TOP, subagents and workflow runs mixed, by start time descending. The problem: not every entry KNOWS its start
// time. A running subagent carries it (event `background`, `startedAt`), a finished one does not: it comes from the history, and its
// report names duration, tokens and tools but no start (agent-runtime.js `report`). A workflow run always carries it
// (`DynTreeRun.startedAt`). Sorting by time alone would make a subagent jump to the end of the list the moment it finishes, and after a
// reload all finished ones would stand below all workflows, whenever they ran.
//
// Hence two sources, in this order of precedence:
//   1. the own start time where there is one (finite number > 0);
//   2. otherwise the ARRIVAL: the position in the history (`taskSequence`; a subagent's call block and a workflow's start marker stand
//      there in the order in which they began). An entry without a time counts as at least as new as everything that arrived BEFORE it
//      (it gets the largest start time of its predecessors), and on a tie the later arrival is on top. An entry the history does not
//      (yet) know (a subagent whose block is not there yet; a run whose marker is missing) comes AFTER all known ones, in input order.
// The input order is part of the rule (`backgroundTasks`): first the subagents WITHOUT a time (in list order, which is the history
// order), then the runs from old to new (the tree delivers newest first), last the subagents WITH a time. So without a history an
// unknown entry lands at the bottom instead of being as new as the newest workflow.
//
// The same list also holds the graph workflows in the BACKGROUND (`graph:<startId>`, lib/graph-runs.ts). They ALWAYS carry their start
// time (the row in `graph_starts`) and no marker in the history; they therefore stand by their time, and in the input behind the dyn
// runs (old to new, like those).
//
// The alarm clock, the background commands and the monitors carry no start time and are not in this calculation but own rows under
// "Running" (lib/bg-rows.ts). The outer-loop runs are NOT here; they have their own area.
//
// What follows, and what the test pins: a subagent that finishes does not jump (its predecessor in the history is older than it, and
// on a tie its later arrival wins); a new entry is on top, subagent or workflow; without time and without history the order is the
// reverse arrival: stable, nothing moves on the next tick.

/** An entry of the list as the calculation needs it: key (`agent:<block id>`, `workflow:<run id>` or `graph:<startId>`) and the own
 *  start time in ms, if known. */
export type TaskSource = { key: string; start?: number | null };

/** A history row as far as it counts for arrival: the ids of the subagent calls in it (top level, in their order) and the run id if
 *  the row is a workflow's START marker. */
export type SequenceRow = { agents: readonly string[]; workflowStart?: string | null };

export const agentKey = (id: string): string => `agent:${id}`;
export const workflowKey = (runId: string): string => `workflow:${runId}`;
export const graphKey = (startId: string): string => `graph:${startId}`;

const timeOf = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** The arrival sequence from the history: per row its subagent calls, then the start marker. Each key once (the first counts), empty
 *  ids do not count. */
export function taskSequence(rows: readonly SequenceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const alongside = (s: string) => { if (!seen.has(s)) { seen.add(s); out.push(s); } };
  for (const z of rows) {
    for (const id of z.agents) if (id) alongside(agentKey(id));
    if (z.workflowStart) alongside(workflowKey(z.workflowStart));
  }
  return out;
}

/** The core: the indices of the inputs in display order (newest on top). `followUp` = the arrival sequence of the keys, as far as the
 *  history knows them. */
export function arrangeTasks(inputs: readonly TaskSource[], followUp: readonly string[]): number[] {
  const pos = new Map<string, number>();
  followUp.forEach((s, i) => { if (!pos.has(s)) pos.set(s, i); });
  const n = inputs.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  const place = (i: number) => pos.get(inputs[i].key) ?? Number.POSITIVE_INFINITY;
  const arrival = idx.slice().sort((a, b) => {
    const sa = place(a), sb = place(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a - b;
  });
  const eff: number[] = new Array(n);
  const rank: number[] = new Array(n);
  let last = Number.NEGATIVE_INFINITY;
  arrival.forEach((i, k) => {
    const s = timeOf(inputs[i].start);
    if (s !== null && s > last) last = s;
    eff[i] = s ?? last;
    rank[i] = k;
  });
  return idx.sort((a, b) => {
    if (eff[a] !== eff[b]) return eff[a] > eff[b] ? -1 : 1;
    return rank[b] - rank[a];
  });
}

/** The bar's list: keys in display order. `agents` in the order of the agent list (lib/agents.ts `agentsList`), `runs` in the order of
 *  the tree (newest first, lib/dyn-tree.ts), `graph` in the order of the graph-start state (newest first, lib/graph-runs.ts
 *  `backgroundRuns`). Each key once. */
export function backgroundTasks(agents: readonly TaskSource[], runs: readonly TaskSource[], followUp: readonly string[], graph: readonly TaskSource[] = []): string[] {
  const inputs: TaskSource[] = [];
  const seen = new Set<string>();
  const alongside = (q: TaskSource) => { if (!seen.has(q.key)) { seen.add(q.key); inputs.push(q); } };
  for (const a of agents) if (timeOf(a.start) === null) alongside(a);
  for (const l of runs.slice().reverse()) alongside(l);
  for (const g of graph.slice().reverse()) alongside(g);
  for (const a of agents) if (timeOf(a.start) !== null) alongside(a);
  return arrangeTasks(inputs, followUp).map((i) => inputs[i].key);
}
