// The timeline's checks on recording. Every check returns `{ error: { status, body } }` or its result; nothing is written
// here (agent.js and routes.js do that through the store).
//
// Codes (body `{ ok: false, code, error }`, one sentence for the model or the human):
//   400 BODY               field missing or of the wrong shape (title, text, tags, agenda item, parts)
//   400 KIND               kind not in the set
//   400 CITATION           no such row, not in a chat of THIS project, kind does not match the row, `from` does not match
//   400 ONLY_READING       a read tool (read-tools.js) is no evidence
//   400 NO_PROOF           a tool of cbase's own bookkeeping (read-tools.js INTERN_TOOLS: agenda, task list, question,
//                          starting a subagent …), a row that is no message of the user, the agent or a subagent
//                          (MESSAGE_ROLES — not a question, the answer to it, goal, channel card, workflow state, limit, hint,
//                          meta), or a command of the user ("/status") — the refusal says what qualifies instead
//   400 FAILED             the call failed — or has no result (yet): unknown is not "succeeded"
//   400 ANCHOR             SHA in no code repo of the project, not on the branch named, or wrong shape
//   409 ANCHOR_UNCHECKABLE the project container is not ready — no verdict on the anchor (record without anchor, or later)
//   409 DUPLICATE          the citation already carries an event (`eventId` = the existing one)
//   404 UNKNOWN            an event named does not exist in this project
//   400 LEVEL              collecting over more than one level (a part is itself a collection, the collection itself a part)
//   409 ALREADY_COLLECTED  a part already belongs to a collection
//   400 JUSTIFICATION      dismissing without a reason or with more than 500 characters
//   409 ALREADY_DISMISSED  once dismissed stays dismissed
import * as store from "../store.js";
import { T } from "../i18n.js";
import { commitInProject } from "../git.js";
import { instanceOfChat } from "../runs/instance.js";
import { isInternalTool, isReadTool } from "./read-tools.js";
import { readCitation } from "./tool-index.js";

export const TIMELINE_CAP = Object.freeze({ title: 200, text: 4000, words: 8, word: 40, justification: 500, parts: 50, agendaItem: 40, branch: 200 });

export const no = (status, code, text, extra = {}) => ({ error: { status, body: { ok: false, code, error: text, ...extra } } });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SHA = /^[0-9a-f]{7,40}$/i;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/+-]+(?<![./])$/;

function tagsRead(raw) {
  if (raw === undefined || raw === null) return { words: [] };
  if (!Array.isArray(raw)) return no(400, "BODY", T("tags is a list of words."));
  const words = [...new Set(raw.map((w) => (typeof w === "string" ? w.trim().toLowerCase() : "")))];
  if (words.some((w) => !w || [...w].length > TIMELINE_CAP.word)) {
    return no(400, "BODY", T`Each tag has 1 to ${TIMELINE_CAP.word} characters.`);
  }
  if (words.length > TIMELINE_CAP.words) {
    return no(400, "BODY", T`At most ${TIMELINE_CAP.words} tags, sent ${words.length}.`);
  }
  return { words };
}

// Which messages are evidence: only what a human or an agent SAYS in the conversation — the user (a delivered completion
// notice also sits under `user`), the main agent, a subagent (`sub_text`). Everything else is control or display by cbase:
// `ask`/`ask_answer` (a question changes nothing, its answer is a decision — that belongs in the text of the event that
// carries it out), `goal`, `clear`, `limit`, `workflow` (state of a graph workflow — the chat reports the result), `channel`
// (the card of ANOTHER chat — the timeline agent records its events on that chat), `meta`, hints, notes, `monitor`, `capture`,
// approvals. An allowlist: a new role proves nothing until it is listed here.
export const MESSAGE_ROLES = Object.freeze(["user", "assistant", "sub_text"]);
// A command of the user ("/status", "/workflow:deploy now") is an instruction, not a report. Only one word right behind the
// slash, then whitespace or end — a path ("/tmp/x deleted") does not match.
const COMMAND = /^\s*\/[\p{L}\p{N}_:.-]+(?:\s|$)/u;
// Functions, not texts: the language is chosen when the refusal is written, not when this module loads.
const ROLES_TEXT = {
  ask: () => T("a question to the user"),
  ask_answer: () => T("the user's answer to a question — a decision"),
  channel: () => T("a card from another chat"),
  workflow: () => T("the state of a workflow"),
  goal: () => T("a goal"),
};
const insteadMessage = () => T("Use the agent's answer that reports the result, or the call that brought it about; a decision belongs in the text of the event that carries it out.");

