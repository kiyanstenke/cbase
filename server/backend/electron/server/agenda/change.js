// Change an agenda and send the event — the ONE write path for the route (the main agent through cbase_agenda_write,
// agenda/routes.js), for the server as driver (the item "request review" of the review gate, workflows/gates.js) and for the
// agenda keeper (POST …/agenda/upkeep, agenda/upkeep.js). A second writer with its own `harness/agenda` line would let the
// rail drift apart with the first new response shape.
//
// WHO may write is NOT checked here: the rule "only the main agent writes" sits at the route (senderOf), the keeper's at its
// route (run marker, quiet). The server writes directly as driver: the item belongs to the node, not to the model's discretion.
// What the store checks (chat exists, keeps an agenda, not archived — `code` chat_missing, no_agenda, archived) and what the
// computation checks (AgendaError, for the keeper with `code`) is thrown on; the caller translates.
//
// THE ORIGINATOR decides what happens besides the computation — all in the SAME transaction as writing the agenda:
//   main     (default — the main agent's route calls without it) sets the outcome of the open log rows PER ROW
//            (store.agendaUpkeepOutcome), the lock of a reverted stage and "outdated" on every row whose stage it reaches
//            itself — computed from the standing rows (store.agendaUpkeepStanding). The keeper's mark STAYS; if that changes
//            what a ring explains (`upkeep.afterwards`), it is a new revision even though the agenda stayed the same
//            (`newRevision`, store.agendaChange) — otherwise every client would keep the old explanation (same version ⇒ the
//            revision it has stays, web lib/agenda.ts)
//   server   changes only the agenda (the review gate) — no row, no lock, the mark stays
//   keeper   checks against `alt` (base, allowed operations, lock), after the computation the effect on the tree
//            (recheckUpkeep: no item goes backward in its computed status or past its lock), marks (if `keeper.mark`) and
//            writes its log rows (store.enterAgendaUpkeep)

import { sse } from "../runtime/sse.js";
import * as store from "../store.js";
import { agendaResponse, upkeepAfterwards, upkeepInput, recheckUpkeep, bringAlongUpkeep, bringAlongWriter, applyOps } from "./operations.js";

export const AGENDA_ORIGINATOR = Object.freeze(["main", "server", "keeper"]);

// The workspace's projects for writing (`project` on fresh/change): `[{ id, name }]` — an unknown workspace is `null`
// (unknown), not "no projects"; any project given is then an error instead of a silent assumption.
export function projectListOf(workspaceId) {
  const ws = store.getWorkspace(workspaceId);
  return ws ? (ws.projects || []).map((p) => ({ id: p.id, name: p.name })) : null;
}

// The log rows behind an agenda's marks — read only if an item carries one (most agendas carry none).
function upkeepRowsFor(chatId, agenda) {
  return (agenda?.steps || []).some((s) => s.upkeep) ? store.agendaUpkeepHistory(chatId) : [];
}

/**
 * The agenda in its response shape (agendaResponse) including what happened after each of the keeper's marks
 * (`upkeep.afterwards`) — the ONE read for route, event and tool. `agenda` = the agenda as read (or filtered,
 * agenda/operations.js onlyProject).
 */
export function agendaView(agenda, projects = null) {
  return agendaResponse(agenda, projects, { upkeepRows: upkeepRowsFor(agenda?.chatId, agenda), archived: agenda?.chatId ? store.agendaArchiveCount(agenda.chatId) : 0 });
}

/**
 * Change a chat's agenda according to `input` (the body without markers) — in ONE transaction (store.agendaChange), then the
 * event `harness/agenda`, unless the computation gave the same state.
 * @param {{ now?: number, originator?: "main"|"server"|"keeper", keeper?: { agentId: string, runId: string, mark: boolean, base: number } }} [o]
 * @returns {{ agenda: object, unchanged: boolean, deleted: string[], fresh: string[], changed: object[] }}  `agenda` in its
 *          response shape (agendaResponse), `fresh` = the ids of the created items in their order, `changed` = for the keeper
 *          its changes `[{ pointId, kind, prior, after }]` (empty otherwise)
 * @throws  AgendaError (computation, keeper check) or an error with `code` (store) — then nothing is written and nothing sent
 */
