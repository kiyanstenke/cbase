// The computation behind `cbase_chat_analysis` — GET /api/chats/:id/outer-loop/analysis (routes.js outerLoopChatRoutes).
// Read-only via the store.
//
// The tool is restricted to the OBSERVED chat: the chat in the path must be the chat of the run, the run `running` and
// owned by the named agent — else 403 (a finished run, a foreign chat, a missing marker). Whatever a run reads beyond
// that, it reads with the tools its human chose (communication, knowledge).
//
//   history   paging like the view `chat` of cbase_agents_list (communication/read.js chatView), but with the row id
//             (`row` = messages.id) per row and tool calls by default (`includeTools` true) — the `row` of a `tool` row
//             is the key for `call`
//   search    text in the chat across ALL roles (store.outerLoopChatSearch), newest first, an excerpt per hit
//   call      a tool call with its result (store.outerLoopCall — paired via the ROW, not the block id)
//   notes     this agent's own earlier notes on this chat
// Every response carries `note` (foreign text) and `chat: { id, title }`.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { CHANNEL_STATUS_ROLES, channelStatusRow } from "../channels/lifecycle.js";
import { NOTE } from "../communication/foreign-text.js";

export const ANALYSIS_ACTIONS = Object.freeze(["history", "search", "call", "notes"]);
export const EXCERPT_MARGIN = 160;

const error = (status, text) => ({ status, body: { error: text } });
const ok = (body) => ({ status: 200, body });
const empty = (v) => v === undefined || v === null || String(v).trim() === "";
const count = (v, preset, min, max) => Math.min(max, Math.max(min, !empty(v) && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : preset));
const truthy = (v) => v === true || v === "true" || v === "1" || v === 1;

/**
 * Check the marker `<agentId>:<runId>` against the chat. → `{ run }` or `{ status: 403, body }`.
 * The run must be RUNNING, owned by the agent and on THIS chat.
 */
export function checkRunMarker(chat, raw) {
  const s = String(raw ?? "").trim();
  const i = s.indexOf(":");
  const no = error(403, T("No running outer-loop run on this chat — the analysis tool only works within its own run."));
  if (i <= 0 || i === s.length - 1) return no;
  const agentId = s.slice(0, i);
  const run = store.outerLoopRun(s.slice(i + 1));
  if (!run || run.state !== "running" || run.agentId !== agentId || run.chatId !== chat.id) return no;
  return { run };
}

const header = (chat) => ({ note: NOTE, chat: { id: chat.id, title: chat.title || "" } });

export function analysisHistory(chat, q) {
  const keep = q.includeTools === undefined || truthy(q.includeTools) ? CHANNEL_STATUS_ROLES.tools : CHANNEL_STATUS_ROLES.messages;
  const cap = count(q.maxChars, 1200, 80, 8000);
  const limit = count(q.limit, 40, 1, 200);
  const all = store.listMessages(chat.id).filter((r) => keep.has(r.role));
  // `from` = number of the first row in the filtered sequence (0-based); without `from` the last `limit`.
  const start = empty(q.from) ? Math.max(0, all.length - limit) : count(q.from, 0, 0, Math.max(0, all.length));
  const part = all.slice(start, start + limit);
  return ok({
    ...header(chat), total: all.length, from: start, until: start + part.length,
    lines: part.map((r) => ({ row: r.id, role: r.role, at: r.ts, text: channelStatusRow(r, cap) })),
  });
}

// An excerpt around the first hit — in the readable form of the row, else (the hit was in a JSON key) in the raw text.
function excerpt(r, needle) {
  for (const text of [channelStatusRow(r, 1_000_000), String(r.text || "")]) {
    const i = text.toLowerCase().indexOf(needle);
    if (i < 0) continue;
    const from = Math.max(0, i - EXCERPT_MARGIN);
    const until = Math.min(text.length, i + needle.length + EXCERPT_MARGIN);
    return `${from > 0 ? "…" : ""}${text.slice(from, until)}${until < text.length ? "…" : ""}`;
  }
  return String(r.text || "").slice(0, 2 * EXCERPT_MARGIN);
}

export function analysisSearch(chat, q) {
  const search = String(q.search ?? "").trim();
  if (!search) return error(400, T("search missing"));
  const limit = count(q.limit, 20, 1, 50);
  const hits = store.outerLoopChatSearch(chat.id, search, { limit: limit + 1 });
  const needle = search.toLowerCase();
  return ok({
    ...header(chat), search,
    hits: hits.slice(0, limit).map((r) => ({ row: r.id, role: r.role, at: r.ts, excerpt: excerpt(r, needle) })),
    capped: hits.length > limit,
  });
}

export function analysisCall(chat, q) {
  if (empty(q.row) || !Number.isInteger(Number(q.row)) || Number(q.row) <= 0) return error(400, T("row missing (messages.id of a tool row from \"history\")"));
  const r = store.outerLoopCall(chat.id, Number(q.row));
  if (!r) return error(404, T("No tool call in this row of this chat"));
  return ok({ ...header(chat), ...r });
}

export function analysisNotes(chat, agentId, q) {
  const limit = count(q.limit, 10, 1, 50);
  return ok({ ...header(chat), notes: store.outerLoopNotes(chat.id, { agentId, limit }).items });
}

/**
 * The whole response of the route: check the marker, choose the action. `q` are the query parameters as an object.
 * → `{ status, body }` — 403 before 400: without a valid marker the caller learns nothing about the parameters.
 */
export function analysisResponse(chat, q) {
  const marker = checkRunMarker(chat, q.run);
  if (!marker.run) return marker;
  const action = String(q.action ?? "");
  if (!ANALYSIS_ACTIONS.includes(action)) return error(400, T`action: one of ${ANALYSIS_ACTIONS.join(", ")}`);
  if (action === "history") return analysisHistory(chat, q);
  if (action === "search") return analysisSearch(chat, q);
  if (action === "call") return analysisCall(chat, q);
  return analysisNotes(chat, marker.run.agentId, q);
}
