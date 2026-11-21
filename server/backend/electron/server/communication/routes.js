// Routes: agent communication. Every function takes ctx = { req, res, url, p, m } (sub-slices of the chat family also
// id/sub/chat) and returns NEXT if it is not responsible; any other return means "answered".
// Functions: communicationChatRoutes (sub-slice of chats/routes.js chatRoutes).
// The SEND ROUTE stays POST /api/chats/:id/agent/send in runs/routes.js and delegates to send.js sendMessage.

import { NEXT, send } from "../runtime/http.js";
import { readView } from "./read.js";

export async function communicationChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
  // cbase_agents_list: the view and its parameters are in the query. From a project network the response of a list carries
  // the fence's marker (the MCP server then appends a "filtered …" note).
  if (sub === "/communication" && m === "GET") {
    const r = await readView(chat, url, ctx.fence || null);
    const view = String(url.searchParams.get("view") || "summary");
    if (ctx.fence && (view === "summary" || view === "chats")) res.setHeader("x-cbase-fenced", "1");
    return send(res, r.status, r.body);
  }
  return NEXT;
}
