// The waiting room of open approvals: the map `pendingPermissions` and the ways a request leaves it again —
// `resolvePermission` (a single one, decided) and the rejections (`clearChatPermissions`, `clearAgentPermissions`).
//
// Why a leaf of its own: `runs/state.js:stopRun` must reject the open approvals on abort — a run waiting for an
// approval has no process to kill and would otherwise survive its own stop. A setter would be WRONG here: left
// unwired it silently does nothing, and that silence is exactly the fault. This file imports only `./hooks.js`,
// which has no imports itself; `permissions.js` re-exports the names.
//
// Ownership per AGENT: every open card carries its requesting agent — `agent: null` is the main run, otherwise
// `{ id, background }` (set by requestPermission from the request itself, never from the moment in time). Two
// rejection paths that cannot overlap, because every entry leaves the map exactly once:
//   - `clearChatPermissions` (turn end, stop): the main run and its FOREGROUND agents. A background agent's card
//     stays — it belongs to the agent, not the turn. "Background" is seen from the turn: also a grandchild its
//     parent agent waits for, and every agent of a core without a turn.
//   - `clearAgentPermissions` (an agent ends or is stopped, runs/agents.js): exactly ITS cards.
// No card stays without an owner: an agent whose record nobody knows anymore counts as foreground (agents.js
// `agentAsOwner`), and every agent ends eventually (settle ⇒ onFinish ⇒ clearAgentPermissions).

import { fireHooks } from "./hooks.js";


// Interactive permission prompts (permission modes "ask"/"auto-edit"): the cbase MCP server holds a long poll
// open until the user decides in the UI. requestId → {resolve,chatId,input,agent}.
const pendingPermissions = new Map();
function resolvePermission(requestId, decision, { origin = "user", reason = "" } = {}) {
  const p = pendingPermissions.get(requestId);
  if (!p) return false;
  clearTimeout(p.timer);
  pendingPermissions.delete(requestId);
  // Hook "afterPermission": the ruling line in the history, the event on the stream and the broadcast —
  // SYNCHRONOUSLY before resolving (no subscriber waits; the chain runs inside the call). The waiting tool call
  // sees its decision only afterwards.
  fireHooks("afterPermission", { chatId: p.chatId, request: p, decision, origin, reason });
  p.resolve(decision);
  return true;
}

// Resolve one open request as a rejection (both rejection paths): first out of the map, then the hook, then the
// resolve. The map is the lock against reporting twice.
function rejectFrom(rid, p, reason, origin) {
  clearTimeout(p.timer);
  pendingPermissions.delete(rid);
  const decision = { behavior: "deny", message: reason || "Run ended" };
  fireHooks("afterPermission", { chatId: p.chatId, request: p, decision, origin, reason: reason || "" });
  p.resolve(decision);
}

// Resolve the open requests of the MAIN RUN and its foreground agents (run end/abort) as rejections, so the
// waiting MCP calls return and the process can end cleanly. A background agent's cards stay: clearAgentPermissions
// rejects them when THAT agent ends. `origin`: where the rejection came from — it stands in the ruling line so it
// stays distinguishable from a no by the user.
function clearChatPermissions(chatId, reason, origin = "running") {
  for (const [rid, p] of [...pendingPermissions]) {
    if (p.chatId === chatId && !p.agent?.background) rejectFrom(rid, p, reason, origin);
  }
}

// Resolve the open requests of ONE agent (it ends or is stopped) — exactly its own, foreground or background;
// those of the main run and of other agents stay open.
function clearAgentPermissions(chatId, agentId, reason, origin = "running") {
  if (!agentId) return;
  for (const [rid, p] of [...pendingPermissions]) {
    if (p.chatId === chatId && p.agent?.id === agentId) rejectFrom(rid, p, reason, origin);
  }
}

// A foreground agent moves into the background (deadline or button): its OPEN cards move with it. A card's owner
// is fixed when the request arrives — without this update the turn end that the move triggers would reject the
// card of the agent now living in the background with "Run ended".
function agentCardsIntoTheBackground(chatId, agentId) {
  if (!agentId) return;
  for (const p of pendingPermissions.values()) {
    if (p.chatId === chatId && p.agent?.id === agentId) p.agent = { ...p.agent, background: true };
  }
}

export { agentCardsIntoTheBackground, clearAgentPermissions, clearChatPermissions, pendingPermissions, resolvePermission };
