// Routes: writing skills, history, trash, deletion requests, toggle. Every function takes ctx = { req, res, url, p, m }
// (sub-slices also id/sub/chat or wid/sub/ws) and returns NEXT if it is not responsible; any other return means "answered".
// The mutations themselves are computed by the ONE path skill-change.js.
//
//   skillWriteChatRoutes      (sub-slice of chats/routes.js chatRoutes — 404 and the archive lock come BEFORE the body there)
//     POST /api/chats/:id/skill-write    the tool cbase_skill_write: ONLY the main agent of a coding chat
//                                            (communication/sender.js senderOf === "coding", markers AFTER the model's
//                                            arguments, mcp/tools/skills.js), only with the toggle on
//   skillHistoryWorkspaceRoutes   (sub-slice of workspaces/routes.js workspaceRoutes)
//     GET  /api/workspaces/:wid/skill-history?skillId=&limit=   GET …/skill-deleted   GET …/skill-requests?status=
//     GET|PUT /api/workspaces/:wid/skill-settings
//   skillHistoryRoutes            (ROUTES in server.js)
//     POST /api/skill-history/:id/revert   GET /api/skill-requests/:id   POST /api/skill-requests/:id/decide

import { NEXT, readBody, send } from "../runtime/http.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { senderOf } from "../communication/sender.js";
import { focusedProject } from "../runs/system-prompt.js";
import { chatSkills } from "./skill-catalog.js";
import { managerLock } from "../runs/manager-lock.js";
import {
  SkillError, decideRequest, requestView, submitRequest, entryView, reportSkills, cleanStaleRequests, changeSkill, skillCreate, skillLevel,
  revert,
} from "./skill-change.js";

const ACTIONS = Object.freeze(["create", "change", "erase"]);
// Caps of the tool (the UI has none): the description is in the catalog of EVERY turn of every chat in the workspace.
export const SKILL_DESCRIPTION_MAX = 1000;
export const SKILL_GUIDE_MAX = 100_000;

const marker = (v) => (typeof v === "string" ? v : "");

function writeRefusal(role) {
  if (role === "subagent") {
    return T("Only this chat's main agent writes skills — you are a subagent. Read them with cbase_skill; put what should change into your report.");
  }
  if (role === "workflow") {
    return T("Only this chat's main agent writes skills — you are an agent of a dynamic workflow. What should change belongs in your result.");
  }
  return T("Only the main agent of a coding chat writes skills.");
}
const OFF_TEXT = () => T("Agents may not change skills in this workspace (the switch \"Agents may change skills\" under Coding → Skills is off).");

/** The short form of a skill in the tool's response. */
function toolSkill(s) {
  const pn = s.projectId ? store.getProject(s.projectId)?.name || "" : "";
  return { id: s.id, name: s.name, description: s.description || "", version: s.version, level: skillLevel(s), ...(pn ? { projectName: pn } : {}) };
}
const text = (v) => (typeof v === "string" ? v : undefined);
function checkTexts(description, guide) {
  if (description !== undefined && [...description].length > SKILL_DESCRIPTION_MAX) {
    throw new SkillError(400, { error: T`description: at most ${SKILL_DESCRIPTION_MAX} characters (tool cap — it is in every turn's catalogue)` });
  }
  if (guide !== undefined && [...guide].length > SKILL_GUIDE_MAX) {
    throw new SkillError(400, { error: T`guide: at most ${SKILL_GUIDE_MAX} characters (tool cap)` });
  }
}

