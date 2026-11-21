// The ONE closing path of chat work. Every path that deletes a chat goes through here — otherwise each carries its own,
// incomplete list:
//   · `DELETE /api/chats/:id`                              (chats/routes.js, deleteChatPermanently)
//   · `DELETE /api/chat-folders/:id?permanently=1`         (chats/routes.js, deleteChatPermanently per chat)
//   · `DELETE /api/workspaces/:id`                         (workspaces/routes.js, closeChats + store.deleteWorkspace)
//   · rolling back a half-created fork                     (runs/routes.js, deleteChatPermanently)
// The CHECKS (running ⇒ 409, special chat ⇒ 400) stay with the caller — this only closes. The store stays domain-free: it
// deletes rows and reports the ids; cleanup happens HERE.
// "Running" means the same for EVERY delete path above: whatever would still write after closing and cannot be ended here
// — a turn, a compaction, a target verdict (runs/archive.js deleteObstacles, the same query as the archive). Rolling back
// a fork and permanently deleting a folder from the archive do not need it: the half fork never ran, nothing runs in the
// archive. What this path ends itself (subagents, workflows, queue, copy) does not hold it back.
// Archiving is NOT a delete path (its two terminal lines stay in chats/routes.js).
//
// Domains hook in through a hook kind, not through an import into `runs/`. The outer loop: running runs are silenced by
// the hook "chatClosed", the rows go in the row step (store.deleteOuterLoopChat), the sessions of the runs are collected
// in step 1 (chats/sessions.js).
//
// The child chats of background graph workflows go with their orchestrator — on EVERY path that closes it here, after it
// (first it, then its children). The rows linking them are removed by the orchestrator's row step (deleteGraphStartsFor)
// — so the children are read BEFORE. Their runs are stopped, where possible, by the caller beforehand (chats/routes.js
// DELETE, workflows/graph-start.js stopKindRuns); here only what is still standing falls (store.deleteChat closes an open
// run). When a workspace is deleted they come along through its rows.
//
// The CLI sessions: the chat takes its transcripts with it — its Claude session with `<sid>/`, its Codex rollouts and the
// sessions of its subagents, in ALL CLI homes; an id that another chat or subagent still carries (fork) stays. Collected
// at three points in time (before the rows, per chat before the subagent records, removed after ALL rows) —
// chats/sessions.js. That includes every PREVIOUS session (after `/clear`, `/compact`, a provider switch, a subagent
// restart — `previous_sessions`, written by two triggers in store/subagents.js); their rows fall here in the row step.
//
// Guards: `closePath.test.js` (every delete path clears the same list; no delete call bypasses this path),
// `terminal-tag.test.js`, `archive.test.js` (the call from both chat routes).

import { closeMonitors } from "../runs/monitors.js";
import { closeWakeup } from "../runs/wakeup.js";
import { killTerminalsByTag } from "../terminal.js";
import { userBrowserOpen } from "../browsers.js";
import { closeChatBrowser } from "../devtools/user-browser.js";
import * as store from "../store.js";
import * as artifactStore from "../artifacts.js";
import { cleanUpChatRuntime } from "../runs/runtime-location.js";
import { removeAsRoot } from "../projectbox/cleanUp.js";
import { pendingRunInputs } from "../runs/state.js";
import { agentWorktreeEntries, cleanUpAgentsWorktrees, closeAgentsOfTheChat } from "../runs/agents.js";
import { channelParticipantsDeleted } from "../channels/delivery.js";
import { newCollection, cleanUpSessions, collectChat, collectSubagents, sessionsBeforeDeletion } from "./sessions.js";

// ── Three parts ────────────────────────────────────────────────────────────────────────────────────────────────────────
//   1. Processes and hooks — `perChat` of the row step (here `closeAgentsOfTheChat`): AFTER the chat row, BEFORE the
//      other rows (the hook "chatClosed" still reads graph and run rows).
//   2. Rows — `rowsTheChats`: catches no exception, writes no file. It returns what still has to fall: the ids, the CLI
//      sessions (read BEFORE the rows, chats/sessions.js) and the worktrees of the subagents (read BEFORE their records).
//   3. Files and in-process state — `cleanUpChatFiles`: worktrees, terminals, the in-memory queue, runtime files,
//      artifacts, last the sessions (after ALL rows). Never throws.

/**
 * Close chats: channels closed, rows gone, everything on disk and in the process gone.
 *
 * @param {Object[]} chats  the chats that fall — read BEFORE deleting: closing their channels writes a note with their
 *                          name to the remaining participants, which only works while the row exists.
 * @param {() => (string[]|void)} [deleteRows]  the store deletion; default: `store.deleteChat` per chat. If it returns
 *                          ids (workspace deletion), cleanup covers those too — the store knows what fell.
 * @returns {string[]}      the ids that were cleaned up
 */
export function closeChats(chats, deleteRows = null) {
  const all = withChildren(chats);
  for (const chat of all) channelParticipantsDeleted(chat); // close its channels before it is gone
  const leftovers = rowsTheChats(all, chats.length, { deleteRows, perChat: closeAgentsOfTheChat });
  cleanUpChatFiles(leftovers);
  return leftovers.ids;
}

// Read the entries without toppling the closing path.
function worktreeEntriesSafe(id) {
  try { return agentWorktreeEntries(id); } catch (e) {
    try { console.warn(`[agent] ${id}: worktrees of the subagents not readable — ${e?.message || e}`); } catch { /* see above */ }
    return [];
  }
}

/**
 * Part 2: only the rows of the chats and their child chats. Catches no exception and writes no file; it does NOT close
 * channels (`closeChats` does).
 * @returns {{ ids: string[], sessions: Map<string, { worktrees: Set<string> }>, worktrees: Map<string, Array> }}  for part 3
 */
