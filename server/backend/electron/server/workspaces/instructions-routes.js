// The routes of the instructions for agents — a sub-slice of the owner `workspaceRoutes` (workspaces/routes.js);
// ctx carries `wid`, `sub`, `ws` there.
//
//   GET    /api/workspaces/:wid/instructions?projectId=        → { workspace: [S], project: [S] | null, cap }
//   POST   /api/workspaces/:wid/instructions                   { projectId, title, text, scope, enabled } → 201 { section }
//   PUT    /api/workspaces/:wid/instructions/order             { projectId, ids } → 200 { sections }
//   PUT    /api/workspaces/:wid/instructions/:aid              { title, text, scope, enabled, version } → 200 { section } | 409 { section }
//   DELETE /api/workspaces/:wid/instructions/:aid?version=     → 200 | 409 { section }
//   PUT    /api/workspaces/:wid/instructions/:aid/takeover     { projectId, takenOver } → 200 { takenOver }
//   GET    /api/workspaces/:wid/instructions/:aid/history      → { entries }
//
// Every field is required ("a missing field is not an instruction", 400); `projectId` is null for the workspace level.
// A project of another workspace, a section of another workspace: 404. Cap ⇒ 400 with the cap in the text. After every
// write the global event `instructions` { workspaceId, projectId } — the UI reloads.
// From project networks there is no row in the fence table (projectbox/fence-table.js): the default rejects — only the
// human maintains the instructions.
import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { broadcast } from "../runtime/sse.js";

export const INSTRUCTIONS_CAP = Object.freeze({ text: 20_000, title: 80, sections: 30 });
const SCOPES = store.SECTION_SCOPES;

const error = (res, status, code, text, extra = {}) => send(res, status, { ok: false, code, error: text, ...extra });
const report = (workspaceId, projectId) => { try { broadcast({ type: "instructions", workspaceId, projectId: projectId || null }); } catch { /* no streams */ } };
const publiclyVisible = (a, from = null) => ({
  id: a.id, title: a.title, text: a.text, scope: a.scope, enabled: a.enabled, pos: a.pos, version: a.version, updatedAt: a.updatedAt,
  ...(from ? { takenOver: !from.has(a.id) } : {}),
});

// The project of a body/query: null (workspace level), the project of this workspace, or `{ missing }`.
function projectOf(wid, raw) {
  if (raw === null || raw === "" || raw === undefined) return null;
  const p = store.getProject(String(raw));
  return p && p.workspaceId === wid ? p : { missing: true };
}

// Check the fields of a section. → { fields } or { error }.
function checkFields(b) {
  if (!b || typeof b !== "object") return { error: T("Body missing.") };
  const { title, text, scope, enabled } = b;
  if (typeof title !== "string" || typeof text !== "string" || typeof scope !== "string" || typeof enabled !== "boolean") {
    return { error: T("title, text, scope and enabled are required — a missing field is no instruction.") };
  }
  const t = title.trim();
  if (!t) return { error: T("The title is empty.") };
  if (t.length > INSTRUCTIONS_CAP.title) return { error: T`The title is longer than ${INSTRUCTIONS_CAP.title} characters (cap).` };
  if (text.length > INSTRUCTIONS_CAP.text) return { error: T`The text is longer than ${INSTRUCTIONS_CAP.text} characters (cap per section).` };
  if (!SCOPES.includes(scope)) return { error: T`scope must be one of ${SCOPES.join(", ")}.` };
  return { fields: { title: t, text, scope, enabled } };
}

async function body(req, res) {
  try { return { b: await readBody(req) }; } catch (e) {
    send(res, e?.status === 415 || e?.status === 413 ? e.status : 400, { ok: false, code: "BODY", error: String(e?.message || e) });
    return null;
  }
}

