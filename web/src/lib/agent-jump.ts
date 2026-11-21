// The jump "agent in the chat": a view outside the chat (the git overview — small in the bar, large
// under Projects → Git) names an agent that works on a branch, and a click opens ITS chat and there
// the right bar on "Agents" with exactly this agent.
//
// The key is the agentId, not the tool-call id: `parentToolUseId` can be synthetic (`agent:<id>`,
// providers/agent-runtime.js), and a re-parenting is not stored. The client resolves the bar's entry
// itself (`agentJumpTarget`): a subagent via `Agent.agentId` from lib/agents.ts (fallback `Agent.id` —
// one reported live without a tool call carries the agentId as id), an agent of a dynamic workflow via
// the progress tree (lib/dyn-tree.ts): there it is a row of its run (`runId`, number `n`).
//
// A DEDICATED window event `cbase-open-agent` with `{ chatId, agentId }` — the existing
// `cbase-open-chat` stays a plain string at its five senders. Two listen: app/workspaces/page.tsx
// switches the tab to "Chats", the hook components/chat/chatAgentJump.ts opens the chat and selects the
// agent once the history stands (`agentJumpStep`). A leaf module without imports (the test compiles it
// alone).

export const AGENT_EVENT = "cbase-open-agent";

export type AgentJump = { chatId: string; agentId: string };

/** Opens the chat and the agent in it — the way the views call. */
export function openAgent(chatId: string, agentId: string): void {
  if (!chatId || !agentId) return;
  window.dispatchEvent(new CustomEvent<AgentJump>(AGENT_EVENT, { detail: { chatId, agentId } }));
}

/** The event's detail, checked — a body without both ids is no jump. */
export function agentJumpFrom(detail: unknown): AgentJump | null {
  const d = detail as Partial<AgentJump> | null | undefined;
  if (!d || typeof d.chatId !== "string" || typeof d.agentId !== "string") return null;
  const chatId = d.chatId.trim();
  const agentId = d.agentId.trim();
  return chatId && agentId ? { chatId, agentId } : null;
}

/** Where the jump leads in the bar: a subagent (its `Agent.id`, the bar's selection) or the row of a workflow run. */
export type AgentJumpTarget = { kind: "agent"; id: string } | { kind: "workflow"; runId: string; n: number };

/** The selection of a workflow row in the bar (AgentBar → DynWorkflowCard): run and number of the agent() call; `nonce`
 *  makes a second jump to the same row a new selection (the card expands again even if it was collapsed). */
export type WorkflowChoice = { runId: string; n: number; nonce: number };

/** Finds the agent in the bar's list and in the progress tree — `null` as long as it is in neither. */
export function agentJumpTarget(
  agentId: string,
  agents: ReadonlyArray<{ id: string; agentId: string }>,
  runs: ReadonlyArray<{ runId: string; agents: ReadonlyArray<{ n: number; agentId: string }> }>,
): AgentJumpTarget | null {
  if (!agentId) return null;
  const sub = agents.find((a) => a.agentId === agentId) ?? agents.find((a) => a.id === agentId);
  if (sub?.id) return { kind: "agent", id: sub.id };
  for (const l of runs) {
    const z = l.agents.find((a) => a.agentId === agentId);
    if (z) return { kind: "workflow", runId: l.runId, n: z.n };
  }
  return null;
}

/** How long a jump waits for its chat — if it does not open within this time (it no longer exists), the jump lapses. */
export const AGENT_JUMP_VALID_MS = 30_000;
/** How long the opened chat waits for the agent in its list (progress tree still on the way, event not there yet)
 *  before only the bar opens. */
export const AGENT_JUMP_GRACE_PERIOD_MS = 3_000;

/** A waiting jump: `at` = sent, `readySince` = since when its chat has been open and loaded. */
export type AgentJumpWish = AgentJump & { at: number; readySince?: number };

export type AgentJumpStep =
  | { kind: "wait" }
  | AgentJumpTarget
  /** The chat is open, the agent is in no list after the grace period: only open the "Agents" bar. */
  | { kind: "bar" }
  /** The chat never opened: the jump lapses silently. */
  | { kind: "dismiss" };

/** The next step of a waiting jump. `ready` = the jump's chat is open and its history loaded. */
export function agentJumpStep(
  w: AgentJumpWish,
  situation: {
    ready: boolean;
    agents: ReadonlyArray<{ id: string; agentId: string }>;
    runs: ReadonlyArray<{ runId: string; agents: ReadonlyArray<{ n: number; agentId: string }> }>;
  },
  now: number,
): AgentJumpStep {
  if (!situation.ready) return now - w.at > AGENT_JUMP_VALID_MS ? { kind: "dismiss" } : { kind: "wait" };
  const target = agentJumpTarget(w.agentId, situation.agents, situation.runs);
  if (target) return target;
  return now - (w.readySince ?? now) >= AGENT_JUMP_GRACE_PERIOD_MS ? { kind: "bar" } : { kind: "wait" };
}
