// Seeding the built-in agents: when a workspace is created (workspaces/routes.js) and at start (server.js, after
// migrateAutoChats) for every workspace that lacks one. Idempotent — a second call creates nothing; a deleted built-in
// agent (only via the workspace) never comes back with the workspace.
//
// THE ID of the summarizer is that of the workspace: one summarizer per workspace (partial UNIQUE index) and an id nobody
// else carries — and the only one that gets no new placeholder in the golden fixtures (a random UUID would renumber every
// `<id-N>` read later in db.json and spawn.json; the normalisation turns it into `<ws-1>`). It consists of hex digits and
// dashes like any other agent id, a route pattern `[0-9a-f-]+` matches it.
// Without model and provider, `enabled` = true: ineffective until a model is chosen — `default_new_since` stays NULL
// until it becomes effective (activation.js defaultSinceNew, set by the change route).
//
// The agenda keeper is seeded the same way, in the same two places, right after the summarizer: a native agent per
// workspace, not deletable, ineffective without a model. Its id is `<workspaceId>-a9e0da` — deterministic like the
// summarizer's (no new `<id-N>` in the golden fixtures), hex digits and dashes, and never that of a workspace (a
// workspace id is a UUID without a suffix).
//
// The timeline agent likewise, after the keeper: id `<workspaceId>-71e11e` (store.outerLoopTimelineAgentId — the store
// recognises it by the id, it has no column).

import * as store from "../store.js";
import { isUniqueViolation } from "../store.js";
import { AGENDA_KEEPER_TEMPLATE as P, TIMELINE_TEMPLATE as TL, SUMMARIZER_TEMPLATE as V } from "./template.js";

/** Seed the summarizer of a workspace if it is missing. → the summarizer (existing or new). */
export function seedSummarizer(wid, at = Date.now()) {
  const existing = store.outerLoopSummarizer(wid);
  if (existing) return existing;
  try {
    return store.createOuterLoopAgent({
      id: String(wid), workspaceId: String(wid), name: V.name, job: V.job, trigger: V.trigger,
      provider: "", model: "", effort: "", defaultNew: V.defaultNew, defaultNewSince: null, tools: [...V.tools], builtin: [...V.builtin],
      mcp: { ...V.mcp }, summarizer: true, templateRevision: V.revision, enabled: true, at,
    });
  } catch (e) {
    // A second seeder at the same time (start and route): the other was faster — its summarizer applies.
    if (isUniqueViolation(e)) return store.outerLoopSummarizer(wid);
    throw e;
  }
}

/** At start: one for every workspace without a summarizer. → the number newly seeded. */
export function seedMissingSummarizer(at = Date.now()) {
  let n = 0;
  for (const ws of store.listWorkspaces()) {
    if (store.outerLoopSummarizer(ws.id)) continue;
    seedSummarizer(ws.id, at);
    n += 1;
  }
  return n;
}

/** The id of a workspace's agenda keeper. */
export const agendaKeeperId = (wid) => `${wid}-a9e0da`;

/** Seed the agenda keeper of a workspace if it is missing. → the keeper (existing or new). */
export function seedAgendaKeeper(wid, at = Date.now()) {
  const existing = store.outerLoopAgendaKeeper(wid);
  if (existing) return existing;
  try {
    return store.createOuterLoopAgent({
      id: agendaKeeperId(wid), workspaceId: String(wid), name: P.name, job: P.job, trigger: P.trigger,
      provider: "", model: "", effort: "", defaultNew: P.defaultNew, defaultNewSince: null, tools: [...P.tools], builtin: [...P.builtin],
      mcp: { ...P.mcp }, agendaKeeper: true, markUpkeep: true, abortingTurn: true, templateRevision: P.revision, enabled: true, at,
    });
  } catch (e) {
    // A second seeder at the same time: its keeper applies (UNIQUE on the id or on the index per workspace).
    if (isUniqueViolation(e)) return store.outerLoopAgendaKeeper(wid);
    throw e;
  }
}

/** At start: one for every workspace without an agenda keeper. → the number newly seeded. */
export function seedMissingAgendaKeeper(at = Date.now()) {
  let n = 0;
  for (const ws of store.listWorkspaces()) {
    if (store.outerLoopAgendaKeeper(ws.id)) continue;
    seedAgendaKeeper(ws.id, at);
    n += 1;
  }
  return n;
}

/** The id of a workspace's timeline agent. */
export const timelineAgentId = (wid) => store.outerLoopTimelineAgentId(wid);

/** Seed the timeline agent of a workspace if it is missing. → the agent (existing or new). */
export function seedTimelineAgent(wid, at = Date.now()) {
  const existing = store.outerLoopTimelineAgent(wid);
  if (existing) return existing;
  try {
    return store.createOuterLoopAgent({
      id: timelineAgentId(wid), workspaceId: String(wid), name: TL.name, job: TL.job, trigger: TL.trigger,
      provider: "", model: "", effort: "", defaultNew: TL.defaultNew, defaultNewSince: null, tools: [...TL.tools], builtin: [...TL.builtin],
      mcp: { ...TL.mcp }, templateRevision: TL.revision, enabled: true, at,
    });
  } catch (e) {
    // A second seeder at the same time: its agent applies (UNIQUE on the id).
    if (isUniqueViolation(e)) return store.outerLoopTimelineAgent(wid);
    throw e;
  }
}

/** At start: one for every workspace without a timeline agent. → the number newly seeded. */
export function seedMissingTimelineAgents(at = Date.now()) {
  let n = 0;
  for (const ws of store.listWorkspaces()) {
    if (store.outerLoopTimelineAgent(ws.id)) continue;
    seedTimelineAgent(ws.id, at);
    n += 1;
  }
  return n;
}
