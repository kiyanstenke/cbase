// New revisions of an event's title and text — as a function, without breaking the append-only promise: a revision is a NEW
// row in `timeline_revisions` (store/timeline.js, with its own no_update/no_delete trigger); the latest is read, the history
// stays (event shape `revisions`, read.js).
//
// TWO writers, ONE check (here):
//   - the timeline agent: `POST …/timeline/agent { action: "revise", eventId, title?, text?, justification }` (agent.js) —
//     justification required (whoever replaces someone else's revision says why);
//   - the human: `POST …/timeline/:eid/revision { title?, text?, justification? }` (routes.js) — justification optional.
// "The user may dismiss, not record" still holds: a revision creates NO event — citation, time, kind and anchor stay the
// agent's; only the wording changes, and the old revision stays visible.
//
// Codes (body `{ ok: false, code, error }`):
//   400 BODY           neither title nor text sent (a missing field is no statement), wrong shape or length
//   400 JUSTIFICATION  the agent without a reason, or a reason longer than TIMELINE_CAP.justification
//   404 UNKNOWN        no such event in this project
//   409 DISMISSED      the event is dismissed — it gets no new revision (whoever wants to say it anew records it anew)
//   409 UNCHANGED      title and text equal the effective revision — nothing appended
//   409 TOO_MANY       REVISIONS_MAX reached — a cap against a loop, no verdict on the text
// The lengths are those of recording (check.js TIMELINE_CAP — imported only, the file belongs to recording).
import * as store from "../store.js";
import { T } from "../i18n.js";
import { no, TIMELINE_CAP } from "./check.js";

/** At most this many LATER revisions per event (the first sits in the event itself). ESTIMATED: 20 leaves room for back and
 *  forth and stops a loop of the agent. */
export const REVISIONS_MAX = 20;
export const REVISION_OF = Object.freeze(["agent", "human"]);

const length = (s) => [...s].length;

/** An event's effective revision: `{ title, text }` — the latest later one, otherwise the first. */
export function effectiveRevision(row) {
  const later = store.timelineRevisionsOf([row.id]).get(row.id) || [];
  const j = later[later.length - 1];
  return { title: j ? j.title : row.title, text: j ? j.text : row.text, count: later.length };
}

/**
 * Check a new revision. `from` agent|human. → `{ revision: { eventId, title, text, justification } }` or `{ error }`.
 * A missing field takes over the effective revision; if both are missing, that is no statement (400).
 */
export function checkRevision(proj, eventId, body, { from }) {
  if (!REVISION_OF.includes(from)) throw new Error(`checkRevision: from is ${REVISION_OF.join("|")}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) return no(400, "BODY", T("The body must be an object — nothing changed."));
  const z = typeof eventId === "string" && eventId ? store.timelineRow(eventId) : null;
  if (!z || z.projectId !== String(proj.id)) return no(404, "UNKNOWN", T`No event ${eventId} in this project.`);
  const hasTitle = body.title !== undefined && body.title !== null;
  const hasText = body.text !== undefined && body.text !== null;
  if (!hasTitle && !hasText) {
    return no(400, "BODY", T("title or text is missing — a missing field is no instruction, nothing changed."));
  }
  if ((hasTitle && typeof body.title !== "string") || (hasText && typeof body.text !== "string")) return no(400, "BODY", T("title and text are strings."));
  if (body.justification !== undefined && body.justification !== null && typeof body.justification !== "string") return no(400, "BODY", T("justification is a string."));
  if (store.timelineDismissalsOf([z.id]).has(z.id)) {
    return no(409, "DISMISSED", T`${z.id} is discarded — a discarded event gets no new version.`);
  }
  const applies = effectiveRevision(z);
  const title = hasTitle ? body.title.trim() : applies.title;
  const text = hasText ? body.text.trim() : applies.text;
  if (!title || length(title) > TIMELINE_CAP.title) return no(400, "BODY", T`title has 1 to ${TIMELINE_CAP.title} characters.`);
  if (length(text) > TIMELINE_CAP.text) return no(400, "BODY", T`text has at most ${TIMELINE_CAP.text} characters, sent ${length(text)}.`);
  const justification = typeof body.justification === "string" ? body.justification.trim() : "";
  if (length(justification) > TIMELINE_CAP.justification || (from === "agent" && !justification)) {
    return no(400, "JUSTIFICATION", from === "agent"
      ? T`A new version needs a reason (1 to ${TIMELINE_CAP.justification} characters).`
      : T`The reason has at most ${TIMELINE_CAP.justification} characters.`);
  }
  if (title === applies.title && text === applies.text) return no(409, "UNCHANGED", T("Title and text are already like this — nothing appended."));
  if (applies.count >= REVISIONS_MAX) {
    return no(409, "TOO_MANY", T`${z.id} already has ${applies.count} later versions — the cap (${REVISIONS_MAX}) stops a loop; nothing appended.`);
  }
  return { revision: { eventId: z.id, title, text, justification } };
}

/** Check and append. → `{ eventId }` or `{ error }`. The caller reports `timeline` and answers with the event. */
export function appendRevision(proj, eventId, body, { from, runId = null, now = Date.now() }) {
  const p = checkRevision(proj, eventId, body, { from });
  if (p.error) return p;
  store.appendTimelineRevision({ ...p.revision, from, at: now, runId });
  return { eventId: p.revision.eventId };
}