function rowsTheChats(all, countNamed, { deleteRows = null, perChat = null } = {}) {
  // Sessions, step 1: while the rows exist — read fresh (a turn may have advanced them since `chats` was read); with a
  // store deletion of the caller, those of every chat (the store only reports afterwards what fell).
  const prior = sessionsBeforeDeletion(deleteRows ? null : all.map((c) => c.id));
  let reported;
  if (deleteRows) {
    reported = deleteRows();
    // The caller's store deletion does not know the children — what it left standing falls here.
    const gone = new Set(Array.isArray(reported) ? reported : []);
    for (const c of all.slice(countNamed)) if (!gone.has(c.id)) store.deleteChat(c.id);
  } else {
    reported = all.map((c) => (store.deleteChat(c.id), c.id));
  }
  const ids = [...new Set([...all.map((c) => c.id), ...(Array.isArray(reported) ? reported : [])])];
  const sessions = newCollection();
  for (const id of ids) collectChat(sessions, prior.get(String(id)));
  const worktrees = new Map();
  for (const id of ids) {
    // Its subagents — including a parked one with its reset wakeup, including in a core whose turn is over.
    if (perChat) perChat(id);
    // Its monitors (runs/monitors.js) — silently, on every delete path: a watch would otherwise write into the output
    // folder of a deleted chat and wake a chat that no longer exists.
    closeMonitors(id);
    // Its wakeup (runs/wakeup.js) — silently: it would otherwise wake a chat that no longer exists.
    closeWakeup(id);
    // The outer loop: its chat-owned agents with their rows, plus runs, notes and activation of ALL agents on it — AFTER
    // the cores (the hook "chatClosed" silences running runs); a run that returns afterwards no longer finds its row and
    // writes nothing. The sessions of the runs are collected in step 1.
    store.deleteOuterLoopChat(id);
    // Its graph workflow starts — AFTER the cores: their hook "chatClosed" still reads the rows.
    store.deleteGraphStartsFor(id);
    // The worktrees of its subagents in a project's runtime folder — read BEFORE the records that name folder and repo;
    // removed in part 3.
    worktrees.set(id, worktreeEntriesSafe(id));
    // Sessions, step 2: those of its subagents — BEFORE the records that name them; removed only in part 3.
    collectSubagents(sessions, id);
    store.deleteSubagents(id); // their records with history — AFTER closing: a silenced core no longer writes
    store.deletePreviousSessions(id); // the previous sessions of the chat and its subagents — read in steps 1 and 2
    store.deleteChatHints(id); // silent hints for the next turn — here, because every path goes through here
    store.deleteAgenda(id); // the chat's agenda (store/agenda.js) — it falls with it, on every path
    store.deleteAgendaUpkeepChat(id); // the agenda keeper's log about this chat
  }
  return { ids, sessions, worktrees };
}

// The chats followed by their child chats, each once — the children at the end, in the order of their orchestrators.
// A child starts no background run (400 `kind`), so the chain is one level deep.
function withChildren(chats) {
  const seen = new Set(chats.map((c) => c.id));
  const children = [];
  for (const c of chats) {
    for (const id of store.graphChildChatIds(c.id)) {
      if (seen.has(id)) continue;
      const child = store.getChat(id);
      if (!child) continue;
      seen.add(id);
      children.push(child);
    }
  }
  return [...chats, ...children];
}

/** One chat, permanently — the path of the chat route, of the folder from the archive and of the fork rollback. */
export function deleteChatPermanently(chat) {
  closeChats([chat]);
}

/**
 * Part 3: what a chat leaves behind outside its rows — AFTER `rowsTheChats`, with its return value. Only here — a
 * second place would be the list that gets forgotten with the next addition. Never throws (each step reports itself).
 * @param {{ ids?: string[], sessions?: Map|null, worktrees?: Map<string, Array>|null }} leftovers
 */
function cleanUpChatFiles({ ids = [], sessions = null, worktrees = null } = {}) {
  for (const id of ids) tidyUp(id, worktrees?.get(id) || []);
  // Sessions, step 3: only after ALL rows — what a chat or subagent then still carries (a fork) stays.
  if (sessions) cleanUpSessions(sessions, { rootFallback: removeAsRoot });
}

function tidyUp(id, worktreeEntries) {
  // The worktrees of its subagents in a project's runtime folder — the row step read the entries.
  cleanUpAgentsWorktrees(id, { rootFallback: removeAsRoot, entries: worktreeEntries });
  killTerminalsByTag(`chat:${id}`); // the shells of this chat's terminal bar
  pendingRunInputs.delete(id);
  // The chat's runtime files — in EVERY location (runs/runtime-location.js): flat and in every project runtime folder,
  // because after the rows are deleted nobody knows which project the chat was last in (and a project switch can leave
  // remains at the old location). The ONE list lives there (chatTraces): scratch, `.mcp.json`, the MCP files of the
  // subagents (`<id>.agent-<n>[.workflow].mcp.json`), the legacy `<id>.agents`, the attachments, the output folder (it
  // lives until HERE, not until the agent ends), the browser profiles of the chat and its subagents with their
  // Playwright configs. A root-owned remainder (EACCES, root in the project container) goes to `docker exec -u root …
  // rm -rf` (projectbox/cleanUp.js), otherwise a message is logged.
  // If the chat's browser is running, close it first and wait (its logins go back into the pools, browsers.js) — only
  // then does its profile fall with the other traces; otherwise right away.
  if (userBrowserOpen(`chat:${id}`)) void closeChatBrowser(id).then(() => cleanUpChatRuntime(id, { rootFallback: removeAsRoot }));
  else cleanUpChatRuntime(id, { rootFallback: removeAsRoot });
  artifactStore.removeChatArtifacts(id);
}
