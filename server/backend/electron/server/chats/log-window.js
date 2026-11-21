// The history in a WINDOW. A long chat's full log can be tens of MB (mostly tool_result); transfer, JSON parse and
// rendering ALL bubbles then make a chat switch take seconds. The contract between server and clients, in ONE place:
//
//   GET /api/chats/:id/log                         → the full history as a list (old contract, unchanged — every reader
//                                                    without parameters)
//   GET /api/chats/:id/log?window=1[&before=<id>][&from=<id>]
//                                                  → `{ total, lastId, older, rows }`: the latest WINDOW_ROWS rows before
//                                                    `before` (without it: the last ones); with `from` instead EVERYTHING
//                                                    from the boundary at or before `from` up to before `before` (jumping
//                                                    to a row, reloading the same range). `older`: there are rows before
//                                                    the first one delivered. `total`/`lastId` as in the delta
//                                                    (`messageStats`) — the client reconciles against `total`, not
//                                                    against the number of rows it has.
//   GET /api/chats/:id/log/delta?since=<id>&truncate=1
//                                                  → the delta as before, rows truncated as in the window
//   GET /api/chats/:id/log/row/<id>                → ONE row untruncated (expanding a truncated one)
//
// A window starts at a BOUNDARY (`BOUNDARY_ROLES`: a row that starts a new bubble) — never inside a tool group. Because
// every page starts at a boundary and ends exactly before the previous one, the pages concatenated yield the full history
// without gaps; `buildBubbles` over the concatenation builds the same bubbles as over the full log.
//
// Only `tool_result` is truncated (tool inputs are small, and a truncated input would distort the diff and "+N −M"): the
// result from TRUNCATE_CHARACTERS characters on; the row then carries `truncated` = length of the untruncated `text`. The
// web view shows only MAX_RESULT_CHARS anyway (web/src/components/AssistantBlocks.tsx) — the limit here is not below it
// (guard). NEVER truncated: results a client READS as JSON (`staysWhole`) — subagent reports (web `AGENT_TOOLS`, iOS
// `agentToolNames`), `cbase_agent_output`, `cbase_skill_write`; and every result whose call is not among the delivered
// rows (name unknown ⇒ whole).
//
// Guard: server/backend/test/log-window.test.js.
import * as store from "../store.js";

/** Rows per window, before the start moves to the boundary. */
export const WINDOW_ROWS = 300;
/** How far the start searches backwards for a boundary; if it finds none, forwards within the window. */
export const LIMIT_SEARCH = 300;
/** From this many characters on a tool result is truncated in the window. */
export const TRUNCATE_CHARACTERS = 4000;
/** Roles that start a new bubble — a window may start there. */
export const BOUNDARY_ROLES = Object.freeze(["user", "assistant", "workflow", "hint", "clear"]);
/** The names of the request parameters. */
export const WINDOW_PARAM = Object.freeze({ window: "window", before: "before", from: "from", truncate: "truncate" });
/** Subagent calls — the same list as web `AGENT_TOOLS` and iOS `agentToolNames` (bound in the guard). */
export const AGENTS_TOOLS = Object.freeze(["Agent", "Task", "mcp__cbase__cbase_agent"]);

/** Is the result of this tool never truncated? (A client reads it as JSON.) */
export function staysWhole(name) {
  if (!name) return true;
  return AGENTS_TOOLS.includes(name) || /(^|__)cbase_agent_output$/.test(name) || /(^|__)cbase_skill_write$/.test(name);
}

const isLimit = (r) => BOUNDARY_ROLES.includes(r.role);
const positive = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

/** Does the request ask for the window? (Without the parameter the old contract applies: the full list.) */
export const willWindow = (params) => params.get(WINDOW_PARAM.window) === "1";

/** The rows truncated: long tool results to TRUNCATE_CHARACTERS, marker `truncated`. The name per call comes from the same rows. */
export function truncateRows(rows) {
  const names = new Map();
  for (const r of rows) {
    if (r.role !== "tool") continue;
    try { const t = JSON.parse(r.text); if (t?.id) names.set(String(t.id), String(t.name ?? "")); } catch { /* not a tool row */ }
  }
  return rows.map((r) => {
    if (r.role !== "tool_result" || r.text.length <= TRUNCATE_CHARACTERS) return r;
    let t;
    try { t = JSON.parse(r.text); } catch { return r; }
    if (!t || typeof t.result !== "string" || t.result.length <= TRUNCATE_CHARACTERS) return r;
    if (staysWhole(names.get(String(t.id ?? "")))) return r;
    return { ...r, text: JSON.stringify({ ...t, result: t.result.slice(0, TRUNCATE_CHARACTERS) }), truncated: r.text.length };
  });
}

/** The window of a chat for the parameters of a request → `{ total, lastId, older, rows }`. */
export function logWindow(chatId, params) {
  const before = positive(params.get(WINDOW_PARAM.before));
  const start = positive(params.get(WINDOW_PARAM.from));
  const stats = store.messageStats(chatId);
  let rows;
  if (start) {
    rows = store.listMessagesArea(chatId, store.lastLimitUntil(chatId, start, BOUNDARY_ROLES), before);
  } else {
    const raw = store.listMessagesBefore(chatId, before, WINDOW_ROWS + LIMIT_SEARCH);
    let s = Math.max(0, raw.length - WINDOW_ROWS);
    if (s > 0) {
      let i = s;
      while (i > 0 && !isLimit(raw[i])) i--;
      if (isLimit(raw[i]) || raw.length < WINDOW_ROWS + LIMIT_SEARCH) s = i; // no boundary, but at the start of the chat: everything
      else { let j = s; while (j < raw.length && !isLimit(raw[j])) j++; if (j < raw.length) s = j; }
    }
    rows = raw.slice(s);
  }
  const older = rows.length > 0 && store.hasMessagesBefore(chatId, rows[0].id);
  return { total: stats.total, lastId: stats.lastId, older, rows: truncateRows(rows) };
}
