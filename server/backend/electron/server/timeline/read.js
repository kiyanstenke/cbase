// Reading the timeline. Read-only through the store.
//
// The read and helper functions for the timeline agent (outerloop/, mcp/) ALL live here, including toolIndex (passed on from
// tool-index.js), so that there is ONE import path: `../timeline/read.js`.
//   timelineMostRecent(projectId, { days = 7, max = 60 })    → text, one line per top-level event (for the input)
//   toolIndex(chatId, { fromId, untilId, since })              → [{ row, from, name, detail, ok }]
//   searchTimeline(projectId, { from, until, untilId, kind, chat, word, anchor, q, limit })  → { events: [E], further, continueId }
//   timelineEvent(projectId, id)                             → E (with parts and `collectionId`) or null
// Plus for the route: timelineList (GET …/timeline), timelineProofs (GET …/timeline/proofs) and eventForms (the event shape E
// for a list of rows).
import * as store from "../store.js";
import { toolIndex } from "./tool-index.js";
import { projectRemotes, referencesOf } from "./references.js";

export { toolIndex };

export const LIST_CAP = 200;
export const LIST_DEFAULT = 50;

/**
 * Rows (store.timelineRows) → event shape E. `withParts`: collections carry `parts` (shape E without `parts`); otherwise
 * `parts: []`. Citation: `chatId`/`chatTitle` at read time (a deleted chat ⇒ title null), `tool` = the call's name for kind `tool`.
 *
 *   - `title`/`text` = the EFFECTIVE revision (the latest from timeline_revisions, otherwise the first); `revisions` = the
 *     whole sequence, oldest first, the first being the entry's own (`{ title, text, from: agent|human, justification, at }`)
 *     — `[]` while never revised. For agent AND human: the agent should see that a human rephrased.
 *   - only `forHuman` (list, proofs, responses of the human routes): `links` and `references` (references.js) and
 *     `agendaItem` = `{ id, chatId, text, status }` from the agenda of the citation's chat (`text`/`status` null: the item is
 *     no longer there). The agent does not get them — they would cost it tokens and tell it nothing it does not read itself.
 */
export function eventForms(rows, { withParts = true, forHuman = false } = {}) {
  const parts = withParts ? store.timelinePartsOf(rows.map((z) => z.id)) : new Map();
  const all = [...rows, ...[...parts.values()].flat()];
  const ids = all.map((z) => z.id);
  const words = store.timelineTagsOf(ids);
  const dismissed = store.timelineDismissalsOf(ids);
  const revisions = store.timelineRevisionsOf(ids);
  const repos = new Map(); // projectId → projectRemotes
  const reposOf = (pid) => {
    if (!repos.has(pid)) { const proj = store.getProject(pid); repos.set(pid, proj ? { list: projectRemotes(proj), path: proj.path } : { list: [], path: null }); }
    return repos.get(pid);
  };
  const agendas = new Map(); // chatId → Map pointId → item
  const agendaItem = (z) => {
    if (!z.agendaItemId) return null;
    if (!z.chatId) return { id: z.agendaItemId, chatId: null, text: null, status: null };
    if (!agendas.has(z.chatId)) {
      let points = new Map();
      try { points = new Map((store.readAgenda(z.chatId)?.steps || []).map((p) => [String(p.id), p])); } catch { /* no agenda */ }
      agendas.set(z.chatId, points);
    }
    const p = agendas.get(z.chatId).get(z.agendaItemId);
    return { id: z.agendaItemId, chatId: z.chatId, text: p ? String(p.text ?? "") : null, status: p ? String(p.status ?? "") || null : null };
  };
  const chats = new Map();
  const title = (cid) => {
    if (!cid) return null;
    if (!chats.has(cid)) chats.set(cid, store.getChat(cid)?.title ?? null);
    return chats.get(cid);
  };
  const toolName = (z) => {
    if (z.citationKind !== "tool") return null;
    const n = store.timelineMessage(z.citationRef);
    if (!n || n.role !== "tool") return null;
    try { return String(JSON.parse(n.text)?.name || "") || null; } catch { return null; }
  };
  const form = (z) => {
    const later = revisions.get(z.id) || [];
    const applies = later[later.length - 1] || null;
    const e = {
      id: z.id, kind: z.kind, title: applies ? applies.title : z.title, text: applies ? applies.text : z.text, at: z.at,
      citation: { kind: z.citationKind, ref: z.citationRef, from: z.citationOf, chatId: z.chatId, chatTitle: title(z.chatId), tool: toolName(z) },
      anchor: z.branch || z.sha || z.mrIid !== null ? { branch: z.branch, sha: z.sha, mrIid: z.mrIid } : null,
      agendaItemId: z.agendaItemId,
      tags: words.get(z.id) || [],
      dismissed: dismissed.get(z.id) || null,
      revisions: later.length
        ? [{ title: z.title, text: z.text, from: "agent", justification: "", at: z.createdAt }, ...later.map((f) => ({ title: f.title, text: f.text, from: f.from, justification: f.justification, at: f.at }))]
        : [],
    };
    if (forHuman) {
      const r = reposOf(z.projectId);
      Object.assign(e, referencesOf(e, r.list, { anchor: r.path }), { agendaItem: agendaItem(z) });
    }
    return e;
  };
  return rows.map((z) => ({ ...form(z), parts: (parts.get(z.id) || []).map(form) }));
}

const count = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const limitValue = (v) => Math.max(1, Math.min(LIST_CAP, count(v) ?? LIST_DEFAULT));

