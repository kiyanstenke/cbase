// Routes: the output folder of a chat, READ-ONLY. Sub-slice of `chats/routes.js:chatRoutes` — 404, archive lock (every GET
// is allowed in the archive, `archiveAllowed`) and manager lock come before it there. The computation (boundary, fallback,
// cap) lives in runs/outputs-view.js.
//
//   GET /outputs                          → the list of the output folder (shape: runs/outputs-view.js outputsList)
//   GET /outputs/file?path=<rel>[&inline=1]   → the file as a stream over the checked descriptor
//
// Consumers: web (lib/api/outputs.ts — artifacts → outputs, clickable paths in the chat), iOS (Chat/ChatOutputs.swift).
// Guard: server/backend/test/outputs-view.test.js.
import { T } from "../i18n.js";
import { NEXT, dispositionHeader, supplyFile, send } from "../runtime/http.js";
import { servingHeader } from "../runtime/serving.js";
import { outputType, outputsList, openOutput } from "../runs/outputs-view.js";

export async function outputsChatRoutes(ctx) {
  const { res, url, m, sub, chat } = ctx;
  if (m !== "GET") return NEXT;
  if (sub === "/outputs") {
    try { return send(res, 200, outputsList(chat)); } catch (e) { return send(res, 500, { error: String(e?.message || e) }); }
  }
  if (sub === "/outputs/file") {
    const rel = url.searchParams.get("path") || "";
    let file;
    try { file = openOutput(chat, rel); } catch (e) {
      const status = e?.status || 500;
      const text = status === 400 ? T("Invalid path in the output folder")
        : status === 403 ? T("The path leads outside the output folder")
        : status === 404 ? T("File not in the output folder")
        : String(e?.message || e);
      return send(res, status, { error: text });
    }
    const type = outputType(file.name);
    const inline = url.searchParams.get("inline") === "1";
    // `private, no-cache`: the folder is LIVE — an agent rewrites a report and the view should show the new state; `private`
    // because Cloudflare otherwise caches image extensions publicly at the edge (see the attachment GET in chats/routes.js).
    return supplyFile(res, { fd: file.fd }, {
      "Content-Type": type,
      "Content-Disposition": dispositionHeader(file.name, inline),
      "Cache-Control": "private, no-cache",
      ...servingHeader(type),
    });
  }
  return NEXT;
}
