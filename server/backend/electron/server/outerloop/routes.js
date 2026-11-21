// Routes: outer loop. Every function takes ctx = { req, res, url, p, m } plus the fields of its family and returns NEXT if
// it is not responsible; any other return means "answered".
// Functions (all three are sub-slices of an owner):
//   outerLoopWorkspaceRoutes  in workspaces/routes.js workspaceRoutes, before tailWorkspaceRoutes —
//                             /api/workspaces/:wid/outer-loop…
//                             GET inventory (agents, catalog, triggers, template) · POST create (origin workspace or
//                             project) · GET/PATCH/DELETE …/:aid · POST …/:aid/reset (only the built-in ones) ·
//                             GET …/:aid/runs?limit&after=<runId>
//   outerLoopProjectRoutes    in projects/routes.js projectRoutes — /api/projects/:pid/workspace-outer-loop… (takeover of
//                             the workspace agents per project)
//   outerLoopChatRoutes       in chats/routes.js chatRoutes, after communicationChatRoutes — /api/chats/:id/outer-loop…
//                             (the analysis route behind cbase_chat_analysis; chat info, activation per chat, chat-owned
//                             agents, notes)
// Body checks: catalog.js checkAgentBody (fields) — here only what that function explicitly leaves to the route: origin
// (`projectId`, `chatId`) and unknown fields. Response shapes: publiclyVisible.js. Only the analysis route needs a fence
// entry (projectbox/fence-table.js) — no MCP tool calls the others.
//
// Three rules that apply here:
//   · AN UNKNOWN FIELD IS A 400 — as in store.changeOuterLoopAgent. A route that silently ignores a foreign field reports
//     a change as "saved" that never arrived. Likewise: a switch requires its field (`enabled`, `takenOver`), else 400.
//   · THE ORIGIN DOES NOT CHANGE: `projectId` exists only on create in the workspace, `chatId` never in the body (a
//     chat-owned agent is created in the chat info, path /api/chats/:id/outer-loop). For origin chat `defaultNew`
//     (checkAgentBody, 400) and `projectId` (here, 400) do not apply. The legacy area field is accepted and ignored.
//   · ARCHIVE: an archived chat accepts only reading via the chat routes — the lock in chats/routes.js comes BEFORE the
//     body, and every write here checks a second time AFTER the body, fresh from the DB (a PUT /archive during a slow
//     body). The wording is that of chats/routes.js archiveLock — it cannot be imported: chats/routes.js pulls this file
//     into its sub-table (an import back would close a cycle).
//
// Deleting an agent with a running run: NO 409 — `abortOuterLoop` (abort.js) sets the open runs to `aborted` and silences
// their cores via the aborter, THEN the rows fall. Only the built-in ones (summarizer, agenda keeper, timeline agent) are
// not deletable (409) — they are switched off. The switch `markUpkeep` belongs to the keeper only: a 400 on any other
// agent. Switching it off removes no marking already on an item.

import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { chatKind, isChildChat } from "../chats/genus.js";
import { abortOuterLoop } from "./abort.js";
import { activation, isTargetChat, defaultSinceNew, available, effective } from "./activation.js";
import { analysisResponse } from "./analysis.js";
import { triggerCatalog, outerLoopCatalog, checkAgentBody } from "./catalog.js";
import { publicAgent, publicAgentShort, publicRun, publicNote } from "./publiclyVisible.js";
import { SUMMARIZER_TEMPLATE as V, templateOf } from "./template.js";

// The fields of an agent body that checkAgentBody knows. `defaultNew` is listed for origin chat too: there checkAgentBody
// rejects it with its own wording, not as "unknown". `area` is listed so that an old client (which sends it) gets no
// "unknown field" — checkAgentBody ignores it.
const AGENT_FIELDS = Object.freeze(["name", "job", "trigger", "area", "provider", "model", "effort", "defaultNew", "tools", "builtin", "mcp", "enabled", "abortingTurn"]);
const NOTES_MAX = 200;
const RUNS_MAX = 500;
const CHAT_INFO_NOTES = 20;