export function changeAgenda(chatId, workspaceId, input, { now = Date.now(), originator = "main", keeper = null, by = "main" } = {}) {
  if (!AGENDA_ORIGINATOR.includes(originator)) throw new Error(`changeAgenda: unknown originator ${JSON.stringify(originator)}`);
  if (originator === "keeper" && !(keeper?.agentId && keeper?.runId)) throw new Error("changeAgenda: the keeper needs agentId and runId");
  const id = String(chatId);
  const projects = projectListOf(workspaceId);
  let computation = null;
  let prior = null;
  let changed = [];
  const result = store.agendaChange(id, (old) => {
    prior = old;
    if (originator === "keeper") {
      computation = applyOps(old, upkeepInput(old, input, { base: keeper.base }), now, { projects });
      recheckUpkeep(old, computation);
      const p = bringAlongUpkeep(old, computation, { agentId: keeper.agentId, runId: keeper.runId, mark: keeper.mark !== false, now });
      computation = { ...computation, steps: p.steps };
      if (p.changed.length) {
        store.enterAgendaUpkeep(p.changed.map((g) => ({
          chatId: id, workspaceId, agentId: keeper.agentId, runId: keeper.runId, pointId: g.pointId, kind: g.kind,
          prior: g.prior, after: g.after, stage: g.stage, at: now,
        })));
      }
      // Response and hint carry the changes without the stage — it is internal to the log.
      changed = p.changed.map(({ stage: _stage, ...g }) => g);
      return computation;
    }
    computation = applyOps(old, input, now, { projects, archiveEntryOf: (pid) => store.agendaArchiveEntryOf(id, pid), by });
    // Always pass the standing rows — WHO sets an outcome or a lock (only the main agent) is decided in ONE place:
    // bringAlongWriter.
    const n = bringAlongWriter(old, computation, input, { originator, rows: store.agendaUpkeepStanding(id) });
    computation = { ...computation, steps: n.steps };
    if (n.touched.length || n.outdated.length) {
      // What the rings explain, before and after the outcome — the common case: the keeper set done, the main agent follows
      // with the same status (the agenda stays the same, the explanation becomes "confirmed").
      const marked = computation.steps.filter((s) => s.upkeep);
      const explained = () => {
        if (!marked.length) return "";
        const rows = store.agendaUpkeepHistory(id);
        return JSON.stringify(marked.map((s) => upkeepAfterwards(s.upkeep, s.id, rows)));
      };
      const beforehand = explained();
      store.agendaUpkeepOutcome(id, { touched: n.touched, outdated: n.outdated, at: now });
      if (explained() !== beforehand) computation = { ...computation, newRevision: true };
    }
    return computation;
  }, { now });
  const agenda = agendaView(result, projects);
  if (!result.unchanged) sse(id, { type: "harness", subtype: "agenda", chatId: id, agenda });
  const old = new Set((prior?.steps || []).map((s) => s.id));
  // `touched` = the points whose stored form changed or that are new (a restored subtree counts with all its points) — the
  // write answer of the tools names only these (mcp/tools/agenda.js), not the whole tree.
  const before = new Map((prior?.steps || []).map((s) => [s.id, JSON.stringify(s)]));
  const touched = result.unchanged ? [] : (computation?.steps || []).filter((s) => before.get(s.id) !== JSON.stringify(s)).map((s) => s.id);
  return {
    agenda,
    unchanged: Boolean(result.unchanged),
    deleted: computation?.deleted || [],
    archived: computation?.archived || [],
    restored: computation?.restored || [],
    touched,
    fresh: (computation?.steps || []).filter((s) => !old.has(s.id)).map((s) => s.id),
    changed: result.unchanged ? [] : changed,
  };
}
