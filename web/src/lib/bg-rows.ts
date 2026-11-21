// The rows of the "Background Tasks" list in the agents tab of the right chat bar (components/AgentBar.tsx) as a pure calculation:
// no React, no DOM, not a single import, so the gate (web/test/bg-rows.test.mjs) can compile and check it with tsc.
//
// Why a flat list: there are two sections, "Running" and "Ended". They used to be two separate parent nodes, each with its own
// `.map(card)`. If a dynamic workflow ends while you watch, its card moves from "Running" to "Ended", and React keeps a component's
// state only with the same parent node AND the same `key`. In the second node it rebuilt the card NEW, `DynWorkflowCard` started again
// at `useState(head.running)` (= closed), and the stopped run folded shut under your eyes. iOS had the same bug in two ForEach (fixed
// with ONE ForEach over `sheetRows` in Chat/ChatDetailSheet.swift, id = the task's key). Here the same: ONE row list under ONE parent
// node, the heads as rows of their own, each card with its task's key, the same in both sections. The Swift version is a private method
// of the view and therefore not bound; the same sequence is held by the shape tests in web/test/dyn-tree.test.mjs (iOS) and
// web/test/bg-rows.test.mjs (web).
//
// The sequence, top to bottom:
//   1. only if something runs (a running task, a background command or a monitor): the head "Running", the running tasks in input
//      order (lib/background-tasks.ts, newest on top), then the commands and after them the monitors, both NEWEST FIRST (the input
//      comes in start order, without a start time, reversed);
//   2. only if something has ended: the head "Ended" and, unless folded, the ended tasks.
// Behind the monitors stands the WAKEUP (the main agent's scheduled continuation, ScheduleWakeup/CronCreate) as a row of its own
// `wakeup`; it too carries no start time, only the wake time. And the count on the tab (`bgRunningCount`) counts FROM THIS list: every
// row under "Running" except the head, so the count on the tab and the list below it never contradict each other.
//
// Keys: `header:running`, `header:ended`, per task its own (`agent:…`, `workflow:…`, `graph:…`; never a prefix per section, else React
// would rebuild the card), `command:<taskId>`/`monitor:<taskId>`, without a taskId `…:<position>` in the reversed order, `wakeup` (at
// most one per chat).

/** A background command or monitor, as far as the row needs it. */
export type BgItem = { taskId?: string | null };

/** A row of the list. `first` on the head: it is the FIRST visible section (it carries Σ and the heading's identifier). */
export type BgRow<T, P extends BgItem> =
  | { kind: "header"; section: "running" | "ended"; key: string; first: boolean }
  | { kind: "task"; section: "running" | "ended"; key: string; task: T }
  | { kind: "command" | "monitor"; key: string; item: P }
  | { kind: "wakeup"; key: string; at: number };

/** The rows in display order. `active`/`finished` in the list's order, `commands`/`monitors` in start order. */
export function bgRows<T, P extends BgItem>(input: {
  active: readonly T[];
  finished: readonly T[];
  commands: readonly P[];
  monitors: readonly P[];
  /** The wake time of the scheduled continuation in ms; missing, 0 or a non-finite number = no wakeup. */
  wakeup?: number | null;
  endedClosed: boolean;
  key: (task: T) => string;
}): BgRow<T, P>[] {
  const { active, finished, commands, monitors, endedClosed, key } = input;
  const wakeup = typeof input.wakeup === "number" && Number.isFinite(input.wakeup) && input.wakeup > 0 ? input.wakeup : null;
  const rows: BgRow<T, P>[] = [];
  const runningSomething = active.length > 0 || commands.length > 0 || monitors.length > 0 || wakeup !== null;
  if (runningSomething) {
    rows.push({ kind: "header", section: "running", key: "header:running", first: true });
    for (const task of active) rows.push({ kind: "task", section: "running", key: key(task), task });
    [...commands].reverse().forEach((item, i) => rows.push({ kind: "command", key: `command:${item.taskId || i}`, item }));
    [...monitors].reverse().forEach((item, i) => rows.push({ kind: "monitor", key: `monitor:${item.taskId || i}`, item }));
    if (wakeup !== null) rows.push({ kind: "wakeup", key: "wakeup", at: wakeup });
  }
  if (finished.length > 0) {
    rows.push({ kind: "header", section: "ended", key: "header:ended", first: !runningSomething });
    if (!endedClosed) for (const task of finished) rows.push({ kind: "task", section: "ended", key: key(task), task });
  }
  return rows;
}

/** The count on the tab: the rows under "Running" without the head, counted from the SAME list the bar shows (a folded "Ended" does
 *  not change it; nothing running stands there). */
export function bgRunningCount<T, P extends BgItem>(rows: readonly BgRow<T, P>[]): number {
  return rows.filter((z) => z.kind !== "header" && (z.kind !== "task" || z.section === "running")).length;
}
