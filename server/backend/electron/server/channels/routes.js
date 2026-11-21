// Routes: channels. Every function takes ctx = { req, res, url, p, m } (sub-slices of a family also id/sub/chat,
// wid/sub/ws or pid/sub/proj) and returns NEXT if it is not responsible; any other return means "answered". Order of the
// calls: ROUTES in server.js.
// Functions: channelRoutes · channelChatRoutes · channelWorkspaceRoutes.

import fs from "node:fs";
import path from "node:path";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { NEXT, attachmentMime, supplyFile, readBody, safeFileName, send } from "../runtime/http.js";
import { servingHeader } from "../runtime/serving.js";
import { broadcast } from "../runtime/sse.js";
import { channelCreate, channelSinceFromQuery, publicChannel } from "./lifecycle.js";
import { channelFileDir, resolveChannelFiles, reloadChannelFiles, sendToChannel } from "./messages.js";
import { resumeChannel, channelCard, openChannel, pauseChannel, closeChannel } from "./delivery.js";

import { channelHistory } from "../communication/read.js";
import { channelFrozen } from "./freeze.js";
import { managerLock } from "../runs/manager-lock.js";

export async function channelRoutes(ctx) {
  const { req, res, url, p, m } = ctx;
      // ── Channels: one channel, its history, a message into it ──────────────────────────
      // Bound to a chat, not to a workspace: the caller is a chat (MCP, CBASE_CHAT_ID) or a chat's view; the workspace
      // follows from the channel.
      // Download a file from a channel: the bytes live once per message under channel-files/<channel>/ — the same path
      // for card, sidebar and both sides.
      const channelFileM = p.match(/^\/api\/channels\/([0-9a-f-]+)\/files\/([^/]+)$/);
      if (channelFileM && m === "GET") {
        const channel = store.getChannel(channelFileM[1]);
        if (!channel) return send(res, 404, { error: T("Channel not found") });
        const file = safeFileName(decodeURIComponent(channelFileM[2]));
        const full = path.join(channelFileDir(channel.id), file);
        if (!fs.existsSync(full)) return send(res, 404, { error: T("File not found") });
        // Open before the header, deliver through pipeline (runtime/http.js supplyFile). sendToChannel also copies from a
        // project container's runtime folder, and the card links the file with target=_blank — an SVG runs only in the
        // sandbox (runtime/serving.js), nosniff always.
        return supplyFile(res, { path: full }, { "Content-Type": attachmentMime(file), "Cache-Control": "private, max-age=31536000", ...servingHeader(attachmentMime(file)) });
      }
      const channelM = p.match(/^\/api\/channels\/([0-9a-f-]+)(\/messages|\/pause|\/resume|\/close|\/open|\/read)?$/);
      if (channelM) {
        const channel = store.getChannel(channelM[1]);
        if (!channel) return send(res, 404, { error: T("Channel not found") });
        // A frozen channel (channels/freeze.js) is read-only — PATCH, message, read marker, pause, resume, close and open
        // are 409, before the body.
        if (m !== "GET" && channelFrozen(channel.id)) return send(res, 409, managerLock());
        if (!channelM[2] && m === "GET") {
          return send(res, 200, publicChannel(channel, { messages: true, ...channelSinceFromQuery(url) }));
        }
        if (!channelM[2] && m === "PATCH") {
          const b = await readBody(req);
          try {
            let k = channel;
            if (typeof b.name === "string" && b.name.trim()) k = store.updateChannel(k.id, { name: b.name.trim().slice(0, 200) });
            // Cap per channel: 0 means no cap.
            if (b.cap !== undefined) {
              const d = Number(b.cap);
              if (!Number.isInteger(d) || d < 0 || d > 1000) return send(res, 400, { error: T("cap: integer 0…1000") });
              k = store.updateChannel(k.id, { cap: d });
            }
            // The STATE is set through /pause, /resume, /close, /open — they carry the rules and the system note; a raw
            // status writer would be a second state machine.
            if (b.status !== undefined) return send(res, 400, { error: T("status: use /pause, /resume, /close, /open") });
            return send(res, 200, publicChannel(store.getChannel(k.id)));
          } catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
        }
        if (channelM[2] === "/pause" && m === "POST") {
          const b = await readBody(req);
          try { return send(res, 200, publicChannel(pauseChannel(channel, String(b.reason || T("user##channel-reason"))))); }
          catch (e) { return send(res, 409, { error: String(e?.message || e) }); }
        }
        if (channelM[2] === "/resume" && m === "POST") {
          const b = await readBody(req);
          try { return send(res, 200, publicChannel(resumeChannel(channel, { rounds: b.rounds }))); }
          catch (e) { return send(res, 409, { error: String(e?.message || e) }); }
        }
        // The user's read marker: it only moves forward (a second window must not turn it back) and at most to the end.
        // The event makes other windows reload.
        if (channelM[2] === "/read" && m === "POST") {
          const b = await readBody(req);
          const seq = Number(b.seq);
          if (!Number.isInteger(seq) || seq < 0) return send(res, 400, { error: T("seq: integer ≥ 0") });
          const k = store.setChannelRead(channel.id, seq);
          if (k.readSeq !== channel.readSeq) broadcast({ type: "channel", workspaceId: k.workspaceId, channelId: k.id, read: true });
          return send(res, 200, publicChannel(k));
        }
        if (channelM[2] === "/close" && m === "POST") {
          const b = await readBody(req);
          try { return send(res, 200, publicChannel(closeChannel(channel, String(b.reason || T("user##channel-reason"))))); }
          catch (e) { return send(res, 409, { error: String(e?.message || e) }); }
        }
        // Reopen: only a closed channel, only the human in the channel bar — "rejected" and every other state are 409
        // (delivery.js openChannel). The same response shape as pause/resume.
        if (channelM[2] === "/open" && m === "POST") {
          try { return send(res, 200, publicChannel(openChannel(channel))); }
          catch (e) { return send(res, 409, { error: String(e?.message || e) }); }
        }
        if (channelM[2] === "/messages" && m === "POST") {
          const b = await readBody(req);
          const text = String(b.text || "").trim();
          if (!text) return send(res, 400, { error: T("text missing") });
          const from = store.getChat(String(b.chatId || ""));
          if (!from) return send(res, 400, { error: T("chatId: chat not found") });
          // Resolve files within the SENDER's reach — a refusal is a 400 of writing, and nothing is sent.
          let files;
          // If the request came from a project container (ctx.fence), its INSTANCE applies — main or copy, the token's
          // identifier —, also for a subagent that lives on in the old project after a project switch (messages.js
          // channelSituation). Files from the project folder of a COPY are then fetched by its container
          // (reloadChannelFiles); otherwise the step does nothing.
          try { files = resolveChannelFiles(from, b.files, { origin: ctx.fence?.identifier || null }); await reloadChannelFiles(files); }
          catch (e) { return send(res, 400, { error: String(e?.message || e) }); }
          try {
            const message = sendToChannel(channel, { ofChatId: from.id, text, files });
            return send(res, 201, channelCard(store.getChannel(channel.id), message, "out"));
          } catch (e) { return send(res, 409, { error: String(e?.message || e) }); }
        }
      }
  return NEXT;
}

