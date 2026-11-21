"use client";

// The fourth tab of the right chat rail: everything THIS chat ran next to the main agent (subagents, dynamic workflows, graph
// workflows in the background, monitors, background commands and the wakeup) in ONE list "Background Tasks", running
// and finished together.
//
// From top to bottom:
//   1. the heading "Background Tasks" with a sum (Σ) over ALL entries;
//   2. "Stop all background agents" while a subagent lives;
//   3. the list: one card per entry in the form of the workflow card (chat/DynWorkflowTree.tsx: `overflow-hidden rounded-xl
//      bg-panel cb-task-card`, no border, no accent edge, no tint), 6 px apart (`space-y-1.5`), NEWEST ON TOP, kinds mixed
//      (lib/background-tasks.ts). There is no card for the main run and no dots in front of the rows: the coloured state
//      word is the ONE state indicator.
// The subagent card carries the workflow card's header as far as the data goes: chevron and job, runtime and stop on the right
// (the same `SymbolButton`); below it "Subagent <state word>" in the colour of the workflow outcome (running blue, done green,
// error red, otherwise dimmed) with the model on the right (`modelShort`), below that tokens and, while running, the pace or
// "waits until …". A click on the header opens the selection INSIDE the card as a section with a hairline, like a phase: the
// REPORT first (what the main agent read), the steps below it, collapsible.
//
// Live and finished entries are merged in lib/agents.ts (pure, covered by the gate), which also computes each agent's STATE
// (`Agent.state`, computed ONCE via lib/history-state.ts). This rail does not compute it: the word comes from the table
// AGENT_STATES (the same one the mark in the history uses), the colour from TONE_CLASS (done, which is no state, is green like
// the "done" outcome in the workflow header). lib/background-tasks.ts computes the order (bound to iOS): by start time, and where
// a finished subagent has none, by its place in the history (`followUp`), so it does not jump when it finishes.
//
// Width is the hard limit (the rail is 280–640 px wide, default 348): hence `modelShort` instead of `modelText`, and the job
// is cut with `truncate`; the full text is in the title and in the report.
//
// Handles for DOM probes in a real browser: data-agents-bar (the root, the "tab open" anchor),
// data-bg-tasks-header, data-bg-tasks-sum, data-bg-tasks (the list), data-bg-task="agent:<id>"|"workflow:<runId>" on EVERY card;
// on the subagent card data-agents-card, data-agents-status (the translated word), data-agents-state (the identifier),
// data-agents-id, data-open (selected); inside it data-agents-row (the header button, aria-expanded), data-agents-job,
// data-agents-time, data-agents-stop, data-agents-word, data-agents-model, data-agents-tokens, data-agents-addition,
// data-agents-background, data-agents-report, data-agents-steps; data-agents-all-stop, data-agents-empty; data-agent-message (the
// "Message" button on a live subagent: opens chat/AgentMessageSheet.tsx with the agentId as address, sender "human", even
// without a running turn).
//
// Graph workflows in the background sit in the same list, one card each (`chat/GraphRunCard.tsx`, `data-bg-task="graph:<startId>"`),
// ordered by start time (lib/background-tasks.ts, fourth source), under "Running" while they are not finished (`graphOpen`:
// queued, waiting, running). They carry no tokens: Σ stays the sum of subagents and dynamic workflows. Only in the coding chat
// (ChatRightSidebar passes `graphRuns` from `useGraphRuns`). A state that is not loaded yet is not "none": until the route answers,
// no empty sentence shows. The card answers its waiting state itself (`onGraphResponse`, same hook).
//
// All kinds of background work are shown; the list comes from outside, the wakeup too (`WakeupCard`, `data-bg-wakeup`, stop
// `data-bg-wakeup-stop`; it belongs to the chat). This rail does not compute the list: it arrives ready as `bg` from the hook
// chat/chatBackgroundTasks.ts (pure: lib/bg-list.ts), which the right rail calls ONCE; the tab counts from the same state
// (`bg.running`). Which kind belongs and why: components/README.md, "Background Tasks". Outer loop runs do NOT belong here.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { outputUrl } from "@/lib/api/outputs";
import type { BackgroundItem } from "@/lib/agents";
import { useT } from "@/lib/i18n";
import { Markdown } from "@/components/Markdown";
import { Chevron } from "@/components/CbKit";
import { AssistantBlocks, type Block } from "@/components/AssistantBlocks";
import { TONE_CLASS, type AgentIdentifier } from "@/lib/history-state";
import { DynWorkflowCard, SymbolButton } from "@/components/chat/DynWorkflowTree";
import type { WorkflowChoice } from "@/lib/agent-jump";
import { MessageIcon, SpinnerIcon, StopSquareIcon } from "@/components/chat/ChatIcons";
import { AgentMessageSheet, type MessageTarget } from "@/components/chat/AgentMessageSheet";
import { runTokens, carriesWorkflow, type DynTreeStatus } from "@/lib/dyn-tree";
import { bgRows } from "@/lib/bg-rows";
import { clockTime } from "@/lib/chat-format";
import { GraphRunCard } from "@/components/chat/GraphRunCard";
import type { GraphRequest } from "@/lib/graph-runs";
import type { BackgroundTasksState, BgTask } from "@/components/chat/chatBackgroundTasks";
import {
  durationShort, elapsed, fmtTokens, tokenText, tokenShort, tokenLowerLimit, modelShort, appendMeasurementPoint, tempoProMinute, waitingUntilText,
  type Agent, type MeasurementPoint,
} from "@/lib/agents";

