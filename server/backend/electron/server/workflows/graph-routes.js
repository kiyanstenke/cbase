// Routes: graph workflows from the chat. Each function takes ctx = { req, res, url, p, m } plus the fields of its family
// and returns NEXT when it is not responsible; any other return means "answered".
// graphWorkflowChatRoutes (sub-table of chats/routes.js:chatRoutes, behind workflowChatRoutes) serves the MCP tools
// cbase_workflow_start (POST /graph-workflows/start), cbase_workflow_status (GET /graph-workflows[?startId=]) and
// cbase_workflow_stop (POST /graph-workflows/:startId/stop, `from` "agent" | "human", missing = "human"). The stop is on
// the archive's allowlist (chats/routes.js:archiveAllowed, an emergency valve like /stop), the start is not: an archived
// chat runs no turn, and announcements only happen in a turn. The work is done by graph-start.js.

import { T } from "../i18n.js";
import { NEXT, readBody, send } from "../runtime/http.js";
import { graphRunsView, startPerTool, stopGraphStart } from "./graph-start.js";

// A broken %-escape is not an existing id — no throw (500), but the 404 "unknown" behind it.
const decrypted = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export async function graphWorkflowChatRoutes(ctx) {
  const { req, res, url, p, m, id, sub, chat } = ctx;
        if (sub === "/graph-workflows/start" && m === "POST") {
          const b = await readBody(req);
          const r = await startPerTool(chat, b);
          return send(res, r.status, r.body);
        }
        if (sub === "/graph-workflows" && m === "GET") {
          const r = graphRunsView(chat, String(url.searchParams.get("startId") || "").trim());
          return send(res, r.status, r.body);
        }
        const st = sub.match(/^\/graph-workflows\/([^/]+)\/stop$/);
        if (st && m === "POST") {
          const b = await readBody(req);
          const from = b && typeof b === "object" ? b.from : undefined;
          if (from !== undefined && from !== "agent" && from !== "human") {
            return send(res, 400, { error: T("from must be \"agent\" or \"human\"."), reason: "from" });
          }
          const r = await stopGraphStart(chat, decrypted(st[1]), { from: from ?? "human" });
          return send(res, r.status, r.body);
        }
  return NEXT;
}