export async function channelChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        // ── This chat's channels: list with counterpart and unread count, history ──
        if (sub === "/channels" && m === "GET") {
          const items = store.listChannelsOfChat(id).map((k) => {
            const pk = publicChannel(k);
            return {
              id: k.id, name: k.name, status: k.status, pauseReason: k.pauseReason, lastSeq: k.lastSeq, updatedAt: k.updatedAt,
              unread: store.channelUnread(k.id, id), unreadUser: pk.unreadUser,
              opposite: pk.participants.filter((t) => t.chatId !== id).map((t) => ({ chatId: t.chatId, name: t.name, kind: t.kind, running: t.running })),
            };
          });
          return send(res, 200, { channels: items });
        }
        // A channel's history for this chat: ONE version with the view "channel" of cbase_agents_list
        // (communication/read.js channelHistory).
        const chatChannelM = sub.match(/^\/channels\/([0-9a-f-]+)$/);
        if (chatChannelM && m === "GET") {
          const r = channelHistory(chat, chatChannelM[1], url);
          return send(res, r.status, r.body);
        }
  return NEXT;
}

export async function channelWorkspaceRoutes(ctx) {
  const { req, res, url, p, m, wid, sub, ws } = ctx;
        // ── Channels ────────────────────────────────────────────────────────────
        if (sub === "/channels" && m === "GET") {
          return send(res, 200, { items: store.listChannels(wid).map((k) => publicChannel(k)) });
        }
        // Create WITHOUT approval — for UI and test benches (the user creates it themselves). An agent's way is
        // cbase_agent_send to chat:<id> (silently a channel, communication/target-chat.js). Named fields only: no raw
        // status or proposalItemId from the body, the cap checked as on PATCH.
        if (sub === "/channels" && m === "POST") {
          const b = await readBody(req);
          const cap = b.cap === undefined ? 8 : Number(b.cap);
          if (!Number.isInteger(cap) || cap < 0 || cap > 1000) return send(res, 400, { error: T("cap: integer 0…1000") });
          try { return send(res, 201, channelCreate(ws, { name: b.name, participants: b.participants, creatorChatId: b.creatorChatId, cap })); }
          catch (e) { return send(res, e?.managerLocked ? 409 : 400, e?.managerLocked ? managerLock() : { error: String(e?.message || e) }); }
        }
  return NEXT;
}