const isObject = (b) => Boolean(b) && typeof b === "object" && !Array.isArray(b);
const error = (res, status, text, extra = {}) => send(res, status, { error: text, ...extra });
const notFound = (res) => error(res, 404, T("Outer-loop agent not found"));

/** Unknown fields of a body → 400 text or null. */
function foreignFields(b, allowed) {
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  return unknown.length ? T`Unknown field: ${unknown.join(", ")}` : null;
}

/** checkAgentBody without throwing: → { fields } or { status, error }. */
function checked(b, opts) {
  try { return { fields: checkAgentBody(b, opts) }; }
  catch (e) {
    if (e?.status) return { status: e.status, error: e.message };
    throw e;
  }
}

/** An integer from the query (empty = preset) → { value } or { error }. */
function countParam(url, name, { min, max, preset }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return { value: preset };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: T`${name}: integer ${min}–${max}` };
  }
  return { value: n };
}

/** Create an agent: defaults for the optional fields, `defaultNewSince` via defaultSinceNew. */
function createOne({ workspaceId, projectId = null, chatId = null, fields }) {
  const now = Date.now();
  const base = { enabled: true, provider: "", model: "", effort: "", defaultNew: false, ...fields };
  return store.createOuterLoopAgent({
    id: crypto.randomUUID(), workspaceId, projectId, chatId, ...base,
    defaultNewSince: defaultSinceNew(null, base, now), at: now,
  });
}

