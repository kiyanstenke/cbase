// Is an outer loop agent active on a chat? Activation is computed, not written. Pure: reads the store, writes nothing —
// so none of the many creation paths of a chat has to do anything. Read by the chat routes, the triggers and the run.
//
//   isTargetChat(chat)          normal coding chats: archivable (chats/genus.js — kind "normal", no special role, no child
//                               chat of a graph workflow). A chat of a scheduled job is a target like any coding chat
//   areaMatches(agent, chat)    kind "normal" and the agent not from the area "managing" (a dead column that excludes
//                               those legacy agents — otherwise they would match every coding chat)
//   available(agent, chat)      same workspace and areaMatches; origin chat: exactly this chat; project: a chat of this
//                               project; workspace: without a project or taken over in the project. The timeline agent
//                               only on the chat of a project with the timeline switched on
//   effective(agent)            enabled ∧ provider ∧ model — the seeded summarizer is ineffective until a model is chosen
//   activation(agent, chat)     → { active, source, since } — `source` says WHY, in this order:
//                               no-target-chat · archived · not-available · ineffective · row-on · row-off · chat ·
//                               standard · timeline · no-default. Active are only row-on, chat (chat-owned agent without
//                               a row), standard ("default for new chats" and the chat was created from the time it
//                               applies) and timeline (the timeline agent on EVERY chat of a project with the timeline
//                               switched on, also an older one — on by default, opt-out per project; switch off per chat
//                               via the row, per project via the switch)
//   sinceFor(agent, chat)       from when the first run reads: the row "on", else the creation of the chat-owned agent,
//                               for the timeline agent the later of its seeding and the chat's creation (no re-reading of
//                               the whole history of every old chat), else the later of default time and chat creation
//   activeAgentsFor(chat)       → [{ agent, since }] — all active agents of a chat
//   defaultSinceNew(alt, fresh, now)  the new value of `default_new_since` on create (alt = null) or change

import * as store from "../store.js";
import { archivable } from "../chats/genus.js";

export const ACTIVE_SOURCES = Object.freeze(["row-on", "chat", "standard", "timeline"]);

export const isTargetChat = (chat) => Boolean(chat) && archivable(chat);

export const areaMatches = (agent, chat) => agent.area !== "managing" && chat.kind === "normal";

/** Is the timeline of this project switched off (opt-out per project)? Without a project: off. */
export function timelineOffFor(projectId) {
  if (!projectId) return true;
  // The domain's switch (store/timeline.js timelineActive: true | false | null = no project). If it is missing (a build
  // without the timeline), the project's store form applies — and without a project it is off.
  if (typeof store.timelineActive === "function") return store.timelineActive(projectId) !== true;
  const p = store.getProject(projectId);
  return !p || Boolean(p.timelineOff ?? p.timeline_off);
}

export function available(agent, chat) {
  if (!agent || !chat || agent.workspaceId !== chat.workspaceId || !areaMatches(agent, chat)) return false;
  // The timeline agent: only on the chat of a project whose timeline is on — a chat without a project never wakes it.
  if (agent.timeline && (!chat.projectId || timelineOffFor(chat.projectId))) return false;
  if (agent.origin === "chat") return agent.chatId === chat.id;
  if (agent.origin === "project") return Boolean(chat.projectId) && chat.projectId === agent.projectId;
  return !chat.projectId || store.outerLoopTakenOver(agent.id, chat.projectId);
}

export const effective = (agent) => Boolean(agent?.enabled && agent.provider && agent.model);

// The row of an agent on the chat — from `opts.rows` (Map agentId → { enabled, since }, one query for many agents:
// store.outerLoopActiveRowsOfTheChat), else read individually. `undefined` in the map means "no row".
const rowOf = (agent, chat, opts) => (opts?.rows instanceof Map ? opts.rows.get(agent.id) ?? null : store.outerLoopActiveRow(agent.id, chat.id));

/**
 * @param {object} agent  store.outerLoopAgent shape
 * @param {object} chat   store.getChat shape
 * @param {{ rows?: Map<string, { enabled: boolean, since: number }> }} [opts]
 * @returns {{ active: boolean, source: string, since: number|null }}
 */
export function activation(agent, chat, opts = {}) {
  const out = (source) => ({ active: false, source, since: null });
  if (!isTargetChat(chat)) return out("no-target-chat");
  if (chat.archivedAt) return out("archived");
  if (!available(agent, chat)) return out("not-available");
  if (!effective(agent)) return out("ineffective");
  const row = rowOf(agent, chat, opts);
  if (row) return row.enabled ? { active: true, source: "row-on", since: row.since } : out("row-off");
  if (agent.origin === "chat") return { active: true, source: "chat", since: agent.createdAt };
  const created = Number(chat.createdAt) || 0;
  // available() has already checked project and switch for it.
  if (agent.timeline) return { active: true, source: "timeline", since: Math.max(Number(agent.createdAt) || 0, created) };
  if (agent.defaultNew && agent.defaultNewSince !== null && agent.defaultNewSince !== undefined && created >= agent.defaultNewSince) {
    return { active: true, source: "standard", since: Math.max(agent.defaultNewSince, created) };
  }
  return out("no-default");
}

/** From when does the first run of an agent on this chat read? Without an active basis null. */
export function sinceFor(agent, chat, opts = {}) {
  const row = rowOf(agent, chat, opts);
  if (row?.enabled) return row.since;
  if (agent.origin === "chat") return agent.createdAt;
  if (agent.timeline) return Math.max(Number(agent.createdAt) || 0, Number(chat.createdAt) || 0);
  if (agent.defaultNewSince === null || agent.defaultNewSince === undefined) return null;
  return Math.max(agent.defaultNewSince, Number(chat.createdAt) || 0);
}

/** All active agents of a chat with their "since" — one query of the rows for all agents of its workspace. */
export function activeAgentsFor(chat) {
  if (!isTargetChat(chat) || chat.archivedAt) return [];
  const rows = store.outerLoopActiveRowsOfTheChat(chat.id);
  const out = [];
  for (const agent of store.outerLoopAgentsOf(chat.workspaceId)) {
    const a = activation(agent, chat, { rows });
    if (a.active) out.push({ agent, since: a.since });
  }
  return out;
}

/**
 * The new value of `default_new_since`. Set when an agent with `defaultNew` BECOMES effective or `defaultNew` is switched
 * on at an effective one; cleared (null) when `defaultNew` goes off; else it stays — also while the agent is ineffective
 * (when it becomes effective again the new time applies: no default catches up on chats from the time in between).
 * @param {object|null} old  the agent before (null on create)
 * @param {object} fresh     the agent after (at least enabled, provider, model, defaultNew)
 * @param {number} now
 */
export function defaultSinceNew(old, fresh, now) {
  if (!fresh?.defaultNew) return null;
  const prior = old?.defaultNewSince ?? null;
  if (!effective(fresh)) return old?.defaultNew ? prior : null;
  if (!old || !old.defaultNew || !effective(old) || prior === null) return Number(now);
  return prior;
}
