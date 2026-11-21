// The background state of ONE conversation as a hook, for the coding chat: `useBackground(bubbles, busy)` holds what runs
// next to the main agent or waits for it, sets it from the event stream and derives the subagents from it.
//
// - The waiting phase (`waiting`): the run is active but the main agent idle. Four possible reasons: an open monitor, a
//   background agent, a background command, or a continuation the agent scheduled (wakeup). In all cases messages go straight
//   into the running process instead of the queue.
// - The five waiting states: monitors, the RUNNING subagents (contract A: taskId, agentId, description, name, provider,
//   model, status, startedAt, tokens, tokenKind, toolUses; the bar shows model, duration, tokens and pace, so all of it must
//   arrive here), background commands, wakeup time, and the wakeup itself (reason and follow-up prompt, only for the status
//   bar's info card).
// - `backgroundEvent(evt)`: the setter from the stream. The view calls it for EVERY event at the head of its harness
//   switch; it lets exactly the eight kinds in `BACKGROUND_KINDS` through and leaves all others.
// - The derivation: the agent blocks of the history, the calls of running turns, the merged agent list and the state map
//   for the markers in the history.
//
// The state is ONE value (`BackgroundStatus`, start `BACKGROUND_EMPTY`), and the transitions are computed by the pure
// function `backgroundAfter` in lib/agents.ts, which the gate checks. A background agent survives its turn, so
// `run_started`/`run_done` clear only the foreground (waiting phase, monitors, commands, wakeup); agents stay until a
// `background` without them reports their end; `run_aborted`/`run_error` still clear everything. The progress tree docks
// on here; the `background` event is the natural carrier for running dynamic workflows.
//
// The hook also delivers the ARRIVAL SEQUENCE (`taskSequence`, lib/background-tasks.ts): the subagents' call blocks and the
// start markers of the dynamic workflows in history order. The "Background Tasks" list of the agent bar uses it to place
// finished subagents, which know no start time, so new subagents and workflows are added at the top.
import { useMemo, useRef, useState } from "react";
import { type Block, isAgentCall } from "@/components/AssistantBlocks";
import {
  agentsList, BACKGROUND_KINDS, BACKGROUND_EMPTY, type BackgroundItem, backgroundAfter, type BackgroundStatus,
  stateCard, stateKey as stateKeyOf,
} from "@/lib/agents";
import { runningBlockIds } from "@/lib/history-state";
import { taskSequence as followUpFromHistory } from "@/lib/background-tasks";

export type { BackgroundItem };
// The least a bubble must provide; `Bubble` from chatBubbles.ts meets it structurally. `kind`/`marker` only dividers carry
// (the marker of a dynamic workflow), hence optional.
export type BackgroundBubble = {
  role: string; dimmed?: boolean; streaming?: boolean; blocks: Block[]; kind?: string; marker?: { runId?: string } | null;
};

export function useBackground(bubbles: ReadonlyArray<BackgroundBubble>, busy: boolean) {
  // ONE state, advanced by the pure transition function in lib/agents.ts (the gate checks there that `run_done` clears only
  // the foreground; a background agent survives its turn).
  const [status, setStatus] = useState<BackgroundStatus>(BACKGROUND_EMPTY);
  const { waiting, monitors: waitMonitors, agents: waitAgents, tasks: waitTasks, wakeupAt: waitWakeupAt, wakeup: waitWakeup } = status;

  // The view calls this for EVERY event at the head of its harness switch; only the eight kinds that carry the state advance
  // it (`connected`, `run_started`/`_done`/`_aborted`/`_error`, `run_waiting`, `run_busy`, `background`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function backgroundEvent(evt: Record<string, any>) {
    if (evt.type !== "harness" || !BACKGROUND_KINDS.has(evt.subtype)) return;
    setStatus((s) => backgroundAfter(s, evt));
  }

  // The list of the agents tab: running (event) and finished (history) merged, each EXACTLY ONCE. The blocks are filtered
  // HERE with `isAgentCall`; lib/agents.ts deliberately does not know the name list, otherwise it would exist twice.
  // Discarded ("dimmed") bubbles stay out, as with the task list: their calls are no longer part of the run.
  const agentBlocks = useMemo(
    () => bubbles.filter((b) => b.role === "assistant" && !b.dimmed)
      .flatMap((b) => b.blocks)
      .filter((bl): bl is Extract<Block, { kind: "tool" }> => bl.kind === "tool" && isAgentCall(bl.name)),
    [bubbles],
  );
  // Which calls stand in a RUNNING turn: the same question the marker in the history asks via `live`. The list thereby
  // computes each agent's state exactly once.
  const runningBlocks = useMemo(() => runningBlockIds(bubbles, busy), [bubbles, busy]);
  const agents = useMemo(
    () => agentsList<Block>(waitAgents, agentBlocks, runningBlocks),
    [waitAgents, agentBlocks, runningBlocks],
  );
  // The states as a map (block id → state) for the markers in the history. It changes identity ONLY when a state changes;
  // the list itself is new on every token tick, and a new map per tick would pull every history row into the comparison.
  // The key carries the whole content (`id:identifier` per agent), so the map may come from the render that set it.
  const stateKey = stateKeyOf(agents);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const agentStates = useMemo(() => stateCard(agentsRef.current), [stateKey]);

  // The arrival sequence for the "Background Tasks" list (lib/background-tasks.ts): per bubble its subagent calls (as above:
  // top level, discarded bubbles not) and the start marker of a dynamic workflow. The identity changes only when the sequence
  // changes; otherwise it is new on every token tick and would make the list follow each time.
  const followUpNew = followUpFromHistory(bubbles.map((b) => ({
    agents: b.role === "assistant" && !b.dimmed
      ? b.blocks.filter((bl) => bl.kind === "tool" && isAgentCall(bl.name)).map((bl) => (bl.kind === "tool" ? bl.id ?? "" : ""))
      : [],
    // `kind: "workflow-start"` is carried only by the divider of a start marker (chatBubbles.ts, `markerSeparator`), so the
    // role is not asked again (and this file draws no divider, hint-row.test.mjs).
    workflowStart: b.kind === "workflow-start" ? b.marker?.runId ?? null : null,
  })));
  const followUpKey = followUpNew.join("\n");
  const followUpRef = useRef(followUpNew);
  followUpRef.current = followUpNew;
  const taskSequence = useMemo(() => followUpRef.current, [followUpKey]);

  return { waiting, waitMonitors, waitTasks, waitWakeupAt, waitWakeup, agents, agentStates, backgroundEvent, taskSequence };
}