// The project of a new project skill: from a project chat its project, from a workspace chat the named one (name or id).
function targetProject(chat, level, projectArg) {
  if (level === "workspace") return null;
  const focus = focusedProject(chat);
  const arg = String(projectArg ?? "").trim();
  const projects = store.getWorkspace(chat.workspaceId)?.projects || [];
  if (focus) {
    if (arg && arg !== focus.id && arg !== focus.name) {
      throw new SkillError(400, { error: T`From a project chat you create project skills only in its own project ("${focus.name}") — omit "project".` });
    }
    return focus.id;
  }
  if (!arg) throw new SkillError(400, { error: T("level \"project\" from a workspace chat: name the project (project = name or id).") });
  const p = projects.find((x) => x.id === arg) || projects.find((x) => x.name === arg) || projects.find((x) => x.name.toLowerCase() === arg.toLowerCase());
  if (!p) throw new SkillError(404, { error: T`No project "${arg}" in this workspace.` });
  return p.id;
}

function inSet(chat, id) {
  const sid = String(id ?? "").trim();
  if (!sid) throw new SkillError(400, { error: T("id is missing (from cbase_skill)") });
  const s = chatSkills(chat).find((x) => x.id === sid);
  if (!s) throw new SkillError(404, { error: T`No skill with id "${sid}" for this chat — read the skills with cbase_skill.` });
  return s;
}
function needsVersion(v) {
  if (typeof v !== "string" || !v.trim()) throw new SkillError(400, { error: T("version is missing — read the skill with cbase_skill first (field version).") });
  return v.trim();
}

function toolAction(chat, b) {
  const from = { who: "agent", chat };
  if (b.action === "create") {
    const name = String(b.name ?? "").trim();
    if (!name) throw new SkillError(400, { error: T("name is missing") });
    const description = text(b.description) ?? "";
    const guide = text(b.guide) ?? "";
    checkTexts(description, guide);
    const focus = focusedProject(chat);
    const level = b.level === undefined || b.level === null || b.level === "" ? (focus ? "project" : "workspace") : b.level;
    if (level !== "project" && level !== "workspace") throw new SkillError(400, { error: T("level: project | workspace") });
    const projectId = targetProject(chat, level, b.project);
    const { skill, entry } = skillCreate({ workspaceId: chat.workspaceId, projectId, name, description, body: guide, area: "coding" }, from);
    return [201, { ok: true, skill: toolSkill(skill), historyId: entry.id }];
  }
  if (b.action === "change") {
    const s = inSet(chat, b.id);
    const version = needsVersion(b.version);
    const fields = {};
    if (typeof b.name === "string" && b.name.trim()) fields.name = b.name.trim();
    if (text(b.description) !== undefined) fields.description = b.description;
    if (text(b.guide) !== undefined) fields.body = b.guide;
    checkTexts(fields.description, fields.body);
    const r = changeSkill(s.id, fields, from, { version });
    return [200, { ok: true, skill: toolSkill(r.skill), historyId: r.entry?.id ?? null, ...(r.unchanged ? { unchanged: true } : {}) }];
  }
  if (b.action === "erase") {
    const s = inSet(chat, b.id);
    const version = needsVersion(b.version);
    const { request, merged } = submitRequest(store.getSkill(s.id), from, { version, reason: text(b.reason) ?? "" });
    return [200, { ok: true, requested: true, requestId: request.id, ...(merged ? { merged: true } : {}) }];
  }
  throw new SkillError(400, { error: T`action: ${ACTIONS.join(" | ")}` });
}

export async function skillWriteChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
  if (sub === "/skill-write" && m === "POST") {
    const b = await readBody(req);
    if (!b || typeof b !== "object" || Array.isArray(b)) return send(res, 400, { error: T("The body must be an object — nothing written.") });
    // Who writes (the MCP server sets the markers AFTER the model's arguments): only the main agent of a coding chat.
    const role = senderOf(chat, { ofProfile: marker(b.ofProfile), workflowAgent: marker(b.workflowAgent), outerLoop: marker(b.outerLoop) });
    if (role !== "coding") return send(res, 403, { error: writeRefusal(role), role });
    if (!store.skillAgentsWrite(chat.workspaceId)) return send(res, 403, { error: OFF_TEXT(), off: true });
    // The second archive lock after the body (the first is BEFORE it in chatRoutes).
    if (store.getChat(id)?.archivedAt) return send(res, 409, { error: T("The chat is archived — read only. Restore it first."), archived: true });
    const { ofProfile: _p, workflowAgent: _w, outerLoop: _o, ...input } = b;
    try {
      const [status, body] = toolAction(store.getChat(id) || chat, input);
      return send(res, status, body);
    } catch (e) {
      if (e instanceof SkillError) return send(res, e.status, e.body);
      throw e;
    }
  }
  return NEXT;
}