// An entry of the list: key, whether it still runs, and the data of its card (chat/chatBackgroundTasks.ts `BgTask`).
type Entry = { key: string; running: boolean } & BgTask<Block>;

export function AgentBar({ chatId, agents, selected, onSelect, workflows, workflowChoice, bg, onGraphStop, onGraphResponse }: {
  chatId: string | null;
  agents: Agent<Block>[];
  selected: string;
  onSelect: (id: string) => void;
  /** The progress tree of the dynamic workflows: ONLY in the coding chat (ChatRightSidebar). */
  workflows?: DynTreeStatus;
  /** The jump "Agent in chat" to a workflow agent (lib/agent-jump.ts): the card of THIS run opens and selects the row. */
  workflowChoice?: WorkflowChoice | null;
  /** The ONE list "Background Tasks" (hook chat/chatBackgroundTasks.ts, called ONCE in ChatRightSidebar): subagents, dynamic and
   *  graph workflows in the background in display order, plus the run's background commands, monitors and
   *  wakeup (no start time, under "Running"). The arrival order from the history (`taskSequence`) is already included. */
  bg: BackgroundTasksState<Block>;
  /** Stop of a graph card (`useGraphRuns.stopGraphStart`: on the chat of the start, `from: "human"`). */
  onGraphStop?: (startId: string) => Promise<void>;
  /** The answer in a graph card (`useGraphRuns.respondGraph`: the request from `responseRequest` on the child chat). */
  onGraphResponse?: (request: GraphRequest) => Promise<void>;
}) {
  const t = useT();
  const [stops, setStops] = useState("");
  const [switches, setSwitches] = useState("");
  // The "Message" sheet: whom it writes to, or null.
  const [messageTo, setMessageTo] = useState<MessageTarget | null>(null);
  const [error, setError] = useState("");
  // "Finished" collapsed: per view, not remembered.
  const [endedClosed, setEndedTo] = useState(false);
  // Own one-second tick for the running clocks; otherwise "1:04" would stand until the next event. A workflow runs outside the
  // turn, so without this line its clock would stop when the turn ends.
  const [, setTick] = useState(0);
  // It ticks while ANYTHING stands under "Running" (the wakeup too).
  const liveRunning = bg.running > 0;
  useEffect(() => {
    if (!liveRunning) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [liveRunning]);

  // Measuring points per agent for the pace. They live in a ref, not in state: the second tick re-renders anyway, and state here
  // would trigger a second round on every event.
  const points = useRef<Map<string, MeasurementPoint[]>>(new Map());
  useEffect(() => {
    const now = Date.now();
    const live = new Set<string>();
    for (const a of agents) {
      if (!a.live || typeof a.tokens !== "number") continue;
      live.add(a.id);
      points.current.set(a.id, appendMeasurementPoint(points.current.get(a.id) ?? [], now, a.tokens));
    }
    // Finished agents need no pace any more; their series would only be memory.
    for (const id of [...points.current.keys()]) if (!live.has(id)) points.current.delete(id);
  }, [agents]);

  const runs = useMemo(() => workflows?.runs ?? [], [workflows]);
  // The ONE list arrives ready computed (newest on top, lib/bg-list.ts via lib/background-tasks.ts); here it is only brought into
  // the form of the cards.
  const active = useMemo(() => Array.from(bg.active, asEntry), [bg.active]);
  const finished = useMemo(() => Array.from(bg.finished, asEntry), [bg.finished]);
  const { commands, monitors } = bg;

  // Σ over ALL entries: the subagents' tokens and the sum per workflow run (lib/dyn-tree.ts `runTokens`). A graph workflow carries
  // no number (the run view knows no tokens): it does not count, instead of counting as 0.
  const sum = useMemo(
    () => agents.reduce((n, a) => n + (a.tokens ?? 0), 0) + runs.reduce((n, l) => n + (runTokens(l)?.tokens ?? 0), 0),
    [agents, runs],
  );
  const running = agents.some((a) => a.live);

  async function stop(a: Agent<Block>) {
    if (!chatId || !a.agentId) return;
    setStops(a.id);
    setError("");
    try {
      // `from: "human"` tells the cause: the subagent's report tells the main agent "stopped by the human", and it carries on
      // instead of running into its deadline.
      const response = await api<{ ok?: boolean }>(`/api/chats/${chatId}/agent/stop`, {
        method: "POST",
        body: JSON.stringify({ agentId: a.agentId, from: "human" }),
      });
      // The server says "not found" with ok:false, not with an error. If the display kept quiet about it, an ineffective click
      // would look like an effective one.
      if (response && response.ok === false) {
        setError(t("The subagent did not stop — it is either already finished or not managed by cbase (a subagent of the CLI)."));
      }
    } catch (e) {
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setStops("");
    }
  }

  // "To background" (Ctrl+B of Claude Code): a foreground agent switches at once, its waiting tool call returns with "keeps running
  // in the background", and the main agent carries on. Its report comes later as a completion notice. `ok: false` means it no
  // longer ran: the display says so instead of staying silent.
  async function intoTheBackground(a: Agent<Block>) {
    if (!chatId || !a.agentId) return;
    setSwitches(a.id);
    setError("");
    try {
      const response = await api<{ ok?: boolean }>(`/api/chats/${chatId}/agent/background`, {
        method: "POST",
        body: JSON.stringify({ agentId: a.agentId }),
      });
      if (response && response.ok === false) setError(t("The subagent was no longer running — it has already finished."));
    } catch (e) {
      setError(t("Could not send to background: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setSwitches("");
    }
  }

  // Stop a monitor: it belongs to the chat, not to the turn, so the stop works without a running turn too. `from: "human"`
  // leaves the quiet hint for the main agent; the card's disappearance comes with the event `background` without it. Same path as in
  // the Tasks pill's sheet (lib/running-tasks.ts `stopWay`).
  async function monitorStop(key: string, m: BackgroundItem) {
    if (!chatId || !m.taskId) return;
    setStops(key);
    setError("");
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/monitor/stop`, { method: "POST", body: JSON.stringify({ taskId: m.taskId, from: "human" }) });
    } catch (e) {
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setStops("");
    }
  }

  // Stop the wakeup: it belongs to the chat (server runs/wakeup.js), so the stop works without a running turn; `from: "human"`
  // leaves the quiet hint for the main agent, and the card's disappearance comes with the event `background` with `wakeupAt` 0.
  // Same path as in the Tasks pill's sheet (`stopWay`).
  async function wakeupStop() {
    if (!chatId) return;
    setStops("wakeup");
    setError("");
    try {
      await api(`/api/chats/${encodeURIComponent(chatId)}/wakeup/stop`, { method: "POST", body: JSON.stringify({ from: "human" }) });
    } catch (e) {
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setStops("");
    }
  }

  // "Stop all background agents": the server stops the background agents of THIS chat (even without a running turn) and names the
  // stopped ones. Foreground agents of a running turn are ended by /stop, not by this button. The originator "human" is
  // mandatory: only it leaves the quiet hint for the next turn.
  async function allStop() {
    if (!chatId) return;
    setStops("*all*");
    setError("");
    try {
      const response = await api<{ stopped?: string[] }>(`/api/chats/${chatId}/agents/stop`, {
        method: "POST",
        body: JSON.stringify({ from: "human" }),
      });
      // Nothing stopped means no background agent lived (the running ones belong to the turn). If the display kept quiet about it,
      // an ineffective click would look like an effective one.
      if (!response?.stopped?.length) {
        setError(t("No background agent was running — foreground agents are ended by stopping the chat."));
      }
    } catch (e) {
      setError(t("Could not stop: {msg}", { msg: String((e as Error)?.message || e) }));
    } finally {
      setStops("");
    }
  }

  // Empty means empty: ONE sentence, and only if the chat carries NO workflow either; a tree that is not loaded yet is not "no
  // workflow" (carriesWorkflow → null), so nothing shows until the route has answered. The same for graph starts (before the
  // route answers, `loaded: false`, "none" is not known, `bg.unloaded`); a wakeup is never "empty".
  const empty = bg.list.length === 0 && commands.length === 0 && monitors.length === 0 && !bg.wakeup
    && !(workflows && carriesWorkflow(workflows) !== false) && !bg.unloaded;
  const now = Date.now();
  // Does an entry still run? The state itself says (lib/bg-list.ts: subagent `live`, workflow "running", graph `graphOpen`): the
  // same split the tab counts from.
  const rows = bgRows({ active, finished, commands, monitors, wakeup: bg.wakeup, endedClosed, key: (e: Entry) => e.key });
  const card = (e: Entry) => e.kind === "workflow" ? (
    <DynWorkflowCard key={e.key} chatId={chatId} run={e.run} now={now}
      choice={workflowChoice?.runId === e.run.runId ? workflowChoice : null} />
  ) : e.kind === "graph" ? (
    <GraphRunCard key={e.key} chatId={chatId} run={e.graph} now={now} onStop={onGraphStop} onResponse={onGraphResponse} />
  ) : (
    <SubagentCard
      key={e.key}
      taskKey={e.key}
      agent={e.agent}
      selected={selected === e.agent.id}
      tempo={e.agent.live ? tempoProMinute(points.current.get(e.agent.id) ?? []) : null}
      stops={stops === e.agent.id}
      onSelect={() => onSelect(selected === e.agent.id ? "" : e.agent.id)}
      onStop={() => stop(e.agent)}
      switches={switches === e.agent.id}
      onBackground={() => intoTheBackground(e.agent)}
      onMessage={chatId && e.agent.live && e.agent.agentId ? () => {
        const st = cardsState(e.agent, t);
        setMessageTo({ address: e.agent.agentId!, name: e.agent.job || t("Subagent"), kind: t("Subagent"), state: st.word });
      } : undefined}
    />
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-agents-bar>
      {running && chatId && (
        <div className="px-3 pb-1.5">
          <button
            type="button"
            onClick={allStop}
            disabled={Boolean(stops)}
            data-agents-all-stop
            title={t("Stop all background agents of this chat — even without a running turn. The main agent learns about it in its next turn.")}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-edge px-2 py-1 text-[11.5px] text-dim transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <StopSquareIcon size={11} />
            {stops === "*all*" ? "…" : t("Stop all background agents")}
          </button>
        </div>
      )}

      {error && <div className="mx-3 mb-1.5 rounded-lg bg-danger/10 px-2.5 py-1.5 text-[11.5px] text-danger">{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
        {/* Two sections. "Running": running subagents and workflows, newest on top, below them the run's background commands and
            monitors (no start time, newest first). "Finished N": the rest, collapsible. Σ stands on the FIRST section; "Background
            Tasks" is the panel title (ChatRightSidebar). One card per entry, 6 px between cards, no divider. Both sections are ONE
            row list under ONE parent node (lib/bg-rows.ts, as on iOS): in two nodes React rebuilt the card of a workflow that ended
            under the eye in the second node as NEW, and the stopped run collapsed. The mark `data-bg-section` therefore sits on
            the section header (`SectionHeader`), not on a node around it. */}
        {rows.length > 0 && (
          <div className="space-y-1.5" data-bg-tasks>
            {rows.map((z) => z.kind === "header" ? (z.section === "running" ? (
              <SectionHeader key={z.key} section="running" word={t("Running")} sum={sum} header />
            ) : (
              // 12 px between the sections: `mt-3` on the "Finished" header; the 6 px of the predecessor coincide with it.
              <button key={z.key} type="button" onClick={() => setEndedTo((closed) => !closed)} aria-expanded={!endedClosed} data-bg-ended
                className={`block w-full rounded-md text-left focus-visible:outline-offset-[-2px] ${z.first ? "" : "mt-3"}`}>
                <SectionHeader section="ended" word={t("Finished")} count={finished.length} open={!endedClosed} sum={z.first ? sum : 0} header={z.first} />
              </button>
            )) : z.kind === "task" ? card(z.task) : z.kind === "wakeup" ? (
              <WakeupCard key={z.key} at={z.at} reason={bg.wakeupReason} now={now} stoppable={Boolean(chatId)} stops={stops === "wakeup"} onStop={() => { void wakeupStop(); }} />
            ) : z.kind === "command" ? (
              <ItemCard key={z.key} kind={t("Command")} text={z.item.description || t("Background command")} data={{ "data-bg-command": z.item.taskId || "" }} />
            ) : (
              <MonitorCard key={z.key} chatId={chatId} monitor={z.item} now={now} stops={stops === z.key} onStop={() => void monitorStop(z.key, z.item)} />
            ))}
          </div>
        )}
        {empty && (
          <p className="px-4 py-8 text-center text-[12px] leading-relaxed text-dim" data-agents-empty>
            {t("No background task has run in this chat yet. Subagents, workflows, background commands and alarms appear here — running as well as finished.")}
          </p>
        )}
        {workflows && workflows.additional > 0 && (
          <p className="mt-3 px-0.5 text-[11px] text-dim" data-dynwf-additional>
            {t("{n} older workflows of this chat are not shown.", { n: workflows.additional })}
          </p>
        )}
      </div>
      {messageTo && chatId && <AgentMessageSheet chatId={chatId} target={messageTo} onClose={() => setMessageTo(null)} />}
    </section>
  );
}

// An entry of the state in the form of the cards: key, whether it runs, and the data of its kind beside it (`e.agent`, `e.run` …).
function asEntry(z: BackgroundTasksState<Block>["list"][number]): Entry {
  return { key: z.key, running: z.running, ...z.data };
}

// Identifier, word and colour of a card, from `agent.state` (lib/agents.ts), not from a chain of its own. "done" is the state
// without an identifier: word "done", green like the outcome "done" in a workflow card's header; everything else comes from the
// table (running in accent, error red, stopped and without result dimmed: the same tones as the workflow header).
// `data-agents-status` carries the translated word (the probe reads it), `data-agents-state` the identifier: the same values as
// `data-agent-state` on the mark in the history.
function cardsState(a: Agent<Block>, t: (k: string, p?: Record<string, string | number>) => string) {
  const z = a.state;
  return z
    ? { identifier: z.identifier as AgentIdentifier | "finished", word: t(z.word), color: TONE_CLASS[z.tone] }
    : { identifier: "finished" as const, word: t("done"), color: "text-ok" };
}

function SubagentCard({ taskKey, agent, selected, tempo, stops, onSelect, onStop, switches, onBackground, onMessage }: {
  taskKey: string;
  agent: Agent<Block>;
  selected: boolean;
  tempo: number | null;
  stops: boolean;
  onSelect: () => void;
  onStop: () => void;
  switches: boolean;
  onBackground: () => void;
  /** "Message" to this subagent: only while it lives and cbase leads it (agentId); otherwise the button is missing. */
  onMessage?: () => void;
}) {
  const t = useT();
  const [stepsOpen, setStepsOpen] = useState(false);
  const st = cardsState(agent, t);
  const duration = agent.live && agent.startedAt
    ? elapsed(Date.now() - agent.startedAt)
    : typeof agent.durationMs === "number" ? elapsed(agent.durationMs) : "";
  const tok = tokenShort(agent.tokens, agent.tokenKind);
  const model = modelShort(agent.model);
  const title = agent.job || t("Subagent");
  // After the tokens the ONE thing left to say of a running agent: its pace (empty while too little was measured); parked at a
  // usage limit, the time it continues instead: a parked agent does not work, and "running" without a suffix would look like a hang.
  // "CPU saver": if a command waits for CPU before its start, that shows in the same place: it is not working right now.
  const addition = agent.live
    ? (agent.parkedUntil ? waitingUntilText(agent.parkedUntil, t) : agent.waitingForCpu ? t("waiting for CPU") : tempo !== null ? t("{n} tok/min", { n: fmtTokens(tempo) }) : "")
    : "";

  return (
    // The SUBAGENT's card: the same surface as the card of a workflow run (chat/DynWorkflowTree.tsx).
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card"
      data-agents-card data-bg-task={taskKey} data-agents-status={st.word} data-agents-state={st.identifier}
      data-agents-id={agent.id || undefined} data-open={selected ? "1" : undefined}>
      <div className="px-3 pb-2.5 pt-2">
        {/* The header: job, runtime, stop, like name, runtime, stop in the workflow header. */}
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={onSelect} aria-expanded={selected} data-agents-row
            title={`${title} — ${agent.model || t("Default")} · ${st.word}`}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {/* The arrow stands AFTER the title, so the rows below start flush with the title, without an indent for the arrow. */}
            <span className="min-w-0 truncate text-[13px] font-semibold" data-agents-job>{title}</span>
            <span className="shrink-0 text-dim"><Chevron open={selected} size={11} /></span>
          </button>
          {duration && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-dim" data-agents-time title={t("Duration")}>{duration}</span>
          )}
          {onMessage && (
            <SymbolButton onClick={onMessage} size={22} data={{ "data-agent-message": "" }}
              word={t("Message")}
              explanation={t("Write this subagent a message — even while the chat is idle.")}>
              <MessageIcon size={12} />
            </SymbolButton>
          )}
          {agent.live && agent.agentId && (
            <SymbolButton onClick={onStop} disabled={stops} danger size={22} data={{ "data-agents-stop": "" }}
              word={t("Stop")} explanation={t("Stop this subagent — the main agent receives “stopped by a human” as its result and keeps running.")}>
              {stops ? <SpinnerIcon size={12} /> : <StopSquareIcon size={11} />}
            </SymbolButton>
          )}
        </div>
        <div>
          {/* "Subagent <state>" left, the model right, like "Workflow <outcome>" and the phase in the workflow header. */}
          <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
            <span className="shrink-0 text-dim">{t("Subagent")}</span>
            <span className={`shrink-0 font-medium ${st.color}`} data-agents-word>{st.word}</span>
            <span className="min-w-0 flex-1 truncate text-right text-dim" title={agent.model || undefined}>
              {model && <span data-agents-model>{model}</span>}
            </span>
          </div>
          {/* The tokens: if the number is missing, a dash stands; an EMPTY spot would look like a zero. "≥" stands for "at least"
              (tokenShort); the whole word is in the title and in the report header. */}
          <div className="flex items-baseline gap-1.5 text-[11px] text-dim">
            <span className="min-w-0 flex-1 truncate">
              <span className="tabular-nums" data-agents-tokens title={typeof agent.tokens === "number" ? tokenText(agent.tokens, agent.tokenKind, t) : undefined}>{tok || "–"}</span>
              {` ${t("tokens")}`}
              {addition && <span className={agent.parkedUntil || agent.waitingForCpu ? "text-warn" : undefined} data-agents-addition>{` · ${addition}`}</span>}
            </span>
          </div>
          {/* "To background": only on a RUNNING foreground agent a call is waiting for. */}
          {agent.live && agent.foreground && agent.agentId && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={onBackground}
                disabled={switches}
                data-agents-background
                title={t("Send this subagent to the background — the waiting call returns at once, the main agent keeps working, and the report arrives on its own later.")}
                className="rounded-md border border-edge px-2 py-0.5 text-[11px] text-dim transition-colors hover:bg-accent/10 hover:text-fg disabled:opacity-50"
              >
                {switches ? "…" : t("Send to background")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Opened: a section of the SAME surface, only the hairline on top, like a phase of the workflow card. The report first (what the
          main agent read), the steps below (the reasoning). */}
      {selected && (
        <div className="border-t border-edge px-3 pb-2.5 pt-2" data-agents-selection>
          <div data-agents-report>
            <div className="mb-1 flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-dim">
                {t("Report")}
              </span>
              {/* Room for the whole sentence here: "at least" is spelled out where the row above has only "≥". */}
              {tokenLowerLimit(agent.tokenKind) && (
                <span className="shrink-0 text-[10px] tabular-nums text-dim">
                  {tokenText(agent.tokens, agent.tokenKind, t)}
                </span>
              )}
            </div>
            {agent.report ? (
              <div className="cb-chat-text leading-[1.7]" data-agents-report-text>
                <Markdown src={agent.report} />
              </div>
            ) : (
              <p className="text-[11.5px] leading-relaxed text-dim">
                {agent.live
                  ? t("The subagent is still working — its report appears here as soon as it is done.")
                  : t("No report: the run ended before the subagent delivered one.")}
              </p>
            )}
          </div>

          {/* Below, the steps, collapsible, in the same presentation as in the history (AssistantBlocks) so a tool call does not look
              different here. Report and steps carry `cb-chat-text` like the history: 15.5 px × text size, and the `cb-cs-*` steps of the
              tool rows compute with the same factor. Outside it `--cs` would stay 1 and the setting would not take effect here. */}
          {agent.steps.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setStepsOpen((v) => !v)}
                aria-expanded={stepsOpen}
                data-agents-steps
                className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-dim hover:text-fg"
              >
                {agent.steps.length === 1 ? t("1 step") : t("{n} steps", { n: agent.steps.length })}
                <Chevron open={stepsOpen} />
                {typeof agent.tools === "number" && agent.tools > 0 && (
                  <span className="ml-auto tabular-nums">{t("{n} tool calls", { n: agent.tools })}</span>
                )}
              </button>
              {stepsOpen && (
                <div className="cb-chat-text mt-1 border-l border-edge pl-2.5 leading-[1.7]" data-agents-steps-text>
                  <AssistantBlocks blocks={agent.steps} live={agent.live} ck={`agent:${agent.id}`} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// The header of a section: word, for "Finished" the count and chevron, on the right Σ on the first section. `header` carries the old
// identifiers of the heading (`data-bg-tasks-header`, `data-bg-tasks-sum`): the first visible section. It also carries
// `data-bg-section` ("running" | "ended").
function SectionHeader({ section, word, count, open, sum, header }: {
  section: "running" | "ended"; word: string; count?: number; open?: boolean; sum: number; header?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-baseline gap-1.5 px-0.5 pb-0.5" data-bg-section={section} data-bg-tasks-header={header ? "" : undefined}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{word}</span>
      {count !== undefined && <span className="text-[10.5px] tabular-nums text-dim">{count}</span>}
      {open !== undefined && <span className="self-center text-dim"><Chevron open={open} size={10} /></span>}
      <span className="flex-1" />
      {sum > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-dim" data-bg-tasks-sum={header ? "" : undefined}
          title={t("Tokens of every background task in this chat — subagents and workflows together")}>
          {t("Σ {tokens}", { tokens: fmtTokens(sum) })}
        </span>
      )}
    </div>
  );
}

// A running background command: the same surface as the other cards. Without stop (the server knows no human stop for it, see
// lib/running-tasks.ts `hasStop`) and without runtime (it carries no start time).
function ItemCard({ kind, text, data }: { kind: string; text: string; data: Record<string, string> }) {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card" data-bg-task {...data}>
      <div className="px-3 pb-2.5 pt-2">
        <div className="truncate text-[13px] font-semibold" title={text}>{text}</div>
        <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 text-dim">{kind}</span>
          <span className="shrink-0 font-medium text-accent">{t("running")}</span>
        </div>
      </div>
    </section>
  );
}

// ── Monitor, wakeup: the same surface, the same header (title, runtime, stop), below it "<kind> <state word>" in the colour of
// the state, on the right the most important thing of the entry. ──────────────────────────────────────────────

// A monitor (cbase_monitor, belongs to the chat): the title is the description, below it "Monitor running · reports every
// line|reports the end · since 3:12", then the command (or the WebSocket address) and the link to its log file in the output place;
// stop on the header as with the wakeup.
function MonitorCard({ chatId, monitor: m, now, stops, onStop }: { chatId: string | null; monitor: BackgroundItem; now: number; stops: boolean; onStop: () => void }) {
  const t = useT();
  const title = m.description || t("Monitor");
  const source = m.command || m.ws || "";
  const start = typeof m.startedAt === "number" && m.startedAt > 0 ? m.startedAt : 0;
  return (
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card" data-bg-task data-bg-monitor={m.taskId || ""} data-bg-report={m.report || "rows"}>
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={title}>{title}</span>
          {m.taskId && (
            <SymbolButton onClick={onStop} disabled={stops} danger size={22} data={{ "data-bg-monitor-stop": "" }}
              word={t("Stop")} explanation={t("Stop this monitor — the command ends and the main agent learns about it in its next turn.")}>
              {stops ? <SpinnerIcon size={12} /> : <StopSquareIcon size={11} />}
            </SymbolButton>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 text-dim">{t("Monitor")}</span>
          <span className="shrink-0 font-medium text-accent">{t("running")}</span>
          <span className="min-w-0 flex-1 truncate text-right tabular-nums text-dim" data-bg-monitor-kind>
            {[m.report === "end" ? t("reports the end") : t("reports every line"), start ? t("since {time}", { time: elapsed(now - start) }) : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {source && <div className="mt-0.5 truncate font-mono text-[11px] text-dim" title={source}>{source}</div>}
        {chatId && m.logPath && (
          <a href={outputUrl(chatId, m.logPath, true)} target="_blank" rel="noreferrer" data-bg-monitor-log
            className="mt-0.5 block truncate text-[11px] text-accent hover:underline" title={m.logPath}>
            {t("Open log")}
          </a>
        )}
      </div>
    </section>
  );
}

// The wakeup: the planned continuation of the main agent (cbase_wakeup), without a start time, with the wake time; the title is
// the reason the agent gave. It belongs to the chat (server runs/wakeup.js) and has a stop on the header like the monitor
// (lib/running-tasks.ts `hasStop`).
function WakeupCard({ at, reason, now, stoppable, stops, onStop }: { at: number; reason: string; now: number; stoppable: boolean; stops: boolean; onStop: () => void }) {
  const t = useT();
  return (
    <section className="overflow-hidden rounded-xl bg-panel cb-task-card" data-bg-task data-bg-wakeup>
      <div className="px-3 pb-2.5 pt-2">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={reason || undefined}>{reason || t("Alarm")}</span>
          {stoppable && (
            <SymbolButton onClick={onStop} disabled={stops} danger size={22} data={{ "data-bg-wakeup-stop": "" }}
              word={t("Stop")} explanation={t("Stop this wakeup — the chat will not be woken and the main agent learns about it in its next turn.")}>
              {stops ? <SpinnerIcon size={12} /> : <StopSquareIcon size={11} />}
            </SymbolButton>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5 text-[11px]">
          <span className="shrink-0 text-dim">{t("Alarm")}</span>
          <span className="shrink-0 font-medium text-accent">{t("waiting")}</span>
          <span className="min-w-0 flex-1 truncate text-right tabular-nums text-dim">
            {`${t("at {time}", { time: clockTime(at) })} · ${t("in {time}", { time: durationShort(Math.max(0, at - now)) })}`}
          </span>
        </div>
      </div>
    </section>
  );
}
