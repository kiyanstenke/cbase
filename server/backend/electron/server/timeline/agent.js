// The timeline agent's write and read path: `POST /api/projects/:id/timeline/agent`, plus the read path
// `GET …/timeline/agent` for its read tool.
//
// WHO: only a RUNNING run of the timeline agent on a chat of THIS project — the marker `outerLoop` = `<agentId>:<runId>`
// (403 NO_RUN, the same shape as agenda/upkeep.js checkUpkeepMarker). Whether an agent is the timeline agent is told by the
// trait `timeline === true` on the agent from store.outerLoopAgent (built by outerloop/) — ONE place: isTimelineAgent.
// A workflow marker means "not an outer-loop run" (precedence as in communication/sender.js) ⇒ 403.
//
// Order: body (400 BODY) → marker (403) → switch off (409 OFF) → action (400 BODY) → check of the action (check.js, `revise`
// revisions.js) → write → event `timeline` to all streams.
import crypto from "node:crypto";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { no, checkEnter, checkCollect, checkDismiss } from "./check.js";
import { timelineEvent, searchTimeline } from "./read.js";
import { appendRevision } from "./revisions.js";

export const AGENT_ACTIONS = Object.freeze(["enter", "collect", "dismiss", "revise"]);
export const AGENT_READ_ACTIONS = Object.freeze(["search", "event"]);
/** The fields per action, plus the markers the MCP server sets AFTER the arguments. */
const MARKERS = ["action", "outerLoop", "ofProfile", "workflowAgent"];
export const AGENT_FIELDS = Object.freeze({
  enter: Object.freeze([...MARKERS, "kind", "title", "text", "citation", "anchor", "tags", "agendaItemId"]),
  collect: Object.freeze([...MARKERS, "collectionId", "parts"]),
  dismiss: Object.freeze([...MARKERS, "eventId", "justification"]),
  // A new revision of title/text — revisions.js.
  revise: Object.freeze([...MARKERS, "eventId", "title", "text", "justification"]),
});

/** Is this outer-loop agent the timeline agent? The trait is provided by outerloop/. */
export const isTimelineAgent = (agent) => agent?.timeline === true;

