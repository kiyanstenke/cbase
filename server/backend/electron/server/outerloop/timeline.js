// The outer loop part of the timeline agent. The domain (storage, check, write route, read computation) lives in
// `../timeline/`; here only what the outer loop needs:
//
//   (the cut "only chats with a project and the switch on" is in activation.js available — where every path reads it)
//   timelineBlocks({ chat, fromId, untilId, since })  the two input blocks `<timeline-most-recent>` and `<tool-index>`
//   (input.js), plus the watermark if the index was truncated
//
// The tools read and write via the routes of the domain (GET/POST /api/projects/:pid/timeline/agent, timeline/agent.js);
// the MCP server knows the project from CBASE_PROJECT_ID (runs/agents.js writes the project of the observed chat).
//
// Every value inside the fence is XML-disarmed like the history (runs/message-marker.js disarm): titles, tags and short
// details come from chats — foreign text.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { disarm } from "../runs/message-marker.js";
import { timelineMostRecent, toolIndex } from "../timeline/read.js";

/** The tool index's own cap in the input (12,000 characters, oldest first). */
export const TOOL_INDEX_MAX = 12_000;

const textOf = (r) => (Array.isArray(r) ? r.map(String).join("\n") : String(r ?? ""));

/**
 * One row of the tool index (disarmed): `[row] name — detail · ok|ERROR|open` (`ok` null = no result yet, toolIndex), a
 * subagent call prefixed with "Subagent <id> ·".
 */
export function indexRow(a) {
  const from = String(a?.from || "");
  const who = from.startsWith("subagent:") ? `Subagent ${from.slice("subagent:".length)} · ` : "";
  const detail = String(a?.detail || "").replace(/\s+/g, " ").trim();
  return `[${disarm(a?.row)}] ${disarm(who)}${disarm(a?.name)}${detail ? ` — ${disarm(detail)}` : ""} · ${a?.ok === true ? "ok" : a?.ok === false ? "ERROR" : "open"}`;
}

/**
 * The selection of the index under its own cap TOOL_INDEX_MAX: oldest first until the cap is full — at least ONE row (cut
 * off if it alone is too long), so that every run makes progress (no endless follow-up). → `{ rows, shown }`.
 */
export function toolIndexSelection(calls, max = TOOL_INDEX_MAX) {
  const cap = Math.max(1, Math.min(TOOL_INDEX_MAX, Number(max) || TOOL_INDEX_MAX));
  const rows = [];
  let sum = 0;
  for (const a of calls) {
    const z = indexRow(a);
    if (sum + z.length + 1 > cap) {
      if (!rows.length) rows.push(`${z.slice(0, Math.max(200, cap - 20))} …[truncated]`);
      break;
    }
    rows.push(z);
    sum += z.length + 1;
  }
  return { rows, shown: rows.length };
}

/**
 * The block `<tool-index>`: oldest first (in the order toolIndex returns), up to its own cap TOOL_INDEX_MAX; what lies
 * beyond (the newer ones) is named by the hint — it follows in the next run (timelineBlocks sets the watermark before
 * it). → `string[]`.
 */
export function toolIndexBlock(calls, max = TOOL_INDEX_MAX) {
  const cap = Math.max(1, Math.min(TOOL_INDEX_MAX, Number(max) || TOOL_INDEX_MAX));
  const { rows } = toolIndexSelection(calls, cap);
  const truncated = rows.length < calls.length
    ? T`Truncated: ${rows.length} of ${calls.length} calls (cap ${cap} chars) — the newer ones follow in the next run.`
    : "";
  return [`<tool-index calls="${calls.length}"${truncated ? ` truncated="${disarm(truncated)}"` : ""}>`, ...rows, "</tool-index>"];
}

/**
 * The two blocks of the timeline agent's input. `fromId`/`untilId`: the track of the history (untilId = last history row
 * seen); `since`: the lower bound in time (first run: from activation) — the index takes EXACTLY the same track.
 * → `{ rows: string[], untilId, rest }`. Gapless for the index too: if it is truncated, the watermark sits BEFORE the first
 * call not shown (`untilId` = its row − 1), `rest` is true, and the caller shows only history rows up to `untilId` — no
 * row, message or call, stays unshown behind the watermark. Since at least one call is shown, the new line always lies
 * above `fromId` (no endless follow-up).
 */
// `indexMax` (outerloop/track.js): the cap of the index on the stage of the run; default TOOL_INDEX_MAX.
export function timelineBlocks({ chat, fromId = 0, untilId = 0, since = 0, indexMax = TOOL_INDEX_MAX }) {
  const out = [];
  const pid = chat?.projectId || "";
  const mostRecent = textOf(timelineMostRecent(pid, { days: 7, max: 60 })).trim();
  out.push("<timeline-most-recent>");
  if (mostRecent) out.push(disarm(mostRecent));
  out.push("</timeline-most-recent>");
  // The index: the tool calls of the chat and its subagents in EXACTLY the track the history shows.
  const raw = toolIndex(chat.id, { fromId: Number(fromId) || 0, untilId: Number(untilId) || 0, since: Number(since) || 0 });
  const calls = Array.isArray(raw) ? raw : [];
  out.push(...toolIndexBlock(calls, indexMax));
  const { shown } = toolIndexSelection(calls, indexMax);
  const rest = shown < calls.length;
  return { rows: out, untilId: rest ? calls[shown].row - 1 : Number(untilId) || 0, rest };
}