/** Check the citation. → `{ fund: { chatId, at, from, kind, ref } }` or `{ error }`. */
export function checkCitation(proj, raw) {
  if (!isObject(raw) || !["tool", "message"].includes(raw.kind)) {
    return no(400, "CITATION", T("citation is missing: { kind: \"tool\"|\"message\", row } — no event without evidence."));
  }
  const row = Number(raw.row);
  if (!Number.isSafeInteger(row) || row <= 0) return no(400, "CITATION", T("citation.row is the row id from cbase_chat_analysis (integer > 0)."));
  const f = readCitation(row);
  const chat = f ? store.getChat(f.chatId) : null;
  if (!f || !chat || String(chat.projectId || "") !== String(proj.id)) {
    return no(400, "CITATION", T`Row ${row} is not in any chat of this project.`);
  }
  if (f.kind !== raw.kind) {
    return no(400, "CITATION", f.kind
      ? f.kind === "tool" ? T`Row ${row} is a tool call — citation.kind is "${f.kind}".` : T`Row ${row} is a message — citation.kind is "${f.kind}".`
      : T`Row ${row} is neither a tool call nor a message (${f.role}).`);
  }
  if (raw.from !== undefined && raw.from !== null && String(raw.from) !== f.from) {
    return no(400, "CITATION", T`Row ${row} comes from ${f.from || T("the main chat")}, not from ${raw.from || T("the main chat")}.`);
  }
  if (f.kind === "message") {
    if (!MESSAGE_ROLES.includes(f.role)) {
      const what = Object.hasOwn(ROLES_TEXT, f.role) ? ROLES_TEXT[f.role]() : T("a line from cbase itself");
      return no(400, "NO_PROOF", T`Row ${row} is ${what} (${f.role}), not a message of the user or an agent — no evidence. ${insteadMessage()}`);
    }
    if (f.role === "user" && COMMAND.test(f.beginning || "")) {
      return no(400, "NO_PROOF", T`Row ${row} is a command of the user, not a report — no evidence. ${insteadMessage()}`);
    }
  }
  if (f.kind === "tool") {
    if (isReadTool(f.name)) return no(400, "ONLY_READING", T`${f.name} only reads — reading is no evidence that something happened.`);
    if (isInternalTool(f.name)) {
      return no(400, "NO_PROOF", T`${f.name} only maintains cbase itself (agenda, task list, question, starting a subagent or workflow) — no evidence. Use the call that brought the result about (say git push, the test run, for a subagent its call with from), or the message that reports it.`);
    }
    if (f.ok !== true) {
      return no(400, "FAILED", f.ok === false
        ? T`The call in row ${row} failed — no evidence.`
        : T`The call in row ${row} has no result (yet) — unknown is no evidence.`);
    }
  }
  return { fund: { chatId: f.chatId, at: f.at, from: f.from, kind: f.kind, ref: String(row) } };
}

/** Check the git anchor. → `{ anchor: { branch, sha, mrIid } | null }` or `{ error }`. Asynchronous (git). */
export async function checkAnchor(proj, raw, { checkCommit = commitInProject, chatId = null } = {}) {
  if (raw === undefined || raw === null) return { anchor: null };
  const form = T("anchor is { branch, sha } (branch optional) or { mrIid }.");
  if (!isObject(raw)) return no(400, "ANCHOR", form);
  if (raw.mrIid !== undefined && raw.mrIid !== null) {
    if (raw.sha !== undefined || raw.branch !== undefined || !Number.isSafeInteger(raw.mrIid) || raw.mrIid <= 0) return no(400, "ANCHOR", form);
    return { anchor: { branch: null, sha: null, mrIid: raw.mrIid } };
  }
  const sha = typeof raw.sha === "string" ? raw.sha.trim().toLowerCase() : "";
  const branch = raw.branch === undefined || raw.branch === null || raw.branch === "" ? null : (typeof raw.branch === "string" ? raw.branch.trim() : "");
  if (!SHA.test(sha)) return no(400, "ANCHOR", T("anchor.sha is a commit hash (7–40 hex digits)."));
  if (branch !== null && (!branch || branch.length > TIMELINE_CAP.branch || !BRANCH.test(branch))) return no(400, "ANCHOR", T("anchor.branch is not a branch name."));
  let r;
  try {
    let instance = null;
    // In the instance of the citation's chat (main or its copy) — that is where the commit it reported lives.
    const chat = chatId ? store.getChat(String(chatId)) : null;
    try { instance = instanceOfChat(chat || { id: "", projectId: String(proj.id) }); } catch (e) { throw Object.assign(new Error(String(e?.message || e)), { uncheckable: true }); }
    r = await checkCommit(proj.path, sha, { branch, instance });
  } catch (e) {
    if (e?.uncheckable) return no(409, "ANCHOR_UNCHECKABLE", T("The anchor cannot be checked right now (project container not ready) — record without an anchor or retry later."));
    throw e;
  }
  if (!r?.found) return no(400, "ANCHOR", T`Commit ${sha} does not exist in any repository of this project.`);
  if (branch && r.onBranch !== true) return no(400, "ANCHOR", T`Commit ${sha} is not on ${branch}.`);
  return { anchor: { branch, sha, mrIid: null } };
}

