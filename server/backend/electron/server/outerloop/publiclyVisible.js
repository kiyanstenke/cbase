// The public shape of an outer loop agent, run and note. ONE shape for the routes and the event `outer_loop` — two
// versions of the same response would drift apart with the first new field.
//
// publicAgent: the store shape + `chatTitle`, `chatKind` (origin chat: "normal" — so "go to chat" jumps; null for a chat
// that is gone and for a manager conversation — read-only, not a target), `projectName`, `effective`, `ineffectiveReason`
// (managing · off · without-model · without-provider — in this order: the seeded summarizer without both is
// "without-model", which the UI shows as "not running: no model"; "managing" is an agent with the dead area column that
// runs on no chat), `templateNew` (only the built-in ones, each against ITS template), `notTakenOverIn` (only origin
// workspace, else empty), `running` (count). Plus `fixed` (a built-in agent: not deletable, "reset to template"),
// `markUpkeep` (only for the keeper, else false — for every other agent the column carries a meaningless default) and
// `upkeepTally` (the keeper's tally, else null; store.agendaUpkeepTally).
// publicAgentShort: the store shape + `effective`, `ineffectiveReason` — the row of an agent in the chat info (GET
// /api/chats/:id/outer-loop), without the computations over other chats and projects. Complete in the fields the editor
// writes: whoever edits from the chat info never sends back an empty trigger or tool list just because the row did not
// carry it.
// publicRun: the store shape + `chatTitle` and `chatKind` (as above: "normal", else null — `chatTitle` null if the chat
// is gone) and `upkeep` (the tally of a run of the agenda keeper, else null). publicNote: the store shape + `agentName`.
// A `cache` (Map) saves the repeated queries of chat, project and agent per list.

import * as store from "../store.js";

import { effective } from "./activation.js";
import { templateOf } from "./template.js";

const fromCache = (cache, key, load) => {
  if (!(cache instanceof Map)) return load();
  if (!cache.has(key)) cache.set(key, load());
  return cache.get(key);
};
const chatOf = (id, cache) => (id ? fromCache(cache, `chat:${id}`, () => store.getChat(id) ?? null) : null);
const chatTitleOf = (id, cache) => chatOf(id, cache)?.title ?? null;
const chatKindOf = (id, cache) => { const c = chatOf(id, cache); return c && c.kind !== "manager" ? "normal" : null; };
const projectNameOf = (id, cache) => (id ? fromCache(cache, `project:${id}`, () => store.getProject(id)?.name ?? null) : null);

export function ineffectiveReason(agent) {
  if (agent.area === "managing") return "managing"; // activation.js areaMatches: never available
  if (!agent.enabled) return "off";
  if (!agent.model) return "without-model";
  if (!agent.provider) return "without-provider";
  return null;
}

// The area is in no response anymore — the column is dead, read only as an exclusion (activation.js areaMatches).
const withoutArea = ({ area: _tot, ...rest }) => rest;
// The keeper's fields on every shape: `fixed` for all built-in agents, `markUpkeep` true only for the keeper. `timeline`
// and `gapless` come with the store shape.
const upkeepFields = (agent) => ({ fixed: Boolean(agent.summarizer || agent.agendaKeeper || agent.timeline), markUpkeep: Boolean(agent.agendaKeeper && agent.markUpkeep) });
const agentOf = (id, cache) => (id ? fromCache(cache, `agent:${id}`, () => store.outerLoopAgent(id) ?? null) : null);
// Effective in the response means: runs where it is available — a managing agent is available nowhere (see ineffectiveReason).
const effectivePublic = (agent) => effective(agent) && agent.area !== "managing";

export function publicAgent(agent, { cache = null } = {}) {
  if (!agent) return null;
  const template = templateOf(agent);
  return {
    ...withoutArea(agent),
    ...upkeepFields(agent),
    upkeepTally: agent.agendaKeeper ? store.agendaUpkeepTally({ agentId: agent.id }) : null,
    chatTitle: chatTitleOf(agent.chatId, cache),
    chatKind: chatKindOf(agent.chatId, cache),
    projectName: projectNameOf(agent.projectId, cache),
    effective: effectivePublic(agent),
    ineffectiveReason: ineffectiveReason(agent),
    templateNew: Boolean(template && (agent.templateRevision ?? 0) < template.revision),
    notTakenOverIn: agent.origin === "workspace" ? store.outerLoopNotTakenOver(agent.id) : [],
    running: store.outerLoopRunningCount(agent.id),
  };
}

export function publicAgentShort(agent) {
  if (!agent) return null;
  return { ...withoutArea(agent), ...upkeepFields(agent), effective: effectivePublic(agent), ineffectiveReason: ineffectiveReason(agent) };
}

export function publicRun(run, { cache = null } = {}) {
  if (!run) return null;
  // The tally per run only for the keeper — for every other agent there is no log, `null` says "not applicable".
  const upkeep = agentOf(run.agentId, cache)?.agendaKeeper ? store.agendaUpkeepTally({ runIds: [run.id] }).get(String(run.id)) ?? null : null;
  return { ...run, chatTitle: chatTitleOf(run.chatId, cache), chatKind: chatKindOf(run.chatId, cache), upkeep };
}

export function publicNote(note, { cache = null } = {}) {
  if (!note) return null;
  const agentName = agentOf(note.agentId, cache)?.name ?? null;
  return { ...note, agentName };
}