export async function instructionsWorkspaceRoutes(ctx) {
  const { req, res, url, m, wid, sub } = ctx;
  if (sub !== "/instructions" && !String(sub || "").startsWith("/instructions/")) return NEXT;

  if (sub === "/instructions" && m === "GET") {
    const proj = projectOf(wid, url.searchParams.get("projectId"));
    if (proj?.missing) return error(res, 404, "PROJECT", T("Project not found."));
    const out = proj ? store.agentSectionsOffInProject(proj.id) : null;
    return send(res, 200, {
      workspace: store.agentSectionsOfTheLevel(wid, null).map((a) => publiclyVisible(a, out)),
      project: proj ? store.agentSectionsOfTheLevel(wid, proj.id).map((a) => publiclyVisible(a)) : null,
      cap: INSTRUCTIONS_CAP,
    });
  }

  if (sub === "/instructions" && m === "POST") {
    const r = await body(req, res); if (!r) return undefined;
    const b = r.b;
    if (!b || typeof b !== "object" || !("projectId" in b)) return error(res, 400, "BODY", T("projectId is required (null for the workspace)."));
    const proj = projectOf(wid, b.projectId);
    if (proj?.missing) return error(res, 404, "PROJECT", T("Project not found."));
    const f = checkFields(b);
    if (f.error) return error(res, 400, "BODY", f.error);
    if (store.agentSectionsOfTheLevel(wid, proj?.id ?? null).length >= INSTRUCTIONS_CAP.sections) {
      return error(res, 400, "CAP", T`At most ${INSTRUCTIONS_CAP.sections} sections per level (cap).`);
    }
    const a = store.createAgentSection({ id: crypto.randomUUID(), workspaceId: wid, projectId: proj?.id ?? null, ...f.fields });
    report(wid, a.projectId);
    return send(res, 201, { ok: true, section: publiclyVisible(a) });
  }

  if (sub === "/instructions/order" && m === "PUT") {
    const r = await body(req, res); if (!r) return undefined;
    const b = r.b;
    if (!b || typeof b !== "object" || !("projectId" in b) || !Array.isArray(b.ids)) return error(res, 400, "BODY", T("projectId and ids are required."));
    const proj = projectOf(wid, b.projectId);
    if (proj?.missing) return error(res, 404, "PROJECT", T("Project not found."));
    if (!store.arrangeAgentSections(wid, proj?.id ?? null, b.ids)) {
      return error(res, 400, "ORDER", T("ids must list exactly the sections of this level, each once."));
    }
    report(wid, proj?.id ?? null);
    return send(res, 200, { ok: true, sections: store.agentSectionsOfTheLevel(wid, proj?.id ?? null).map((a) => publiclyVisible(a)) });
  }

  const tr = String(sub).match(/^\/instructions\/([^/]+)(\/takeover|\/history)?$/);
  if (!tr) return NEXT;
  let aid;
  try { aid = decodeURIComponent(tr[1]); } catch { return error(res, 400, "ID", T("Invalid id.")); }
  const a = store.agentSection(aid);
  if (!a || a.workspaceId !== wid) return error(res, 404, "SECTION", T("Section not found."));
  const kind = tr[2] || "";

  if (kind === "/history" && m === "GET") return send(res, 200, { entries: store.agentSectionHistory(a.id) });

  if (kind === "/takeover" && m === "PUT") {
    const r = await body(req, res); if (!r) return undefined;
    const b = r.b;
    if (!b || typeof b !== "object" || typeof b.takenOver !== "boolean" || !b.projectId) return error(res, 400, "BODY", T("projectId and takenOver are required."));
    if (a.projectId) return error(res, 400, "LEVEL", T("Only workspace sections can be adopted."));
    const proj = projectOf(wid, b.projectId);
    if (!proj || proj.missing) return error(res, 404, "PROJECT", T("Project not found."));
    const takenOver = store.setAgentSectionTakeover(a, proj.id, b.takenOver);
    report(wid, proj.id);
    return send(res, 200, { ok: true, takenOver });
  }

  if (kind === "" && m === "PUT") {
    const r = await body(req, res); if (!r) return undefined;
    const b = r.b;
    const f = checkFields(b);
    if (f.error) return error(res, 400, "BODY", f.error);
    if (!Number.isInteger(b.version)) return error(res, 400, "BODY", T("version is required (the state you edited)."));
    const e = store.changeAgentSection(a.id, f.fields, b.version);
    if (!e) return error(res, 404, "SECTION", T("Section not found."));
    if (e.conflict) return error(res, 409, "CONFLICT", T("The section changed meanwhile — reload."), { section: publiclyVisible(e.conflict) });
    report(wid, a.projectId);
    return send(res, 200, { ok: true, section: publiclyVisible(e.section) });
  }

  if (kind === "" && m === "DELETE") {
    const version = Number(url.searchParams.get("version"));
    if (!Number.isInteger(version) || !url.searchParams.has("version")) return error(res, 400, "BODY", T("version is required."));
    const e = store.deleteAgentSection(a.id, version);
    if (!e) return error(res, 404, "SECTION", T("Section not found."));
    if (e.conflict) return error(res, 409, "CONFLICT", T("The section changed meanwhile — reload."), { section: publiclyVisible(e.conflict) });
    report(wid, a.projectId);
    return send(res, 200, { ok: true });
  }

  return NEXT;
}
