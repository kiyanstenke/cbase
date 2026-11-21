// Open background work — ONE query.
//
// "Is the chat running?" (`running`) used to see all work, because a live background agent kept the turn open. If the turn ends
// before its agents (run kind without hold, runs/hooks.js `hold`; the Coding chat), the archive, the idle gate (`busy` in
// /api/runs/active, also read by the gateway's idle reaper) and the "Active runs" pill would no longer see them. So all three
// ask HERE, and none counts by hand.
//
// Sources: the live subagents from their owner per chat (runs/agents.js, `kind: "agent"`) and the running dynamic workflows
// (`kind: "dynworkflow"`) through the hook `setBackgroundSource` — runs/ does not import the domain (import guard); the rows
// come from dynworkflows/run.js dynWorkflowsOpen, set in server.js (same pattern as setWithoutTurn). No switch: the query is made
// at EVERY turn end, and a switch would appear in the observed hook sequence of every run. Every row carries its `kind`. A third
// through `setGraphSource`: the open graph workflows a chat started in the background (`kind: "graphWorkflow"`,
// workflows/graph-start.js graphRunsOpen).
//
// Import rules: only runs/agents.js — neither the runs cluster (cycle guard) nor a domain (runs/ stays domain-free,
// import-direction.test.js).
import { workEmpty, liveAgents } from "./agents.js";
// The fourth source: the live MONITORS of a chat (`kind: "monitor"`, runs/monitors.js) — they outlive their turn like a subagent
// and therefore count like one: idle gate (a persistent one only for the gateway's idle reaper, runs/routes.js), work end (verdict and
// "end" hooks wait), agenda keeper, runtime-location move, archive (runs/archive.js: open work, nothing runs in the archive). Deleting
// does NOT wait for them — chats/erase.js closes them. runs/monitors.js is a leaf of this side; it reports its end through the hook below (backgroundEnds) so that the deferred
// verdict comes.
import { observeMonitors, liveMonitors } from "./monitors.js";

// The second source: `({ chatId }) => rows | undefined` (without chatId all chats). Unset (unit tests without a server) only
// the agents.
let domainSource = null;
export function setBackgroundSource(fn) { domainSource = typeof fn === "function" ? fn : null; }
// The third source: the open graph workflows a chat started in the background (`kind: "graphWorkflow"`; workflows/graph-start.js
// graphRunsOpen, set in server.js). Same shape as the second; its own setter instead of a list of sources — every source
// carries its kind, and none overwrites another. Unset: no rows.
let graphSource = null;
export function setGraphSource(fn) { graphSource = typeof fn === "function" ? fn : null; }

/**
 * The open background work, one row per live piece of work:
 * `{ kind: "agent", chatId, agentId, name, description, provider, model, startedAt }` or
 * `{ kind: "dynworkflow", chatId, runId, taskId, name, startedAt, step }` (`step`: belongs to the graph step its chat stands at
 * now — only such a one holds the turn of that step, see do-run.js holdMs) or
 * `{ kind: "monitor", chatId, taskId, name, description, report, startedAt, persistent, resuming? }` (resuming: a persistent one
 * between two resume attempts after a restart, runs/monitors.js) or
 * `{ kind: "graphWorkflow", chatId, startId, childChatId, runId, name, startedAt }` (`chatId` is the ORCHESTRATOR that started
 * the graph workflow in the background; it runs in the child chat `childChatId`).
 * With `chatId` only those of this chat. Empty means nothing open (the sources are process state, never "unknown").
 *
 * @param {string} [chatId]
 * @returns {Array<Object>}
 */
export function backgroundWork(chatId) {
  const out = [];
  for (const a of liveAgents()) {
    if (chatId && a.chatId !== chatId) continue;
    out.push({
      kind: "agent", chatId: a.chatId, agentId: a.agentId, name: a.name, description: a.description,
      provider: a.provider, model: a.model, startedAt: a.startedAt,
    });
  }
  const dyn = domainSource ? domainSource({ chatId }) : undefined;
  if (Array.isArray(dyn)) for (const z of dyn) if (!chatId || z.chatId === chatId) out.push({ ...z, kind: "dynworkflow" });
  const graph = graphSource ? graphSource({ chatId }) : undefined;
  if (Array.isArray(graph)) for (const z of graph) if (!chatId || z.chatId === chatId) out.push({ ...z, kind: "graphWorkflow" });
  for (const m of liveMonitors(chatId)) {
    out.push({ kind: "monitor", chatId: m.chatId, taskId: m.taskId, name: m.description, description: m.description, report: m.report, startedAt: m.startedAt, persistent: m.persistent === true, ...(m.resuming ? { resuming: true } : {}) });
  }
  return out;
}

// ── End of work the turn core does not own ─────────────────────────────────────────────────────────────────────
// A subagent reports its end to the turn holding it through the core (atEnd in do-run.js). A dynamic workflow lives outside
// every turn: when it ends, a turn waiting for it (graph step) asks again through this hook whether it still has to hold — and
// without a turn the deferred verdict is caught up (as with an agent, workEmpty).
const observer = new Map(); // chatId -> Set<fn>

/** A turn registers; the return value unregisters (in the run's finally). */
export function observeBackground(chatId, fn) {
  let set = observer.get(chatId);
  if (!set) observer.set(chatId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && observer.get(chatId) === set) observer.delete(chatId);
  };
}

/** A piece of this chat's background work has ended (dynworkflows/run.js). */
export function backgroundEnds(chatId) {
  for (const fn of [...(observer.get(chatId) || [])]) {
    try { fn(); } catch (e) { console.error("[background] observer:", chatId, e?.message || e); }
  }
  workEmpty(chatId);
}

// When a monitor ends, that is one piece of background work less: the same notification as the end of a dynamic workflow — a turn
// that observes asks again, and without a turn the deferred verdict comes.
observeMonitors((chatId, { kind }) => { if (kind === "end") backgroundEnds(chatId); });