export async function skillHistoryWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;
  if (sub === "/skill-history" && m === "GET") {
    const skillId = String(url.searchParams.get("skillId") || "").trim();
    const limit = Number(url.searchParams.get("limit")) || 50;
    return send(res, 200, { entries: store.skillHistoryList(wid, { skillId, limit }).map(entryView) });
  }
  if (sub === "/skill-deleted" && m === "GET") {
    return send(res, 200, { entries: store.skillDeletedEntries(wid).map(entryView) });
  }
  if (sub === "/skill-requests" && m === "GET") {
    const status = String(url.searchParams.get("status") || "");
    if (status && !store.SKILL_REQUEST_STATUS.includes(status)) return send(res, 400, { error: T`status: ${store.SKILL_REQUEST_STATUS.join(" | ")}` });
    cleanStaleRequests(wid);
    return send(res, 200, { requests: store.skillRequestsList(wid, status).map(requestView) });
  }
  if (sub === "/skill-settings" && m === "GET") return send(res, 200, { agentsWrite: store.skillAgentsWrite(wid) });
  if (sub === "/skill-settings" && m === "PUT") {
    const b = await readBody(req);
    // A missing field is no statement (400) — never silently "on" or "off".
    if (typeof b?.agentsWrite !== "boolean") return send(res, 400, { error: T("agentsWrite (true | false) is missing") });
    const enabled = store.setSkillAgentsWrite(wid, b.agentsWrite);
    reportSkills({ workspaceId: wid, kind: "setting" });
    return send(res, 200, { agentsWrite: enabled });
  }
  return NEXT;
}

export async function skillHistoryRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
  const zm = p.match(/^\/api\/skill-history\/([0-9a-f-]+)\/revert$/);
  if (zm && m === "POST") {
    // Managing is removed (runs/manager-lock.js): an entry of a managing skill is not reverted — that would restore or change
    // a skill of the managing department.
    const e = store.skillHistoryEntry(zm[1]);
    if (e && [store.getSkill(e.skillId)?.area, e.prior?.area, e.after?.area].includes("managing")) return send(res, 409, managerLock());
    try {
      const { skill } = revert(zm[1]);
      return send(res, 200, { ok: true, ...(skill ? { skill } : {}) });
    } catch (e) {
      if (e instanceof SkillError) return send(res, e.status, e.body);
      throw e;
    }
  }
  const requestMatch = p.match(/^\/api\/skill-requests\/([0-9a-f-]+)(\/decide)?$/);
  if (requestMatch && !requestMatch[2] && m === "GET") {
    const upfront = store.skillRequest(requestMatch[1]);
    if (upfront?.status === "open") cleanStaleRequests(upfront.workspaceId);
    const a = store.skillRequest(requestMatch[1]);
    return a ? send(res, 200, requestView(a)) : send(res, 404, { error: T("Request not found") });
  }
  if (requestMatch && requestMatch[2] && m === "POST") {
    const b = await readBody(req);
    if (typeof b?.approve !== "boolean") return send(res, 400, { error: T("approve (true | false) is missing") });
    try {
      const { request } = decideRequest(requestMatch[1], b.approve);
      return send(res, 200, { ok: true, request });
    } catch (e) {
      if (e instanceof SkillError) return send(res, e.status, e.body);
      throw e;
    }
  }
  return NEXT;
}
