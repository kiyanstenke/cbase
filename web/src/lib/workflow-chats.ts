// Which chats currently have an open dynamic workflow — for the chat list's working indicator. A dynamic workflow runs OUTSIDE
// the turn: the global stream's `running` does not know it, and the hexagon stood still while it computed.
//
// The only source is the global stream /api/events: its initial state carries `dynWorkflows: [{ chatId, runId }]` (runtime/sse.js),
// afterwards the event `dyn_workflow` `{ chatId, runId, open }` reports start and end of every run (dynworkflows/run.js
// `reportGlobal`). Counted per runId — a chat can have two runs at once, and the end of one must not delete the other's indicator.
// An initial state without the field (an older backend) means "none known", not an error: the events after it are right anyway.
// A leaf module without imports; guard web/test/workflow-chats.test.mjs.

export type WorkflowChats = ReadonlyMap<string, ReadonlySet<string>>;

export const WORKFLOW_EVENT = "dyn_workflow";

export const NO_WORKFLOW_CHATS: WorkflowChats = new Map();

/** From the initial state's field `dynWorkflows`; anything that is no `{ chatId, runId }` row is dropped. */
export function workflowChatsFromInit(dynWorkflows: unknown): WorkflowChats {
  const state = new Map<string, Set<string>>();
  if (!Array.isArray(dynWorkflows)) return state;
  for (const z of dynWorkflows) {
    const chatId = (z as { chatId?: unknown })?.chatId;
    const runId = (z as { runId?: unknown })?.runId;
    if (typeof chatId !== "string" || !chatId || typeof runId !== "string" || !runId) continue;
    const runs = state.get(chatId) ?? new Set<string>();
    runs.add(runId);
    state.set(chatId, runs);
  }
  return state;
}

/** The state after a `dyn_workflow` event; an event without chat or run changes nothing (the same reference). */
export function workflowChatsApply(state: WorkflowChats, evt: { chatId?: unknown; runId?: unknown; open?: unknown }): WorkflowChats {
  const { chatId, runId, open } = evt;
  if (typeof chatId !== "string" || !chatId || typeof runId !== "string" || !runId || typeof open !== "boolean") return state;
  const prior = state.get(chatId);
  if (open ? prior?.has(runId) : !prior?.has(runId)) return state;
  const next = new Map(state);
  const runs = new Set(prior ?? []);
  if (open) runs.add(runId); else runs.delete(runId);
  if (runs.size) next.set(chatId, runs); else next.delete(chatId);
  return next;
}

/** Is the chat working — a turn runs OR a dynamic workflow is open? */
export const chatWorking = (id: string, running: ReadonlySet<string>, workflows: WorkflowChats) =>
  running.has(id) || workflows.has(id);
