// The jump "agent in the chat" from outside, as a hook: `useAgentJump(…)` → `{ workflowChoice }`. A view outside the chat
// calls `openAgent(chatId, agentId)` (lib/agent-jump.ts); the event `cbase-open-agent` lands here.
//
// Flow: the hook remembers the wish and opens the chat via `cbase-open-chat`, the SAME path as bell, channel bar and pill
// (ChatPane `onOpenChat` opens via `openTarget`, the page puts the tab on "Chats"). If its chat is already open the
// receiver opens nothing anew (`alreadyOpen` in lib/archive.ts `openTargetProcedure`); the wish then finds it loaded in the next
// step. After that it waits until the chat is open and its history loaded, and looks for the agent in the bar's list
// (`agentJumpStep`): a subagent goes through `onAgentOpen` (same hand as the marker in the history: "Agents" bar open,
// exactly this one selected), an agent of a dynamic workflow opens the bar and selects its row in the progress tree
// (`workflowChoice` → AgentBar → DynWorkflowCard unfolds run and phase). If it is in no list after the grace period, only
// the bar opens; if the chat never opens, the wish lapses silently.
//
// Why a hook: ChatPane sits at the line guard; only the call stays there. Only in the chat tab itself, never in the chat of
// a scheduled job (`disabled` = ChatPane `onlyChat`): otherwise two ChatPanes would open the same jump.
import { useEffect, useRef, useState } from "react";
import { AGENT_EVENT, agentJumpFrom, agentJumpStep, type AgentJumpWish, type WorkflowChoice } from "@/lib/agent-jump";
import type { DynTreeStatus } from "@/lib/dyn-tree";

/** How often a waiting jump re-asks, even without a new event (the grace period would never expire otherwise). */
const TICK_MS = 250;

export function useAgentJump({ off: disabled, activeId, chatLoading, agents, dynTree, onAgentOpen }: {
  off: boolean;
  activeId: string | null;
  chatLoading: boolean;
  agents: ReadonlyArray<{ id: string; agentId: string }>;
  dynTree: DynTreeStatus;
  /** ChatPane `onAgentOpen`: selects the subagent (`""` = none) and opens the bar on "Agents". */
  onAgentOpen: (id: string) => void;
}) {
  const wish = useRef<AgentJumpWish | null>(null);
  const [tick, setTick] = useState(0);
  const [workflowChoice, setWorkflowChoice] = useState<WorkflowChoice | null>(null);
  const open = useRef(onAgentOpen);
  open.current = onAgentOpen;

  useEffect(() => {
    if (disabled) return;
    const on = (e: Event) => {
      const s = agentJumpFrom((e as CustomEvent<unknown>).detail);
      if (!s) return;
      wish.current = { ...s, at: Date.now() };
      setTick((x) => x + 1);
      window.dispatchEvent(new CustomEvent("cbase-open-chat", { detail: s.chatId }));
    };
    window.addEventListener(AGENT_EVENT, on);
    return () => window.removeEventListener(AGENT_EVENT, on);
  }, [disabled]);

  // The choice of a workflow row belongs to the jump's chat; a chat switch takes it back (otherwise the card would select
  // it again on return). Before the effect below: if the jump falls in the same step, its choice wins.
  useEffect(() => { setWorkflowChoice(null); }, [activeId]);

  useEffect(() => {
    const w = wish.current;
    if (!w) return;
    const now = Date.now();
    const ready = activeId === w.chatId && !chatLoading;
    // The grace period counts from the moment the chat stands loaded, not from the click (a large history loads for seconds).
    w.readySince = ready ? (w.readySince ?? now) : undefined;
    const step = agentJumpStep(w, { ready, agents, runs: dynTree.runs }, now);
    if (step.kind === "wait") {
      const t = setTimeout(() => setTick((x) => x + 1), TICK_MS);
      return () => clearTimeout(t);
    }
    wish.current = null;
    if (step.kind === "dismiss") return;
    if (step.kind === "workflow") setWorkflowChoice({ runId: step.runId, n: step.n, nonce: now });
    open.current(step.kind === "agent" ? step.id : "");
  }, [tick, activeId, chatLoading, agents, dynTree]);

  return { workflowChoice };
}
