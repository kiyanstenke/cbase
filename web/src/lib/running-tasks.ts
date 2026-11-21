// The running tasks of ONE conversation as ONE computation, without React and without a single import. The pill in the working row at the
// end of the history ("3 running tasks") and its sheet read this list; in the Coding chat (chat/RunDisplay.tsx) and on iOS
// (mobile/CbaseMobile/Chat/RunningTasks.swift). The binding `web/test/running-tasks-binding.test.mjs` runs the same inputs through both
// versions and demands the same answer row for row (`runningTasks`, `pillsText`, `rowsParts`, `TASK_KIND_WORD`, `hasStop`);
// `web/test/running-tasks.test.mjs` holds the rules.
//
// What counts: everything that runs ALONGSIDE the main agent and keeps running without it:
//   agent     a background subagent from the stream (`live`), NOT the foreground agent (`foreground`): a call of the turn waits for it, it is
//             part of the work the row already shows (mark in the history).
//   workflow  a dynamic workflow in state "running" (progress tree, lib/dyn-tree.ts).
//   graph     a graph workflow in the BACKGROUND (lib/graph-runs.ts) while it runs, waits or waits for lock/storage; a foreground run is work
//             of this chat (strip and banner), a queued one has not begun yet.
//   command   a background command of the CLI (Bash with run_in_background, runs/do-run.js `bgTasks`).
//   monitor   a running monitor (cbase_monitor). It belongs to the CHAT and survives its turn (server runs/monitors.js); it carries its
//             start time (`startedAt`) and has a human stop (`POST …/monitor/stop`, `from: "human"`).
//   wakeup    a scheduled continuation (cbase_wakeup, `wakeupAt` > 0). It belongs to the CHAT (server runs/wakeup.js), survives its turn and has
//             a human stop (`POST …/wakeup/stop`, `from: "human"`); at most one per chat, so its handle is fixed "wakeup".
// The details live in the right bar; the pill jumps there.
//
// Empty is not unknown: `workflowsLoaded: false` means "the tree has not answered yet"; the list is then INCOMPLETE (`complete: false`)
// and the pill says "at least …". A conversation without a workflow source passes `workflows: []` with `workflowsLoaded: true`; there
// "none" is known, not guessed. Only the iOS twin passes this fallback now.
//
// The English words are also the i18n keys (i18n-de.ts, mobile Kit/LocDEBase.swift); translation happens at the place of display.

export type TaskKind = "agent" | "workflow" | "graph" | "command" | "monitor" | "wakeup";

/** A subagent as both views know it from the stream. `key` is the view's handle for "Open" (web: the id of the agent list, iOS: the
 *  agentId); `startedAt`/`parkedUntil` in ms, `null` = unknown. */
export type TaskAgentInput = {
  key: string;
  agentId: string;
  name: string;
  live: boolean;
  foreground: boolean;
  startedAt: number | null;
  parkedUntil: number | null;
};
export type TaskWorkflowInput = { runId: string; name: string; status: string; startedAt: number | null };
/** A background command or monitor. Only a monitor carries `startedAt` (ms); missing = unknown. */
export type TaskItemInput = { taskId: string; description: string; startedAt?: number | null };
/** A graph start as the run view carries it (lib/graph-runs.ts `GraphRunView` fits in). */
export type TaskGraphInput = { startId: string; name: string; shortName?: string; state: string; background: boolean; startedAt: number | null };

export type TasksInput = {
  agents: ReadonlyArray<TaskAgentInput>;
  workflows: ReadonlyArray<TaskWorkflowInput>;
  /** Has the workflow source answered? `false` ⇒ the list is incomplete (not: "no workflows"). */
  workflowsLoaded: boolean;
  commands: ReadonlyArray<TaskItemInput>;
  monitors: ReadonlyArray<TaskItemInput>;
  /** The scheduled continuation; `at` 0 = none. */
  wakeup: { at: number; reason: string; prompt: string };
  /** The chat's graph starts (state of lib/graph-runs.ts); missing = the conversation has none. */
  graphRuns?: ReadonlyArray<TaskGraphInput>;
  /** Has the graph-starts route answered? `false` ⇒ incomplete like `workflowsLoaded`; missing = known. */
  graphLoaded?: boolean;
};

/** An entry of the list. `name` empty = without description (the view inserts its word, it invents no name). `since`: start in ms
 *  (`null` = unknown; commands and monitors carry none). `until`: wake time or "waits until" of a parked agent. `reference`: the
 *  server's handle for the stop (agentId, runId, taskId). `anchor`: the view's handle for "Open" (empty = there is no view).
 *  `reason`/`prompt` only on the wakeup. */
export type TaskItem = {
  kind: TaskKind;
  key: string;
  name: string;
  since: number | null;
  until: number | null;
  reference: string;
  anchor: string;
  reason: string;
  prompt: string;
};

export type RunningTasks = { item: TaskItem[]; complete: boolean };

const time = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** States of a background graph run that count as a running task. */
export const GRAPH_TASK_STATES: readonly string[] = Object.freeze(["running", "waiting", "waiting_lock", "waiting_storage"]);

/** The list in fixed order of kinds (agent, workflow, graph, command, monitor, wakeup), within a kind in input order. Every entry
 *  EXACTLY ONCE (same key ⇒ the first wins). */