const marker = (v) => (typeof v === "string" ? v.trim() : "");
const shortId = () => `tl_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** An event `timeline` to all global streams. */
export const reportTimeline = (projectId) => { try { broadcast({ type: "timeline", projectId: String(projectId) }); } catch { /* the stream is only the fast path */ } };

/**
 * Check the marker. → `{ agent, run, chat }` or `{ error }` (403 NO_RUN). `isTimeline` is a seam for the guard — the default
 * is isTimelineAgent.
 */
export function checkTimelineMarker(proj, value, { isTimeline = isTimelineAgent } = {}) {
  const error = no(403, "NO_RUN", T("rejected: no running timeline-agent run on a chat of this project — only the timeline agent writes and reads the timeline, within its own run.")).error;
  const s = marker(value);
  const i = s.indexOf(":");
  if (i <= 0 || i === s.length - 1) return { error };
  const agentId = s.slice(0, i);
  const run = store.outerLoopRun(s.slice(i + 1));
  if (!run || run.state !== "running" || run.agentId !== agentId) return { error };
  const chat = store.getChat(run.chatId);
  if (!chat || String(chat.projectId || "") !== String(proj.id)) return { error };
  const agent = store.outerLoopAgent(agentId);
  if (!agent || !isTimeline(agent) || agent.workspaceId !== proj.workspaceId) return { error };
  return { agent, run, chat };
}

const out = () => no(409, "OFF", T("This project's timeline is switched off — nothing written.")).error;

/** POST …/timeline/agent. → `{ status, body }`. */
export async function timelineAgentAction(proj, body, { now = Date.now(), isTimeline = isTimelineAgent, checkCommit } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return no(400, "BODY", T("The body must be an object — nothing written.")).error;
  if (marker(body.workflowAgent)) return checkTimelineMarker(proj, "").error;
  const m = checkTimelineMarker(proj, body.outerLoop, { isTimeline });
  if (m.error) return m.error;
  if (store.timelineActive(proj.id) !== true) return out();
  if (!AGENT_ACTIONS.includes(body.action)) return no(400, "BODY", T`action is one of ${AGENT_ACTIONS.join(", ")}.`).error;
  const unknown = Object.keys(body).filter((k) => !AGENT_FIELDS[body.action].includes(k));
  if (unknown.length) return no(400, "BODY", T`Unknown fields for ${body.action}: ${unknown.join(", ")} — nothing written.`).error;
  const runId = m.run.id;

  if (body.action === "enter") {
    const p = await checkEnter(proj, body, checkCommit ? { checkCommit } : {});
    if (p.error) return p.error;
    // There was an await (git) between check and write: marker (is the run still running?), switch and duplicate once more —
    // the store catches the duplicate a second time.
    const m2 = checkTimelineMarker(proj, body.outerLoop, { isTimeline });
    if (m2.error) return m2.error;
    if (store.timelineActive(proj.id) !== true) return out();
    const id = shortId();
    try {
      store.enterTimeline({ ...p.event, id, runId, createdAt: now });
    } catch (e) {
      if (e?.code === "DUPLICATE") return no(409, "DUPLICATE", T`This evidence already carries event ${e.eventId}.`, { eventId: e.eventId }).error;
      throw e;
    }
    reportTimeline(proj.id);
    return { status: 201, body: { ok: true, event: timelineEvent(proj.id, id) } };
  }
  if (body.action === "collect") {
    const p = checkCollect(proj, body);
    if (p.error) return p.error;
    try { store.appendTimelineParts(p.collectionId, p.parts, now); } catch (e) {
      if (e?.code === "ALREADY_COLLECTED") return no(409, "ALREADY_COLLECTED", T("A part already belongs to a collection.")).error;
      throw e;
    }
    reportTimeline(proj.id);
    return { status: 200, body: { ok: true, event: timelineEvent(proj.id, p.collectionId) } };
  }
  if (body.action === "revise") {
    const { eventId, title, text, justification } = body;
    const f = appendRevision(proj, eventId, { title, text, justification }, { from: "agent", runId, now });
    if (f.error) return f.error;
    reportTimeline(proj.id);
    return { status: 200, body: { ok: true, event: timelineEvent(proj.id, f.eventId) } };
  }
  const p = checkDismiss(proj, body.eventId, body.justification);
  if (p.error) return p.error;
  try { store.dismissTimeline({ eventId: p.eventId, from: "agent", justification: p.justification, at: now, runId }); } catch (e) {
    if (e?.code === "ALREADY_DISMISSED") return no(409, "ALREADY_DISMISSED", T`${p.eventId} is already discarded.`).error;
    throw e;
  }
  reportTimeline(proj.id);
  return { status: 200, body: { ok: true, event: timelineEvent(proj.id, p.eventId) } };
}

/**
 * GET …/timeline/agent?outerLoop=&action=search|event&… — the agent's read tool over HTTP. `search`: from, until, untilId,
 * kind, chat, word, anchor, q, limit; `event`: id. → `{ status, body }`. Reading also works with the switch off (the agent
 * does not run then).
 */
export function readTimelineAgent(proj, q, { isTimeline = isTimelineAgent } = {}) {
  if (q.get("workflowAgent")) return checkTimelineMarker(proj, "").error;
  const m = checkTimelineMarker(proj, q.get("outerLoop"), { isTimeline });
  if (m.error) return m.error;
  const action = q.get("action") || "search";
  if (!AGENT_READ_ACTIONS.includes(action)) return no(400, "BODY", T`action is one of ${AGENT_READ_ACTIONS.join(", ")}.`).error;
  if (action === "event") {
    const e = timelineEvent(proj.id, q.get("id") || "");
    return e ? { status: 200, body: { ok: true, event: e } } : no(404, "UNKNOWN", T("No such event in this project.")).error;
  }
  const r = searchTimeline(proj.id, {
    from: q.get("from"), until: q.get("until"), untilId: q.get("untilId"), kind: q.get("kind"), chat: q.get("chat"), word: q.get("word"), anchor: q.get("anchor"), q: q.get("q"), limit: q.get("limit"),
  });
  return { status: 200, body: { ok: true, ...r } };
}

