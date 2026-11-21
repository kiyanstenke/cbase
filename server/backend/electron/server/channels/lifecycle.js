// A channel's lifecycle: status (channelStatus*), channelSinceFromQuery, publicChannel, channelCreate.

import crypto from "node:crypto";
import { wallTimeText } from "../cron.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { broadcast } from "../runtime/sse.js";
import { chatDisplayName, channelCard } from "./delivery.js";
import { channelFrozenError } from "./freeze.js";
import { managerLocked } from "../runs/manager-lock.js";
import { openAskOf } from "../runs/ask.js";
import { running } from "../runs/state.js";
import { isChildChat } from "../chats/genus.js";
import { openCard } from "../dynworkflows/approval.js";

// communication/read.js (view "chat") and communication/retrieval.js (summary on request through the agent key
// `channel_status`) read with this: the SITUATION without a model (running/waiting, open card with its question, last
// activity, rows since `since`), the RAW HISTORY filtered by roles and capped (the truncation is stated explicitly).
const CHANNEL_STATUS_CONVERSATION = ["user", "assistant", "ask", "ask_answer", "goal", "clear", "limit", "workflow", "channel"];
const CHANNEL_STATUS_ROLES = {
  messages: new Set(CHANNEL_STATUS_CONVERSATION),
  tools: new Set([...CHANNEL_STATUS_CONVERSATION, "tool", "tool_result", "thinking", "sub_text", "meta", "monitor", "capture"]),
  questions: new Set(["ask", "ask_answer"]),
};
const CHANNEL_STATUS_RAW_MAX = 30_000;
// Generous per row (a long answer of the agent IS the state); the total is held by the raw cap, not by the row.
const CHANNEL_STATUS_ROW_MAX = 8_000;
// Make a history row readable — the JSON roles carry an object in the text field.
function channelStatusRow(r, cap = CHANNEL_STATUS_ROW_MAX) {
  const raw = String(r.text || "");
  const short = (s) => (s.length > cap ? s.slice(0, cap) + " …[truncated]" : s);
  if (!["tool", "tool_result", "ask", "ask_answer", "capture", "channel"].includes(r.role)) return short(raw);
  let o;
  try { o = JSON.parse(raw); } catch { return short(raw); }
  if (r.role === "tool") return short([o?.name, o?.detail].filter(Boolean).join(": "));
  if (r.role === "tool_result") return short(typeof o?.result === "string" ? o.result : raw);
  if (r.role === "channel") return short(`[channel "${o?.channelName || ""}" ${o?.direction === "out" ? "→" : "←"} ${o?.sender?.name || o?.sender?.kind || ""}] ${String(o?.text || "")}`);
  if (r.role === "ask") {
    const questions = Array.isArray(o?.questions) ? o.questions : [];
    return short(questions.map((q) => [q.header ? `${q.header}: ` : "", q.question || "", Array.isArray(q.options) && q.options.length ? ` (${q.options.map((x) => x.label || x).join(" | ")})` : ""].join("")).join(" · ") || raw);
  }
  if (r.role === "ask_answer") {
    const responses = o?.answers && typeof o.answers === "object" ? Object.values(o.answers).map(String) : [];
    return short((responses.length ? responses.join(" · ") : String(o?.text || raw)) + (o?.overChannel ? ` [via channel "${o.overChannel.name || ""}"]` : ""));
  }
  return short(raw);
}
// From when counting and reading start: explicitly, otherwise the last message of a shared channel (since the last
// exchange), otherwise the start of the chat. `managerChat` is the READER (communication/retrieval.js) — the name dates
// from when only a manager chat read.
function channelStatusSince(managerChat, chat, sinceRaw) {
  if (sinceRaw !== undefined && sinceRaw !== null && sinceRaw !== "") {
    const ms = typeof sinceRaw === "number" ? sinceRaw : (/^\d+$/.test(String(sinceRaw)) ? Number(sinceRaw) : Date.parse(String(sinceRaw)));
    if (!Number.isFinite(ms)) throw new Error(T("since: not a point in time (ISO or epoch ms)"));
    return { since: ms, source: "detail" };
  }
  let last = 0;
  for (const k of store.listChannelsOfChat(chat.id)) {
    if (!store.getChannelParticipants(k.id, managerChat.id)) continue;
    const n = k.lastSeq > 0 ? store.getChannelMessageBySeq(k.id, k.lastSeq) : null;
    if (n && n.createdAt > last) last = n.createdAt;
  }
  return last ? { since: last, source: "channel" } : { since: chat.createdAt || 0, source: "chat_begin" };
}
function channelStatusSituation(chat, since, tz) {
  const rows = store.listMessages(chat.id);
  const isRunning = running.has(chat.id);
  const run = isRunning ? store.listActiveRuns().find((r) => r.chatId === chat.id) : null;
  const card = openAskOf(chat.id);
  const last = rows.length ? rows[rows.length - 1].ts : chat.createdAt;
  return {
    chatId: chat.id, title: chatDisplayName(chat), projectId: chat.projectId || null,
    running: isRunning, runSinceS: isRunning ? Math.max(0, Math.round((Date.now() - (run?.startedAt || Date.now())) / 1000)) : null,
    waitingQuestion: Boolean(card),
    card: card ? { requestId: card.requestId, questions: card.questions.map((q) => q?.question || q?.header || "").filter(Boolean) } : null,
    lastActivity: last ? wallTimeText(last, tz) : null,
    since: wallTimeText(since, tz),
    rows: rows.filter((r) => (r.ts || 0) >= since).length, rowsTotal: rows.length,
    // Archive: ONLY for archived chats — they are read-only. A channel message does NOT bring them back: delivery holds at
    // the archive (delivery.js deliverChannel).
    ...(chat.archivedAt ? { archived: true } : {}),
  };
}
// The filtered history since `since`. Above the cap the NEWEST rows stay — and the truncation is attached as an object,
// not as cut-off JSON.
// `fromId`: the waterline of an outer-loop run — only rows with `messages.id > fromId` (timestamps are not unique per
// millisecond), plus still `ts ≥ since` (the first run reads from activation on). The response then also carries `untilId`:
// the highest id of the selection BEFORE the cap (otherwise `fromId`) — the waterline of the next run; what the cap dropped
// thereby counts as read (the hint says so). Without `fromId` nothing changes.
// `ofFront` (only the timeline agent, outerloop/input.js): above the cap the OLDEST rows stay, and `untilId` is the id of
// the last row SEEN — nothing drops silently, the rest lies above the waterline and is read in the next run. Every row then
// carries its `row` (messages.id, the same as in cbase_chat_analysis). `max` (only with `ofFront`, outerloop/track.js): a
// smaller cap for a shortened stretch; default CHANNEL_STATUS_RAW_MAX.
function channelStatusHistory(chat, since, filter, { fromId, ofFront = false, max = CHANNEL_STATUS_RAW_MAX } = {}) {
  if (ofFront) return channelStatusHistoryOfFront(chat, since, filter, { fromId, max });
  const keep = CHANNEL_STATUS_ROLES[filter] || CHANNEL_STATUS_ROLES.messages;
  const withWaterline = fromId !== undefined && fromId !== null;
  const start = Number(fromId) || 0;
  const raw = store.listMessages(chat.id).filter((r) => (r.ts || 0) >= since && keep.has(r.role) && (!withWaterline || Number(r.id) > start));
  const until = withWaterline ? { untilId: raw.reduce((m, r) => Math.max(m, Number(r.id) || 0), start) } : {};
  const all = raw.map((r) => ({ role: r.role, at: r.ts, text: channelStatusRow(r) }));
  const weight = (z) => z.text.length + 24;
  if (all.reduce((n, z) => n + weight(z), 0) <= CHANNEL_STATUS_RAW_MAX) return { rows: all, truncated: null, ...until };
  const rows = [];
  let sum = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (sum + weight(all[i]) > CHANNEL_STATUS_RAW_MAX) break;
    rows.unshift(all[i]);
    sum += weight(all[i]);
  }
  // If not even the newest row fits, it stays — cut off, but there.
  if (!rows.length && all.length) {
    const z = all[all.length - 1];
    rows.push({ ...z, text: z.text.slice(0, CHANNEL_STATUS_RAW_MAX - 200) + " …[truncated]" });
  }
  return {
    rows,
    ...until,
    truncated: {
      from: all.length, on: rows.length,
      hint: T`Truncated: ${rows.length} of ${all.length} lines (cap ${CHANNEL_STATUS_RAW_MAX} chars) — the oldest are missing; narrow with since=.`,
    },
  };
}
// The stretch above `fromId` from the FRONT (oldest first) up to the cap; `untilId` = id of the last row taken. If not even
// the oldest row fits, it stands there cut off — it counts as seen anyway (otherwise the waterline would stay before it forever).
function channelStatusHistoryOfFront(chat, since, filter, { fromId, max = CHANNEL_STATUS_RAW_MAX } = {}) {
  const cap = Math.max(1, Math.min(CHANNEL_STATUS_RAW_MAX, Number(max) || CHANNEL_STATUS_RAW_MAX));
  const keep = CHANNEL_STATUS_ROLES[filter] || CHANNEL_STATUS_ROLES.messages;
  const start = Number(fromId) || 0;
  const raw = store.listMessages(chat.id).filter((r) => (r.ts || 0) >= since && keep.has(r.role) && Number(r.id) > start);
  const all = raw.map((r) => ({ role: r.role, at: r.ts, row: Number(r.id) || 0, text: channelStatusRow(r) }));
  const weight = (z) => z.text.length + 24;
  const rows = [];
  let sum = 0;
  for (const z of all) {
    if (sum + weight(z) > cap) break;
    rows.push(z);
    sum += weight(z);
  }
  if (!rows.length && all.length) rows.push({ ...all[0], text: all[0].text.slice(0, Math.max(200, cap - 200)) + " …[truncated]" });
  const untilId = rows.reduce((m, z) => Math.max(m, z.row), start);
  if (rows.length === all.length) return { rows, truncated: null, untilId };
  return {
    rows,
    untilId,
    truncated: {
      from: all.length, on: rows.length,
      hint: T`Truncated: ${rows.length} of ${all.length} lines (cap ${cap} chars) — the newer ones follow in the next run.`,
    },
  };
}
// The child chat of a graph run is never the TARGET of a channel — its node agent is reachable through the run
// (graph:<startId>); it creates a channel itself (then it is the creator, see channelCreate). Checked on creation.
const childChatNoTarget = () => T("A graph workflow's child chat is never the target of a channel — its node agent is reachable through the run (graph:<startId>), and it creates a channel itself.");