export function runningTasks(e: TasksInput): RunningTasks {
  const item: TaskItem[] = [];
  const seen = new Set<string>();
  const alongside = (p: TaskItem) => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    item.push(p);
  };
  const empty = { since: null, until: null, reference: "", anchor: "", reason: "", prompt: "" };
  e.agents.forEach((a, i) => {
    if (!a.live || a.foreground) return;
    const id = a.agentId || a.key || String(i);
    alongside({ ...empty, kind: "agent", key: `agent:${id}`, name: a.name, since: time(a.startedAt), until: time(a.parkedUntil), reference: a.agentId, anchor: a.key || a.agentId });
  });
  for (const w of e.workflows) {
    if (w.status !== "running" || !w.runId) continue;
    alongside({ ...empty, kind: "workflow", key: `workflow:${w.runId}`, name: w.name, since: time(w.startedAt), reference: w.runId, anchor: w.runId });
  }
  for (const g of e.graphRuns ?? []) {
    if (g.background !== true || !g.startId || !GRAPH_TASK_STATES.includes(g.state)) continue;
    alongside({ ...empty, kind: "graph", key: `graph:${g.startId}`, name: g.name || g.shortName || "", since: time(g.startedAt), reference: g.startId, anchor: g.startId });
  }
  e.commands.forEach((b, i) => alongside({ ...empty, kind: "command", key: `command:${b.taskId || i}`, name: b.description, reference: b.taskId }));
  e.monitors.forEach((m, i) => alongside({ ...empty, kind: "monitor", key: `monitor:${m.taskId || i}`, name: m.description, since: time(m.startedAt), reference: m.taskId }));
  if (time(e.wakeup.at) !== null) alongside({ ...empty, kind: "wakeup", key: "wakeup", name: "", until: e.wakeup.at, reference: "wakeup", reason: e.wakeup.reason, prompt: e.wakeup.prompt });
  return { item, complete: e.workflowsLoaded && e.graphLoaded !== false };
}

/** The pill's wording as an i18n key with a number; `null` if nothing is known to run (then no pill appears: it claims nothing). If the
 *  list is incomplete, it says "at least": an understated number could not be told apart from a complete one (the same rule as
 *  `tokenText` in lib/agents.ts). */
export function pillsText(t: RunningTasks): { key: string; n: number } | null {
  const n = t.item.length;
  if (n === 0) return null;
  if (t.complete) return { key: n === 1 ? "1 running task" : "{n} running tasks", n };
  return { key: n === 1 ? "at least 1 running task" : "at least {n} running tasks", n };
}

export type RowsPart = "hex" | "time" | "pill" | "word";

/** The parts of the working row in the order of the model (Claude Code): [hexagon] "12s · 4.8k tokens" [pill] "Pondering…". `running`:
 *  the working indicator is shown; `time`: the start of the run is known. Without a
 *  running turn but with tasks: only hexagon (resting) and pill. Empty = no row. */
export function rowsParts(z: { running: boolean; time: boolean; tasks: number }): RowsPart[] {
  if (!z.running && z.tasks <= 0) return [];
  const parts: RowsPart[] = ["hex"];
  if (z.running && z.time) parts.push("time");
  if (z.tasks > 0) parts.push("pill");
  if (z.running) parts.push("word");
  return parts;
}

/** The word per kind: an i18n key, translated at the place of display. */
export const TASK_KIND_WORD: Readonly<Record<TaskKind, string>> = Object.freeze({
  agent: "Subagent",
  workflow: "Workflow",
  graph: "Graph workflow",
  command: "Background command",
  monitor: "Monitor",
  wakeup: "Alarm",
});

/** Is there a human stop? Today for subagent (`POST …/agent/stop`), workflow (`POST …/dyn-workflows/runs/:runId/stop`), graph workflow
 *  (`POST …/graph-workflows/:startId/stop` on the chat of the START, not on the child chat),
 *  monitor (`POST …/monitor/stop`) and wakeup (`POST …/wakeup/stop`); commands have none, and the sheet invents none. Bound to iOS
 *  (`RunningTasks.hasStop`). */
export function hasStop(p: TaskItem): boolean {
  return (p.kind === "agent" || p.kind === "workflow" || p.kind === "graph" || p.kind === "monitor" || p.kind === "wakeup") && p.reference !== "";
}

/** The path of the stop where `hasStop` holds; otherwise `null`. The body carries `from: "human"`: only it leaves the silent hint for the
 *  next turn. (iOS builds the path itself in `ChatViewModel.stopAgent`/`stopDynWorkflow`, where
 *  `APIClient.makeURL` encodes the path; a pre-encoded one would be encoded twice.) */
export function stopWay(chatId: string, p: TaskItem): { path: string; body: Record<string, string> } | null {
  if (!chatId || !hasStop(p)) return null;
  const c = encodeURIComponent(chatId);
  if (p.kind === "agent") return { path: `/api/chats/${c}/agent/stop`, body: { agentId: p.reference, from: "human" } };
  if (p.kind === "workflow") return { path: `/api/chats/${c}/dyn-workflows/runs/${encodeURIComponent(p.reference)}/stop`, body: { from: "human" } };
  if (p.kind === "graph") return { path: `/api/chats/${c}/graph-workflows/${encodeURIComponent(p.reference)}/stop`, body: { from: "human" } };
  if (p.kind === "monitor") return { path: `/api/chats/${c}/monitor/stop`, body: { taskId: p.reference, from: "human" } };
  if (p.kind === "wakeup") return { path: `/api/chats/${c}/wakeup/stop`, body: { from: "human" } };
  return null;
}
