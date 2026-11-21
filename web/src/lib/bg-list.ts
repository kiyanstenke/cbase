// The entries of the "Background Tasks" list (right chat bar, components/AgentBar.tsx) as a pure calculation: which kinds of background
// work belong to it, when an entry "runs", and in which order they stand; without React and DOM, so the gate (web/test/bg-list.test.mjs)
// can compile and check it with tsc.
//
// ONE place (the hook chat/chatBackgroundTasks.ts via this file) computes the list, the bar shows it, and the count on the tab is
// `bgRunningCount` over the SAME rows (lib/bg-rows.ts).
//
// The kinds (decision and reasoning per kind: components/README.md, section "Background Tasks"):
//   agent      subagent (cbase_agent): runs by `live`
//   workflow   dynamic workflow: runs in the status "running"
//   graph      graph workflow in the background: runs as long as `graphOpen`
// Without a start time and therefore NOT in this calculation but own rows under "Running" (lib/bg-rows.ts): background commands,
// monitors and the alarm clock.
//
// NOT included: the outer-loop runs; they have their own area (Coding → Outer Loop, chat info). Guard: web/test/bg-list.test.mjs (f).
import { backgroundTasks, type TaskSource } from "./background-tasks.js";

/** An entry as the calculation needs it: key (lib/background-tasks.ts), time in ms (`null` = unknown), whether it still runs, and the
 *  view's data (the calculation does not read it). */
export type BgInput<T> = { key: string; start: number | null | undefined; running: boolean; data: T };

export type BgList<T> = { list: BgInput<T>[]; active: BgInput<T>[]; finished: BgInput<T>[] };

/** The list in display order (newest on top, lib/background-tasks.ts) and its split into running/finished. The inputs per source in
 *  the order `backgroundTasks` demands: `agents` in the order of the agent list, `runs` and `graph` newest first. A key
 *  that comes twice stands once (the one `backgroundTasks` keeps). */
export function bgList<T>(q: {
  agents: readonly BgInput<T>[];
  runs: readonly BgInput<T>[];
  graph: readonly BgInput<T>[];
  followUp: readonly string[];
}): BgList<T> {
  // Per key the entry the ordering keeps: the first in the order in which `backgroundTasks` collects; for the runs that is the LAST of
  // the newest-first list. So that data and order never diverge, the map remembers the same one: in collection order, the first wins.
  const next = new Map<string, BgInput<T>>();
  const remember = (e: BgInput<T>) => { if (!next.has(e.key)) next.set(e.key, e); };
  const withoutTime = (e: BgInput<T>) => !(typeof e.start === "number" && Number.isFinite(e.start) && e.start > 0);
  q.agents.filter(withoutTime).forEach(remember);
  q.runs.slice().reverse().forEach(remember);
  q.graph.slice().reverse().forEach(remember);
  q.agents.filter((e) => !withoutTime(e)).forEach(remember);
  const source = (e: BgInput<T>): TaskSource => ({ key: e.key, start: e.start ?? null });
  const list = backgroundTasks(q.agents.map(source), q.runs.map(source), q.followUp, q.graph.map(source))
    .map((s) => next.get(s))
    .filter((e): e is BgInput<T> => Boolean(e));
  return { list, active: list.filter((e) => e.running), finished: list.filter((e) => !e.running) };
}
