// Routes: the agenda per coding chat. Every function takes ctx = { req, res, url, p, m } (sub-slices of the chat family
// also id/sub/chat) and returns NEXT if it is not responsible; any other return means "answered".
// Functions: agendaChatRoutes (sub-slice of chats/routes.js chatRoutes — the archive and read-only locks sit there too,
// BEFORE the body: a PUT to an archived chat never arrives here).
//
//   GET /api/chats/:id/agenda                 this chat's agenda (empty = the same shape with an empty list, never 404)
//   GET /api/chats/:id/agenda?chatId=<target> the agenda of ANOTHER chat — only if :id may read it
//                                             (communication/visibility.js readableReason, the same rule as cbase_agents_list)
//   GET /api/chats/:id/agenda?list=1          the overview: every chat readable for :id with a non-empty agenda (capped;
//                                             counters and "next" over leaves only — a parent item has no status of its own)
//   GET …/agenda?project=<id or name>         (with or without chatId) only the subtrees whose top-level item carries this
//                                             project — the name case-insensitive, resolved in the workspace of the chat read;
//                                             the response says under `filter` that it is filtered and how many items the
//                                             whole agenda has
//   PUT /api/chats/:id/agenda                 one atomic change (agenda/operations.js) — ONLY the main agent of this coding
//                                             chat (communication/sender.js senderOf === "coding")
//   POST /api/chats/:id/agenda/upkeep         the agenda keeper brings it up to date (agenda/upkeep.js, tool
//                                             cbase_agenda_maintain): only from its running run on this chat (403), only in
//                                             a quiet chat (409 CHAT_WORKING), only on the state it read (409 STALE), only
//                                             fresh/status forward (400), never against a revert by the main agent (409 REVERTED)
//
// Every change goes as the event `harness/agenda` to the chat's stream (web: chat/chatAgenda.ts, iOS: ChatViewModel+Agenda) —
// the rail follows without polling. The agenda is a tree: route, event and tool give the items in preorder with computed
// status and the project at READ TIME (change.js agendaView: agendaResponse with the workspace's projects — a deleted project
// is null — and what happened after each mark of the agenda keeper); writing gets the workspace's projects for `project` on
// fresh/change.

import { NEXT, readBody, send } from "../runtime/http.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { AgendaError, nextStep, agendaCounter, onlyProject, findProject } from "./operations.js";
import { changeAgenda, agendaView } from "./change.js";
import { maintainAgenda } from "./upkeep.js";
import { senderOf } from "../communication/sender.js";
import { readableReason } from "../communication/visibility.js";
import { NOTE } from "../communication/foreign-text.js";

// The overview is capped — and says so (`additional`, `hint`): a list that cuts silently cannot be told from a complete one.
export const AGENDA_OVERVIEW_CAP = 30;

const ARCHIVE_TEXT = () => T("The chat is archived — read only. Restore it first.");
// "no manager chat" still applies: old manager chats remain readable in the database.
const NO_AGENDA = () => T("This chat keeps no agenda — only coding chats have one (no manager chat, special chat or app agent).");

// Who does NOT write, and what they do instead — the sentence goes to the model as the tool result.
function writeRefusal(role) {
  if (role === "subagent") {
    return T("Only this chat's main agent writes the agenda — you are a subagent. Read it with cbase_agenda; put what should change into your report.");
  }
  if (role === "workflow") {
    return T("Only this chat's main agent writes the agenda — you are an agent of a dynamic workflow. Read it with cbase_agenda; what should change belongs in your result.");
  }
  return T("Only this chat's main agent writes the agenda.");
}

const marker = (v) => (typeof v === "string" ? v : "");

// A chat's row in responses about OTHER chats: id, title, project, archived.
function chatHeader(c, projects) {
  return { id: c.id, title: c.title || "", projectName: projects.get(c.projectId) || "", archived: Boolean(c.archivedAt) };
}

function projectsOf(workspaceId) {
  return new Map((store.getWorkspace(workspaceId)?.projects || []).map((p) => [p.id, p.name]));
}

// The response of an agenda read, with the read filter `project` (id or name) — `{ agenda, filter? }` or `{ error }`.
function read(agenda, workspaceId, projectValue) {
  const projects = projectsOf(workspaceId);
  const value = String(projectValue ?? "").trim();
  if (!value) return { agenda: agendaView(agenda, projects) };
  const r = findProject(value, projects);
  if (r.error) return { error: T`project: ${r.error}.` };
  const part = onlyProject(agenda, r.project.id);
  return { agenda: agendaView(part, projects), filter: { project: r.project, points: part.steps.length, from: (agenda.steps || []).length } };
}