// Public shape of a channel: participants with name, kind, cursor and unread count.
// `?since=` of a read route: a number (< 1e9) is the sequence number, anything else a point in time (epoch ms or ISO).
function channelSinceFromQuery(url) {
  const raw = String(url.searchParams.get("since") || "").trim();
  if (!raw) return { since: 0, sinceTime: 0 };
  if (/^\d+$/.test(raw) && Number(raw) < 1e9) return { since: Math.max(0, Number(raw)), sinceTime: 0 };
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return { since: 0, sinceTime: Number.isFinite(ms) && ms > 0 ? ms : 0 };
}
function publicChannel(channel, { messages = false, since = 0, sinceTime = 0 } = {}) {
  const participants = store.listChannelParticipants(channel.id).map((t) => {
    const chat = store.getChat(t.chatId);
    // `archived` and `questionOpen`: the reasons a participant's cursor stays put without it running — the channel bar
    // computes the hint on "{n} waiting" from them (archive hold; open question or approval card — channels/delivery.js
    // deliverChannel, channelInputHolds).
    return {
      chatId: t.chatId, participantKind: t.kind, cursor: t.cursor, name: chat ? chatDisplayName(chat) : "", kind: chat?.kind || "",
      unread: store.channelUnreadOf(channel, t.cursor), running: running.has(t.chatId),
      archived: Boolean(chat?.archivedAt), questionOpen: Boolean(chat && (openAskOf(t.chatId) || openCard(t.chatId))),
    };
  });
  // `unreadUser` is the number on the sidebar row — computed against the user's read marker, not against a participant cursor.
  const out = { ...channel, participants, unreadUser: Math.max(0, channel.lastSeq - (channel.readSeq | 0)) };
  if (messages) out.messages = store.listChannelMessages(channel.id, { since, sinceTime }).map((n) => channelCard(channel, n, "log"));
  return out;
}
// Create a channel with participants: exactly two chats of the same workspace.
function channelCreate(ws, { name = "", participants = [], status = "open", creatorChatId = null, cap = 8 }) {
  const chatIds = [...new Set((Array.isArray(participants) ? participants : []).map(String).filter(Boolean))];
  if (chatIds.length !== 2) throw new Error(T("A channel has exactly two participants"));
  for (const id of chatIds) {
    const c = store.getChat(id);
    if (!c || c.workspaceId !== ws.id) throw new Error(T`Chat ${id} does not belong to this workspace`);
    // A new channel with a participant of kind manager would be frozen before it begins (409, channels/freeze.js).
    if (managerLocked(c)) throw channelFrozenError();
    if (id !== creatorChatId && isChildChat(c)) throw new Error(childChatNoTarget());
  }
  if (!store.CHANNEL_STATUS.includes(status)) throw new Error(T("Unknown channel status"));
  const channelName = String(name || "").trim() || chatIds.map((id) => chatDisplayName(store.getChat(id))).join(" ↔ ");
  const creator = creatorChatId || null;
  const channel = store.createChannel({ id: crypto.randomUUID(), workspaceId: ws.id, name: channelName, status, cap, creatorChatId: creator, proposalItemId: null });
  for (const id of chatIds) store.addChannelParticipants(channel.id, { chatId: id });
  broadcast({ type: "channel", workspaceId: ws.id, channelId: channel.id, created: true });
  return publicChannel(store.getChannel(channel.id));
}

export { channelCreate, channelSinceFromQuery, publicChannel };
// For agent communication (communication/read.js, communication/retrieval.js): situation, history and row of the status are
// the reading of a chat for a model — ONE version for cbase_agents_list (view "chat", summary on request).
export { CHANNEL_STATUS_RAW_MAX, CHANNEL_STATUS_ROLES, channelStatusSituation, channelStatusSince, channelStatusHistory, channelStatusRow };