// ── Workspace ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function outerLoopWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;
  if (sub === "/outer-loop" && m === "GET") {
    const cache = new Map();
    return send(res, 200, {
      items: store.outerLoopAgentsOf(wid).map((a) => publicAgent(a, { cache })),
      catalog: outerLoopCatalog(wid),
      trigger: triggerCatalog(),
      template: { revision: V.revision },
    });
  }
  if (sub === "/outer-loop" && m === "POST") {
    const b = await readBody(req);
    if (!isObject(b)) return error(res, 400, T("Body: object required"));
    if ("chatId" in b) {
      return error(res, 400, T("chatId: an agent of a chat is created from the chat info (POST /api/chats/:id/outer-loop)"));
    }
    const unknown = foreignFields(b, [...AGENT_FIELDS, "projectId"]);
    if (unknown) return send(res, 400, { error: unknown });
    let projectId = null;
    if (b.projectId !== undefined && b.projectId !== null) {
      const proj = typeof b.projectId === "string" && b.projectId ? store.getProject(b.projectId) : null;
      if (!proj || proj.workspaceId !== wid) {
        return error(res, 400, T("projectId: not a project of this workspace"));
      }
      projectId = proj.id;
    }
    const r = checked(b, { workspaceId: wid, origin: projectId ? "project" : "workspace" });
    if (r.error) return send(res, r.status, { error: r.error });
    return send(res, 201, publicAgent(createOne({ workspaceId: wid, projectId, fields: r.fields })));
  }

  const loopMatch = sub.match(/^\/outer-loop\/([0-9a-f-]+)(\/reset|\/runs)?$/);
  if (!loopMatch) return NEXT;
  const rest = loopMatch[2] || "";
  const responsible = (rest === "" && ["GET", "PATCH", "DELETE"].includes(m)) || (rest === "/reset" && m === "POST")
    || (rest === "/runs" && m === "GET");
  if (!responsible) return NEXT;
  const agent = store.outerLoopAgent(loopMatch[1]);
  if (!agent || agent.workspaceId !== wid) return notFound(res);

  if (rest === "" && m === "GET") return send(res, 200, publicAgent(agent));

  if (rest === "" && m === "PATCH") {
    const b = await readBody(req);
    if (!isObject(b)) return error(res, 400, T("Body: object required"));
    if ("projectId" in b || "chatId" in b) {
      return error(res, 400, T("An agent's origin does not change (projectId, chatId) — create a new one"));
    }
    // `markUpkeep` only on the agenda keeper — on any other agent it is not an unknown but an unfitting field (own
    // sentence); checkAgentBody does not know it, it is checked and taken out here.
    const { markUpkeep, ...body } = b;
    if ("markUpkeep" in b) {
      if (!agent.agendaKeeper) {
        return error(res, 400, T("markUpkeep: only the agenda keeper has this switch"));
      }
      if (typeof markUpkeep !== "boolean") return error(res, 400, T("markUpkeep: true or false required"));
    }
    const unknown = foreignFields(body, AGENT_FIELDS);
    if (unknown) return send(res, 400, { error: unknown });
    const r = checked(body, { part: true, workspaceId: wid, origin: agent.origin });
    if (r.error) return send(res, r.status, { error: r.error });
    const fields = { ...r.fields, ...("markUpkeep" in b && markUpkeep !== agent.markUpkeep ? { markUpkeep } : {}) };
    const now = Date.now();
    const since = defaultSinceNew(agent, { ...agent, ...fields }, now);
    if (!Object.keys(fields).length && since === agent.defaultNewSince) return send(res, 200, publicAgent(agent));
    return send(res, 200, publicAgent(store.changeOuterLoopAgent(agent.id, { ...fields, defaultNewSince: since, at: now })));
  }

  if (rest === "" && m === "DELETE") {
    if (agent.summarizer) {
      return error(res, 409, T("The summarizer cannot be deleted — only switched off."), { summarizer: true });
    }
    if (agent.agendaKeeper) {
      return error(res, 409, T("The agenda keeper cannot be deleted — only switched off."), { agendaKeeper: true });
    }
    if (agent.timeline) {
      return error(res, 409, T("The timeline agent cannot be deleted — only switched off."), { timeline: true });
    }
    // First end the open runs (rows `aborted`, cores silenced), then take the rows.
    abortOuterLoop({ agentIds: [agent.id], reason: T("Agent deleted") });
    store.deleteOuterLoopAgent(agent.id);
    return send(res, 200, { ok: true });
  }

  if (rest === "/reset") {
    const vl = templateOf(agent);
    if (!vl) {
      return error(res, 400, T("Only the built-in agents (summarizer, agenda keeper, timeline) can be reset to their template"));
    }
    // Name, task, triggers, default for new chats and the tool selection from the template — provider, model, effort level
    // and `enabled` stay (otherwise a running summarizer would silently be off after the click). Per agent ITS template
    // (template.js); the keeper's `markUpkeep` stays as well — the template does not know the switch, it is a choice of the
    // human like `enabled`.
    const now = Date.now();
    const template = {
      name: vl.name, job: vl.job, trigger: vl.trigger.map((a) => ({ ...a })), defaultNew: vl.defaultNew,
      tools: [...vl.tools], builtin: [...vl.builtin], mcp: { ...vl.mcp }, templateRevision: vl.revision,
      // The dead column back to "coding": a built-in agent is not deletable — if it were on "managing" it would be
      // available on no chat, and the template would otherwise never bring it back.
      area: "coding",
    };
    const since = defaultSinceNew(agent, { ...agent, ...template }, now);
    return send(res, 200, publicAgent(store.changeOuterLoopAgent(agent.id, { ...template, defaultNewSince: since, at: now })));
  }

  if (rest === "/runs") {
    const limit = countParam(url, "limit", { min: 1, max: RUNS_MAX, preset: 50 });
    if (limit.error) return send(res, 400, { error: limit.error });
    // Paging with `after` = id of the LAST run of the previous page: the server resolves it to (started_at, rowid). The
    // old parameter `before` (a point in time, "strictly less") lost runs of the same millisecond at the page boundary —
    // it is a 400 with a hint, not silently ignored (an ignored cursor would return the first page again and again).
    if (url.searchParams.has("before")) {
      return error(res, 400, T("before: no longer supported — page with after=<id of the last run of the previous page>"));
    }
    const after = url.searchParams.get("after");
    if (after !== null && !after.trim()) return error(res, 400, T("after: id of a run required"));
    const page = store.outerLoopRunsOfAgent(agent.id, { limit: limit.value, after: after ? after.trim() : null });
    if (!page) return error(res, 400, T("after: not a run of this agent"));
    const cache = new Map();
    return send(res, 200, {
      items: page.items.map((l) => publicRun(l, { cache })), additional: page.additional, sum: store.outerLoopRunSum(agent.id),
    });
  }
  return NEXT;
}