/**
 * GET /api/projects/:id/timeline: `{ active, events, further, continueId }` — the top-level ones, newest first; `further` =
 * the `until` of the next page (the `at` of the last event) or null if nothing more comes; `continueId` = its `untilId` (the
 * id of the last event). The cursor (until, untilId) loses no event with the same `at` at the page boundary; `until` alone
 * still works (at < until).
 */
export function timelineList(proj, { until, untilId, limit, kind, chat, word } = {}) {
  const n = limitValue(limit);
  const rows = store.timelineRows(proj.id, { top: true, until: count(until), untilId: untilId ? String(untilId) : null, kind: kind || null, chat: chat || null, word: word || null, limit: n + 1 });
  return { active: store.timelineActive(proj.id) === true, ...pageOf(rows, n, (page) => eventForms(page, { forHuman: true })) };
}

/** One page out of `n + 1` rows: `{ events, further, continueId }` (see timelineList). */
function pageOf(rows, n, forms) {
  const page = rows.slice(0, n);
  const last = rows.length > n && page.length ? page[page.length - 1] : null;
  return { events: forms(page), further: last ? last.at : null, continueId: last ? last.id : null };
}

/**
 * Search for the agent's read tool. `anchor` = `{ sha?, branch?, mrIid? }` or a string (SHA prefix or branch). Unlike the
 * list, over ALL events (parts too) — the agent looks for evidence, not for the view. → `{ events, further }`.
 */
export function searchTimeline(projectId, { from, until, untilId, kind, chat, word, anchor, q, limit } = {}) {
  const n = limitValue(limit);
  let sha = null, branch = null, mrIid = null;
  if (anchor && typeof anchor === "object") {
    sha = anchor.sha ? String(anchor.sha) : null;
    branch = anchor.branch ? String(anchor.branch) : null;
    mrIid = count(anchor.mrIid);
  } else if (typeof anchor === "string" && anchor.trim()) {
    const a = anchor.trim();
    if (/^[0-9a-f]{4,40}$/i.test(a)) sha = a; else if (/^!?\d+$/.test(a)) mrIid = Number(a.replace("!", "")); else branch = a;
  }
  const rows = store.timelineRows(projectId, {
    top: false, from: count(from), until: count(until), untilId: untilId ? String(untilId) : null, kind: kind || null, chat: chat || null, word: word || null, sha, branch, mrIid, q: q ? String(q) : null, limit: n + 1,
  });
  return pageOf(rows, n, (page) => {
    const forms = eventForms(page);
    for (const f of forms) f.collectionId = store.timelineCollectionOf(f.id);
    return forms;
  });
}

/** One event of the project in shape E, with parts and `collectionId` (the collection it belongs to) — or null.
 *  `forHuman` for the responses of the human routes (dismiss, revision). */
export function timelineEvent(projectId, id, { forHuman = false } = {}) {
  const z = store.timelineRow(id);
  if (!z || z.projectId !== String(projectId)) return null;
  const [f] = eventForms([z], { forHuman });
  f.collectionId = store.timelineCollectionOf(z.id);
  return f;
}

export const PROOFS_CAP = 200;
/**
 * The proofs of a chat's agenda: every event of the project whose citation lies in this chat and that refers to an agenda
 * item — top-level AND parts, newest first, at most PROOFS_CAP, shape E for the human (without parts).
 * → `{ proofs, clipped }`; the client groups by `agendaItemId`.
 */
export function timelineProofs(proj, chatId) {
  const rows = store.timelineRows(proj.id, { top: false, chat: String(chatId), withAgendaPoint: true, limit: PROOFS_CAP + 1 });
  return { proofs: eventForms(rows.slice(0, PROOFS_CAP), { withParts: false, forHuman: true }), clipped: rows.length > PROOFS_CAP };
}

const clock = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const singleLine = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The latest events as compact text for the agent's input: one line per TOP-LEVEL event of the last `days`, at most `max`,
 * OLDEST first (like a history). Shape: `<id> <UTC time> [kind] title · citation · anchor · #tags · (n parts) · DISMISSED`.
 * Without an event an empty string.
 */
export function timelineMostRecent(projectId, { days = 7, max = 60, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(LIST_CAP, count(max) ?? 60));
  const from = now - Math.max(0, Number(days) || 0) * 86_400_000;
  const rows = store.timelineRows(projectId, { top: true, from, limit: n }).reverse();
  if (!rows.length) return "";
  return eventForms(rows).map((e) => {
    const fs = `${e.citation.kind === "tool" ? `executed ${e.citation.tool || "?"}` : "reported"} row ${e.citation.ref}${e.citation.from ? ` ${e.citation.from}` : ""}${e.citation.chatId ? ` chat ${e.citation.chatId}` : ""}`;
    const parts = [
      `${e.id} ${clock(e.at)} [${e.kind}] ${singleLine(e.title, 160)}`,
      fs,
      e.anchor ? [e.anchor.branch, e.anchor.sha && e.anchor.sha.slice(0, 12), e.anchor.mrIid !== null && e.anchor.mrIid !== undefined ? `!${e.anchor.mrIid}` : null].filter(Boolean).join(" ") : null,
      e.tags.length ? e.tags.map((w) => `#${w}`).join(" ") : null,
      e.parts.length ? `(${e.parts.length} parts)` : null,
      e.dismissed ? `DISMISSED (${e.dismissed.from})` : null,
    ];
    return parts.filter(Boolean).join(" · ");
  }).join("\n");
}
