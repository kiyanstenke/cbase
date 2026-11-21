// A chat's tool calls as evidence: the index for the timeline agent's input and the read of ONE citation for the check
// (check.js). Read-only through the store.
//
// WHERE THE SUBAGENTS' CALLS LIVE: in the history OF THE CHAT, not only in `subagent_history`. runs/agents.js `underEvent`
// writes every `tool_use` of a subagent (cbase_agent) as a row `tool` into `messages` — with `parent` = the call block
// (`parent_tool_use_id`; if need be synthetic `agent:<id>`, providers/agent-runtime.js) — and its result as `tool_result`
// WITHOUT `parent` (paired through (parent, block id), see pairs). `subagent_history` (store/subagents.js) is the runtime's
// continuation store (no timestamps, capped by TRANSCRIPT_CAP) and does not qualify as a citation: it has no `row` that
// `cbase_chat_analysis` knows. A dynamic workflow with its own sink does NOT write into the chat — its calls are no citation.
//
// `row` = `messages.id` of the `tool` row — the same row as in `cbase_chat_analysis`. `from` = '' (main chat) or
// `subagent:<agentId>`; if the agent of the block is not (or no longer) known, `subagent:<block>`. `ok` = true (result
// without error), false (result with `isError`), null (no result yet — unknown, not "good").
import * as store from "../store.js";
import { isNoProof } from "./read-tools.js";

const json = (s) => { try { const o = JSON.parse(s); return o && typeof o === "object" ? o : null; } catch { return null; } };

/** `from` of a row with `parent` (see header). */
export function ofFromBlock(chatId, parent) {
  if (parent === undefined || parent === null || parent === "") return "";
  const p = String(parent);
  if (p.startsWith("agent:")) return `subagent:${p.slice(6)}`;
  const id = store.timelineSubagentOfBlock(chatId, p);
  return `subagent:${id || p}`;
}

// Pairing call↔result. Codex item ids restart per process — main chat and subagent easily carry the same id (`item_5`);
// paired by id alone, one's call would get the other's result. The CALL carries its `parent` (subagent) or none (main chat),
// the RESULT row does not (runs/agents.js underEvent, do-run.js — the row shape stays, web/iOS and the golden runs read it).
// Hence: a call's key = (parent, id); a result belongs to the latest open call of its id BEFORE it — per key the latest (a
// later one of the same key closes the earlier). If calls from MORE THAN ONE key qualify, the assignment is undecidable:
// none gets the result, all those calls stay open (unknown, not "good" — the check does not accept them). A result that
// itself carries a `parent` only qualifies for calls of that key.
const KEY_SEPARATOR = "\u0000";
const key = (blockId, parent) => `${parent === undefined || parent === null ? "" : String(parent)}${KEY_SEPARATOR}${blockId}`;
const UNCLEAR = Symbol("unclear");

/**
 * Assign results to calls (see above). ALL calls and results of the chat with one of the block ids are considered — also
 * before and behind the stretch, otherwise the check of ONE citation would not see the competition. → Map row → { isError }.
 */
function pairs(chatId, calls) {
  const out = new Map();
  const ids = [...new Set(calls.map((a) => a.blockId).filter(Boolean))];
  if (!ids.length) return out;
  const byId = new Map(); // blockId → [{ row, key }] ascending
  for (const z of store.timelineBlockRows(chatId, ids, "tool")) {
    const o = json(z.text);
    if (o?.id === undefined || o?.id === null) continue;
    const id = String(o.id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ row: z.id, key: key(id, o.parent) });
  }
  const allocated = new Map(); // row → { isError } | UNCLEAR
  const start = Math.min(...[...byId.values()].map((l) => l[0].row));
  for (const e of store.timelineBlockRows(chatId, ids, "tool_result")) {
    if (e.id <= start) continue;
    const o = json(e.text);
    if (o?.id === undefined || o?.id === null) continue;
    const id = String(o.id);
    const onlyKey = o.parent === undefined ? null : key(id, o.parent);
    const mostRecent = new Map(); // key → row
    for (const c of byId.get(id) || []) {
      if (c.row >= e.id) break;
      if (onlyKey === null || c.key === onlyKey) mostRecent.set(c.key, c.row);
    }
    const open = [...mostRecent.values()].filter((z) => !allocated.has(z));
    if (open.length === 1) allocated.set(open[0], { isError: Boolean(o.isError) });
    else for (const z of open) allocated.set(z, UNCLEAR);
  }
  for (const a of calls) {
    const v = allocated.get(a.row);
    if (v && v !== UNCLEAR) out.set(a.row, v);
  }
  return out;
}

function callFrom(chatId, z) {
  const o = json(z.text) || {};
  return {
    row: z.id, at: z.ts, name: String(o.name || ""), detail: String(o.detail || ""), blockId: o.id === undefined || o.id === null ? "" : String(o.id),
    parent: o.parent === undefined || o.parent === null ? "" : String(o.parent), from: ofFromBlock(chatId, o.parent),
  };
}

/**
 * The tool index of a stretch: `[{ row, from, name, detail, ok }]`, oldest first, main chat AND subagents, without read
 * tools and cbase-internal tools (read-tools.js isNoProof — the same computation as the check: the index shows only what
 * would be accepted as a citation). `fromId` exclusive (the waterline = last row seen), `untilId` inclusive, `since` (epoch ms,
 * inclusive) the lower bound in time — the same as in the history of the first run (from activation on, no backfilling).
 * Pairing runs over ALL calls of the stretch (read tools too): otherwise the result of a hidden call would find an earlier
 * one with the same key.
 */
export function toolIndex(chatId, { fromId = null, untilId = null, since = 0 } = {}) {
  const all = store.timelineToolRows(chatId, { fromId, untilId, since }).map((z) => callFrom(chatId, z));
  const result = pairs(chatId, all);
  const calls = all.filter((a) => !isNoProof(a.name));
  return calls.map((a) => ({ row: a.row, from: a.from, name: a.name, detail: a.detail, ok: result.has(a.row) ? !result.get(a.row).isError : null }));
}

/**
 * Read a citation (for check.js): `row` → `{ chatId, at, role, kind: "tool"|"message"|null, from, name, ok, beginning? }` or
 * null (no such row). `kind` null = neither call nor message (result, thought). `ok` only for calls (see header). Which role
 * of a message qualifies as evidence is decided by the check (check.js MESSAGE_ROLES), not by this read function.
 */
export function readCitation(row) {
  const n = store.timelineMessage(row);
  if (!n) return null;
  if (n.role === "tool") {
    const a = callFrom(n.chatId, { id: n.id, text: n.text, ts: n.ts });
    const e = pairs(n.chatId, [a]).get(n.id);
    return { chatId: n.chatId, at: n.ts, role: n.role, kind: "tool", from: a.from, name: a.name, ok: e ? !e.isError : null };
  }
  if (["tool_result", "thinking"].includes(n.role)) return { chatId: n.chatId, at: n.ts, role: n.role, kind: null, from: "", name: null, ok: null };
  const o = n.role === "sub_text" ? json(n.text) : null;
  // `beginning`: the first characters of a user message — the check recognizes a command ("/status") by it, check.js.
  const beginning = n.role === "user" ? String(n.text ?? "").slice(0, 200) : "";
  return { chatId: n.chatId, at: n.ts, role: n.role, kind: "message", from: o ? ofFromBlock(n.chatId, o.parent) : "", name: null, ok: null, beginning };
}