// ── Project: takeover of the workspace agents ────────────────────────────────────────────────────────────────────────

export async function outerLoopProjectRoutes(ctx) {
  const { req, res, url, p, m, pid, sub, proj } = ctx;
  if (sub === "/workspace-outer-loop" && m === "GET") {
    const cache = new Map();
    const items = store.outerLoopAgentsOf(proj.workspaceId).filter((a) => a.origin === "workspace")
      .map((a) => ({ ...publicAgent(a, { cache }), takenOver: store.outerLoopTakenOver(a.id, proj.id) }));
    return send(res, 200, { items });
  }
  const workspaceMatch = sub.match(/^\/workspace-outer-loop\/([0-9a-f-]+)$/);
  if (workspaceMatch && m === "PATCH") {
    const b = await readBody(req);
    const agent = store.outerLoopAgent(workspaceMatch[1]);
    // Only agents with origin workspace (including the summarizer) are taken over; a project agent belongs to its project,
    // a chat-owned one to its chat.
    if (!agent || agent.workspaceId !== proj.workspaceId || agent.origin !== "workspace") return notFound(res);
    if (!isObject(b) || typeof b.takenOver !== "boolean") {
      return error(res, 400, T("takenOver: true or false required"));
    }
    const unknown = foreignFields(b, ["takenOver"]);
    if (unknown) return send(res, 400, { error: unknown });
    store.setOuterLoopTakeover(agent.id, proj.id, b.takenOver);
    return send(res, 200, { ok: true, agentId: agent.id, takenOver: b.takenOver });
  }
  return NEXT;
}

// ── Chat: chat info, activation, chat-owned agents, notes ────────────────────────────────────────────────────────────

// The lock a second time AFTER the body (see header) — the same wording as chats/routes.js archiveLock.
function archiveLock() {
  return { error: T("The chat is archived — read only. Restore it first."), archived: true };
}
function archivedNow(id) {
  return Boolean(store.getChat(id)?.archivedAt);
}

/** Why a chat is not a target of the outer loop — the sentence of the chat info and of the 400. */
function noTargetReason(chat) {
  if (isChildChat(chat)) {
    return T("Not an outer-loop target: a background run of a graph workflow — the chat that started it is observed.");
  }
  // The outer loop observes no manager conversations (activation.js isTargetChat); chatKind names them itself.
  return T`Not an outer-loop target: ${chatKind(chat)} — only regular coding chats are observed.`;
}

// The latest run of an agent on ONE chat, in any state (the chat info shows "last run …" with its error) — one store
// query per pair via the index (chat_id, agent_id, started_at).
const lastRunOn = (agentId, chatId) => store.outerLoopLastRunOn(agentId, chatId);

/** GET /api/chats/:id/outer-loop — the chat info. */
function chatState(chat) {
  const cache = new Map();
  const notes = store.outerLoopNotes(chat.id, { limit: CHAT_INFO_NOTES }).items.map((n) => publicNote(n, { cache }));
  if (!isTargetChat(chat)) return { targetChat: false, reason: noTargetReason(chat), agents: [], notes };
  const rows = store.outerLoopActiveRowsOfTheChat(chat.id);
  const running = new Set(store.outerLoopRunsOpen().filter((l) => l.chatId === chat.id).map((l) => l.agentId));
  const agents = store.outerLoopAgentsOf(chat.workspaceId).filter((a) => available(a, chat)).map((a) => {
    const current = activation(a, chat, { rows });
    return {
      ...publicAgentShort(a), active: current.active, source: current.source, since: current.since,
      // The switch only takes effect on a chat outside the archive and for an effective agent — otherwise it would stay
      // put after the click (active accounts for both). The route accepts the switch anyway (the row applies as soon as
      // the agent is effective).
      toggleable: !chat.archivedAt && effective(a),
      running: running.has(a.id),
      lastRun: publicRun(lastRunOn(a.id, chat.id), { cache }),
    };
  });
  return { targetChat: true, reason: "", agents, notes };
}