/**
 * Check `enter`. → `{ event }` (the fields for store.enterTimeline without id/run) or `{ error }`.
 * Order: kind, title/text, tags, agenda item, citation, duplicate, anchor (the most expensive last).
 */
export async function checkEnter(proj, body, opts = {}) {
  if (!store.TIMELINE_KINDS.includes(body.kind)) {
    return no(400, "KIND", T`kind is one of ${store.TIMELINE_KINDS.join(", ")}.`);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title || [...title].length > TIMELINE_CAP.title) return no(400, "BODY", T`title has 1 to ${TIMELINE_CAP.title} characters.`);
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") return no(400, "BODY", T("text is a string."));
  const text = String(body.text ?? "").trim();
  if ([...text].length > TIMELINE_CAP.text) return no(400, "BODY", T`text has at most ${TIMELINE_CAP.text} characters, sent ${[...text].length}.`);
  const w = tagsRead(body.tags);
  if (w.error) return w;
  let agendaItemId = null;
  if (body.agendaItemId !== undefined && body.agendaItemId !== null && body.agendaItemId !== "") {
    agendaItemId = typeof body.agendaItemId === "string" ? body.agendaItemId.trim() : "";
    if (!agendaItemId || agendaItemId.length > TIMELINE_CAP.agendaItem) return no(400, "BODY", T("agendaItemId is the id of an agenda item."));
  }
  const f = checkCitation(proj, body.citation);
  if (f.error) return f;
  const existing = store.timelineCitationEvent(proj.id, f.fund.kind, f.fund.ref, f.fund.from);
  if (existing) return no(409, "DUPLICATE", T`This evidence already carries event ${existing} — collect or refer to it instead of recording anew.`, { eventId: existing });
  const a = await checkAnchor(proj, body.anchor, { ...opts, chatId: f.fund.chatId });
  if (a.error) return a;
  return {
    event: {
      projectId: String(proj.id), workspaceId: String(proj.workspaceId), kind: body.kind, title, text, at: f.fund.at,
      citationKind: f.fund.kind, citationRef: f.fund.ref, citationOf: f.fund.from, chatId: f.fund.chatId,
      branch: a.anchor?.branch ?? null, sha: a.anchor?.sha ?? null, mrIid: a.anchor?.mrIid ?? null, agendaItemId, tags: w.words,
    },
  };
}

const eventOfTheProject = (proj, id) => {
  const z = typeof id === "string" && id ? store.timelineRow(id) : null;
  return z && z.projectId === String(proj.id) ? z : null;
};
const unknown = (id) => no(404, "UNKNOWN", T`No event ${id} in this project.`);

/** Check `collect`. → `{ collectionId, parts }` or `{ error }`. */
export function checkCollect(proj, body) {
  if (typeof body.collectionId !== "string" || !body.collectionId) return no(400, "BODY", T("collectionId is missing."));
  if (!Array.isArray(body.parts) || !body.parts.length || body.parts.some((t) => typeof t !== "string" || !t)) return no(400, "BODY", T("parts is a non-empty list of event ids."));
  const parts = [...new Set(body.parts)];
  if (parts.length > TIMELINE_CAP.parts) return no(400, "BODY", T`At most ${TIMELINE_CAP.parts} parts per call, sent ${parts.length}.`);
  if (!eventOfTheProject(proj, body.collectionId)) return unknown(body.collectionId);
  const level = T("Collecting is one level only: no part is itself a collection, no collection is itself a part.");
  if (store.timelineCollectionOf(body.collectionId)) return no(400, "LEVEL", level);
  for (const t of parts) {
    if (!eventOfTheProject(proj, t)) return unknown(t);
    if (t === body.collectionId || store.timelineHasParts(t)) return no(400, "LEVEL", level);
    const already = store.timelineCollectionOf(t);
    if (already) return no(409, "ALREADY_COLLECTED", T`${t} already belongs to collection ${already}.`, { eventId: t, collectionId: already });
  }
  return { collectionId: body.collectionId, parts };
}

/** Check `dismiss` — for agent and user. → `{ eventId, justification }` or `{ error }`. */
export function checkDismiss(proj, eventId, justificationRaw) {
  if (!eventOfTheProject(proj, eventId)) return unknown(eventId);
  const justification = typeof justificationRaw === "string" ? justificationRaw.trim() : "";
  if (!justification || [...justification].length > TIMELINE_CAP.justification) {
    return no(400, "JUSTIFICATION", T`Discarding needs a reason (1 to ${TIMELINE_CAP.justification} characters).`);
  }
  if (store.timelineDismissalsOf([eventId]).has(eventId)) return no(409, "ALREADY_DISMISSED", T`${eventId} is already discarded.`);
  return { eventId, justification };
}
