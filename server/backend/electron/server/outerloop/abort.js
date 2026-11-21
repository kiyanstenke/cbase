// Aborting running outer loop runs when an agent, project or workspace is deleted: no 409, no stop button — deleting ENDS
// the runs. The seam between the delete paths (A: agent route, projectbox/erase.js, DELETE /api/workspaces/:id) and the run
// (B: cores, timers, follow-up markers), without A importing anything from B:
//
//   abortOuterLoop({ agentIds, runIds, reason })
//                                           FIRST the rows — `running` and `parked` of these agents or exactly these runs
//                                           become `aborted` (store.outerLoopRunsAbortOf / …AbortIds; a parked one would
//                                           otherwise keep a wakeup for a deleted agent) —, THEN the aborter, if set.
//                                           Synchronous, never throws. `runIds`: deleting a project aborts only the runs
//                                           working THERE — a workspace agent keeps running on the chats of other projects.
//   setOuterLoopAborter(fn)                 B sets it in server.js: `fn({ agentIds, runIds })` silences the cores of these
//                                           agents or runs and clears timers and follow-up markers. It does NOT need to
//                                           write the rows — that has already happened.
//   outerLoopTurnStart({ chat })            subscriber "outer-loop-turn" of the hook `turnStart`: aborts the open runs of
//                                           every agent with the switch `abortingTurn` on this chat (see there).
//
// Without an aborter (a test without the run layer, a start before the wiring) only the rows are `aborted`. A run that
// returns afterwards writes nothing: `outerLoopRunApplies` is false, and the store's state setters only touch open rows.
// Two imports (the store facade and the import-free leaf of the codes), no domain — so the file stays a leaf every delete
// path can pull in without a cycle.

import { outerLoopAgent, outerLoopRunsAbortIds, outerLoopRunsAbortOf, outerLoopRunsParked, outerLoopRunsOpen } from "../store.js";
import { INTENDED_END } from "./intended-end.js";

let aborter = null;

/** B: set the aborter (null takes it back). */
export function setOuterLoopAborter(fn) {
  aborter = typeof fn === "function" ? fn : null;
}

/**
 * End the open runs of these agents (or exactly these runs) — called BEFORE their rows are deleted.
 * @param {{ agentIds?: string[], runIds?: string[], reason?: string }} o
 * @returns {{ agentIds: string[], runs: number, runIds?: string[] }}  `runs`: how many rows went from open to aborted
 */
export function abortOuterLoop({ agentIds = [], runIds = [], reason = "deleted" } = {}) {
  const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).map(String).filter(Boolean))];
  const lids = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter(Boolean))];
  if (!ids.length && !lids.length) return { agentIds: [], runs: 0 };
  const who = [...ids, ...lids].join(", ");
  let runs = 0;
  try { runs = (ids.length ? outerLoopRunsAbortOf(ids, reason) : 0) + (lids.length ? outerLoopRunsAbortIds(lids, reason) : 0); } catch (e) {
    console.error(`[outer-loop] runs of ${who} not aborted: ${e?.message || e}`);
  }
  if (aborter) {
    try { aborter(lids.length ? { agentIds: ids, runIds: lids } : { agentIds: ids }); } catch (e) {
      console.error(`[outer-loop] aborter for ${who} threw: ${e?.message || e}`);
    }
  }
  return lids.length ? { agentIds: ids, runIds: lids, runs } : { agentIds: ids, runs };
}

/**
 * Hook `turnStart` (subscriber "outer-loop-turn", server.js): when a turn starts in the observed chat, it aborts the open
 * runs (`running`, `parked`) of EVERY agent with the switch "abort on new message" (`abortingTurn`) ON THIS CHAT — code
 * `INTENDED_END.turn`, the watermark stays, the next trigger reads the track anew. An agent with the switch off keeps
 * running; a trigger in the meantime (e.g. "after every run end") queues via the follow-up marker (run.js). The agenda
 * keeper carries the switch on (it decided on a state the main agent now continues to write), the timeline agent off.
 * Synchronous, never throws (a hook must not hold up the turn). → the aborted run ids (empty if none ran).
 */
export function outerLoopTurnStart({ chat } = {}) {
  try {
    const chatId = String(chat?.id || "");
    if (!chatId) return [];
    const open = [...outerLoopRunsOpen(), ...outerLoopRunsParked()].filter((l) => l.chatId === chatId);
    const abort = new Map();
    const runIds = open.filter((l) => {
      if (!abort.has(l.agentId)) abort.set(l.agentId, outerLoopAgent(l.agentId)?.abortingTurn === true);
      return abort.get(l.agentId);
    }).map((l) => l.id);
    if (runIds.length) abortOuterLoop({ runIds, reason: INTENDED_END.turn });
    return runIds;
  } catch (e) {
    console.error(`[outer-loop] abort at turn start failed: ${e?.message || e}`);
    return [];
  }
}