// The overview: every readable chat of the workspace with a non-empty agenda, active before archived, within that the most
// recently changed first — capped at AGENDA_OVERVIEW_CAP.
function overview(reader) {
  const projects = projectsOf(reader.workspaceId);
  const rows = [];
  for (const a of store.agendasInWorkspace(reader.workspaceId)) {
    if (a.chatId === reader.id || store.agendaIsEmpty(a)) continue;
    const c = store.getChat(a.chatId);
    if (!c || readableReason(reader, c) !== null) continue;
    rows.push({ chat: chatHeader(c, projects), title: a.title, counter: agendaCounter(a), next: nextStep(a), changedAt: a.changedAt });
  }
  rows.sort((x, y) => Number(x.chat.archived) - Number(y.chat.archived));
  const additional = Math.max(0, rows.length - AGENDA_OVERVIEW_CAP);
  return {
    agendas: rows.slice(0, AGENDA_OVERVIEW_CAP),
    additional,
    cap: AGENDA_OVERVIEW_CAP,
    ...(additional ? { hint: T`Cap: the overview shows at most ${AGENDA_OVERVIEW_CAP} agendas — ${additional} more are not listed (the most recently changed are at the top).` } : {}),
    note: NOTE,
  };
}

export async function agendaChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
  if (sub === "/agenda" && m === "GET") {
    if (url.searchParams.get("list")) return send(res, 200, overview(chat));
    const targetId = String(url.searchParams.get("chatId") || "").trim();
    const project = url.searchParams.get("project");
    if (targetId && targetId !== id) {
      const target = store.getChat(targetId);
      if (!target) return send(res, 404, { error: T("Chat not found") });
      const reason = readableReason(chat, target);
      if (reason) return send(res, 403, { error: reason });
      const g = read(store.readAgenda(target.id), target.workspaceId, project);
      if (g.error) return send(res, 400, { error: g.error });
      return send(res, 200, { chat: chatHeader(target, projectsOf(target.workspaceId)), agenda: g.agenda, ...(g.filter ? { filter: g.filter } : {}), keepsAgenda: store.chatKeepsAgenda(target), note: NOTE });
    }
    const g = read(store.readAgenda(id), chat.workspaceId, project);
    if (g.error) return send(res, 400, { error: g.error });
    return send(res, 200, { agenda: g.agenda, ...(g.filter ? { filter: g.filter } : {}), keepsAgenda: store.chatKeepsAgenda(chat) });
  }
  if (sub === "/agenda" && m === "PUT") {
    if (!store.chatKeepsAgenda(chat)) return send(res, 409, { error: NO_AGENDA() });
    const b = await readBody(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) return send(res, 400, { error: T("The body must be an object — nothing written.") });
    // Who writes (the MCP server sets the markers AFTER the model's arguments, mcp/tools/agenda.js): only the main agent.
    const role = senderOf(chat, { ofProfile: marker(b.ofProfile), workflowAgent: marker(b.workflowAgent), outerLoop: marker(b.outerLoop) });
    if (role !== "coding") return send(res, 403, { error: writeRefusal(role), role });
    const { ofProfile: _p, workflowAgent: _w, outerLoop: _o, ...input } = b;
    try {
      // The second archive lock (after the body) sits in the transaction itself: agendaChange reads the chat row fresh and
      // throws "archived" (store/agenda.js). Writing and event go through the ONE path (agenda/change.js, the review gate's too).
      const r = changeAgenda(id, chat.workspaceId, input);
      // Without effect (same state, say `steps: []` or a status that already held): no new version, no event — otherwise the
      // rail would show "updated just now" although nothing changed. The model is told.
      if (r.unchanged) return send(res, 200, { ok: true, unchanged: true, agenda: r.agenda });
      // An erase takes the whole subtree along — the response names which items went.
      return send(res, 200, { ok: true, agenda: r.agenda, ...(r.deleted.length ? { deleted: r.deleted } : {}) });
    } catch (e) {
      if (e instanceof AgendaError) return send(res, 400, { error: e.message });
      if (e?.code === "archived") return send(res, 409, { error: ARCHIVE_TEXT(), archived: true });
      if (e?.code === "no_agenda") return send(res, 409, { error: NO_AGENDA() });
      if (e?.code === "chat_missing") return send(res, 404, { error: "chat not found" });
      throw e;
    }
  }
  if (sub === "/agenda/upkeep" && m === "POST") {
    // The agenda keeper (agenda/upkeep.js): the body is read BEFORE all checks — after that the path runs synchronously until
    // after the transaction (quiet check and write with no await in between).
    const b = await readBody(req);
    const r = maintainAgenda(chat, b);
    return send(res, r.status, r.body);
  }
  return NEXT;
}