export async function outerLoopChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
  // cbase_chat_analysis: the marker of the run is in `run`, the action and its parameters in the query. Read-only — also
  // allowed in the archive (chats/routes.js archiveAllowed: every GET); but a run on an archived chat never starts
  // (activation.js).
  if (sub === "/outer-loop/analysis" && m === "GET") {
    const r = analysisResponse(chat, Object.fromEntries(url.searchParams));
    return send(res, r.status, r.body);
  }

  if (sub === "/outer-loop" && m === "GET") return send(res, 200, chatState(chat));

  // A chat-owned agent (origin chat): only the human creates it, only on a target chat.
  if (sub === "/outer-loop" && m === "POST") {
    const b = await readBody(req);
    if (archivedNow(id)) return send(res, 409, archiveLock());
    if (!isObject(b)) return error(res, 400, T("Body: object required"));
    if ("projectId" in b || "chatId" in b) {
      return error(res, 400, T("An agent of this chat takes neither projectId nor chatId in the body — it belongs to the chat in the path"));
    }
    const unknown = foreignFields(b, AGENT_FIELDS);
    if (unknown) return send(res, 400, { error: unknown });
    const now = store.getChat(id);
    if (!now) return error(res, 404, T("chat not found"));
    if (!isTargetChat(now)) return send(res, 400, { error: noTargetReason(now) });
    const r = checked(b, { workspaceId: now.workspaceId, origin: "chat" });
    if (r.error) return send(res, r.status, { error: r.error });
    const fields = { ...r.fields, defaultNew: false };
    return send(res, 201, publicAgent(createOne({ workspaceId: now.workspaceId, chatId: now.id, fields })));
  }

  if (sub === "/outer-loop/notes" && m === "GET") {
    const limit = countParam(url, "limit", { min: 1, max: NOTES_MAX, preset: 20 });
    if (limit.error) return send(res, 400, { error: limit.error });
    const before = countParam(url, "before", { min: 0, max: Number.MAX_SAFE_INTEGER, preset: null });
    if (before.error) return send(res, 400, { error: before.error });
    const agentId = (url.searchParams.get("agentId") || "").trim() || null;
    const page = store.outerLoopNotes(chat.id, { agentId, limit: limit.value, before: before.value });
    const cache = new Map();
    return send(res, 200, { items: page.items.map((n) => publicNote(n, { cache })), additional: page.additional });
  }

  // An agent on THIS chat on or off — the row in outer_loop_active (three-valued with "no row").
  const akm = sub.match(/^\/outer-loop\/([0-9a-f-]+)\/active$/);
  if (akm && m === "PUT") {
    const b = await readBody(req);
    if (archivedNow(id)) return send(res, 409, archiveLock());
    if (!isObject(b) || typeof b.enabled !== "boolean") return error(res, 400, T("enabled: true or false required"));
    const unknown = foreignFields(b, ["enabled"]);
    if (unknown) return send(res, 400, { error: unknown });
    const now = store.getChat(id);
    if (!now) return error(res, 404, T("chat not found"));
    if (!isTargetChat(now)) return send(res, 400, { error: noTargetReason(now) });
    const agent = store.outerLoopAgent(akm[1]);
    if (!agent || !available(agent, now)) {
      return error(res, 404, T("No outer-loop agent available on this chat"));
    }
    const prior = activation(agent, now);
    const row = store.outerLoopActiveRow(agent.id, now.id);
    // Unchanged ⇒ write nothing: `since` is the start of the first run — a second "on" would shift it. An "on" for an
    // already active agent (default, chat-owned) keeps its `since`: the switch confirms, it starts nothing.
    if (!row || row.enabled !== b.enabled) {
      store.setOuterLoopActive(agent.id, now.id, b.enabled, b.enabled && prior.active && prior.since !== null ? prior.since : Date.now());
    }
    const after = activation(agent, now);
    return send(res, 200, { ok: true, agentId: agent.id, enabled: b.enabled, active: after.active, source: after.source });
  }
  return NEXT;
}
