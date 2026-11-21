// The routes of the timeline per project — a sub-slice of the owner `projectRoutes` (projects/routes.js, sub-table, like
// gitView/routes.js); ctx carries `pid`, `sub`, `proj` there.
//
//   GET  /api/projects/:pid/timeline?until=&untilId=&limit=&kind=&chat=&word=   read.js timelineList → { active, events, further, continueId } (human)
//   PUT  /api/projects/:pid/timeline            { active: boolean }  the switch; field missing / not a boolean ⇒ 400
//   POST /api/projects/:pid/timeline/:eid/dismiss  { justification }  the human dismisses: empty ⇒ 400, already dismissed ⇒ 409
//   POST /api/projects/:pid/timeline/agent      { action, …, outerLoop }  agent.js timelineAgentAction (only the timeline agent, 403)
//   GET  /api/projects/:pid/timeline/agent?outerLoop=&action=search|event&…  agent.js readTimelineAgent (its read tool)
//   POST /api/projects/:pid/timeline/:eid/revision  { title?, text?, justification? }  the human rephrases (revisions.js):
//        both fields missing ⇒ 400, dismissed ⇒ 409 DISMISSED, same ⇒ 409 UNCHANGED — a new revision, no new event
//   GET  /api/projects/:pid/timeline/proofs?chat=<id>  read.js timelineProofs → { ok, proofs, clipped } — the proofs of the
//        chat's agenda; `chat` missing ⇒ 400, a chat of another project ⇒ 404
//
// From project networks (fence, projectbox/fence-table.js): `…/timeline/agent` allowed (the agent runs in the project
// container, the route checks the marker), everything else refused — reading and dismissing belong to the human.
// Errors: `{ ok: false, code, error }`; an unexpected throw is 500 with a log line.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { timelineProofs, timelineList, timelineEvent } from "./read.js";
import { appendRevision } from "./revisions.js";
import { reportTimeline, timelineAgentAction, readTimelineAgent } from "./agent.js";
import { checkDismiss } from "./check.js";

const response = (res, r) => send(res, r.status, r.body);
const bodyError = (res, e) => send(res, e?.status === 415 || e?.status === 413 ? e.status : 400, { ok: false, code: "BODY", error: String(e?.message || e) });

export async function timelineRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
  const { sub, proj } = ctx;
  if (sub !== "/timeline" && !String(sub || "").startsWith("/timeline/")) return NEXT;
  try {
    if (sub === "/timeline" && m === "GET") {
      const q = url.searchParams;
      return send(res, 200, timelineList(proj, { until: q.get("until"), untilId: q.get("untilId"), limit: q.get("limit"), kind: q.get("kind"), chat: q.get("chat"), word: q.get("word") }));
    }
    if (sub === "/timeline" && m === "PUT") {
      let b;
      try { b = await readBody(req); } catch (e) { return bodyError(res, e); }
      if (!b || typeof b !== "object" || typeof b.active !== "boolean") {
        return send(res, 400, { ok: false, code: "BODY", error: T("active is missing or not a boolean — a missing field is no instruction.") });
      }
      const active = store.setTimelineActive(proj.id, b.active);
      reportTimeline(proj.id);
      return send(res, 200, { ok: true, active });
    }
    if (sub === "/timeline/agent" && m === "POST") {
      let b;
      try { b = await readBody(req); } catch (e) { return bodyError(res, e); }
      return response(res, await timelineAgentAction(proj, b));
    }
    if (sub === "/timeline/agent" && m === "GET") return response(res, readTimelineAgent(proj, url.searchParams));
    if (sub === "/timeline/proofs" && m === "GET") {
      const cid = String(url.searchParams.get("chat") || "").trim();
      if (!cid) return send(res, 400, { ok: false, code: "BODY", error: T("chat is missing — the evidence belongs to the agenda of ONE chat.") });
      const chat = store.getChat(cid);
      if (!chat || String(chat.projectId || "") !== String(proj.id)) return send(res, 404, { ok: false, code: "UNKNOWN", error: T("No such chat in this project.") });
      return send(res, 200, { ok: true, ...timelineProofs(proj, cid) });
    }
    const fa = String(sub).match(/^\/timeline\/([^/]+)\/revision$/);
    if (fa && m === "POST") {
      let b;
      try { b = await readBody(req); } catch (e) { return bodyError(res, e); }
      const eid = decodeURIComponent(fa[1]);
      const f = appendRevision(proj, eid, b, { from: "human" });
      if (f.error) return response(res, f.error);
      reportTimeline(proj.id);
      return send(res, 200, { ok: true, event: timelineEvent(proj.id, f.eventId, { forHuman: true }) });
    }
    const v = String(sub).match(/^\/timeline\/([^/]+)\/dismiss$/);
    if (v && m === "POST") {
      let b;
      try { b = await readBody(req); } catch (e) { return bodyError(res, e); }
      const eid = decodeURIComponent(v[1]);
      const pr = checkDismiss(proj, eid, b?.justification);
      if (pr.error) return response(res, pr.error);
      try { store.dismissTimeline({ eventId: pr.eventId, from: "user", justification: pr.justification }); } catch (e) {
        if (e?.code === "ALREADY_DISMISSED") return send(res, 409, { ok: false, code: "ALREADY_DISMISSED", error: T`${eid} is already discarded.` });
        throw e;
      }
      reportTimeline(proj.id);
      return send(res, 200, { ok: true, event: timelineEvent(proj.id, eid, { forHuman: true }) });
    }
  } catch (e) {
    console.error(`[timeline] ${m} ${p}:`, e?.message || e);
    return send(res, 500, { ok: false, code: "INTERN", error: String(e?.message || e) });
  }
  return NEXT;
}
