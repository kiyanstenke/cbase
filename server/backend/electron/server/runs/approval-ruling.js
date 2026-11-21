// The ruling row of an approval card (approvalRulingReport) and its consumer at the hook "afterPermission" (approvalRulingHook, name
// "approval-ruling", registered in server.js; fired in runs/approvals.js). A leaf with two imports, store and stream — the ruling
// row belongs to EVERY card.

import * as store from "../store.js";
import { sse } from "../runtime/sse.js";

// Report a ruling: a row in the history with its origin (user · stop · running) and an event on the chat's stream. Also for
// the Coding card: its row additionally carries the remembered rule (`remember`).
function approvalRulingReport(p, decision, origin, reason = "") {
  const requestId = p?.approval?.requestId || p?.requestId;
  if (!p || !requestId) return;
  const at = Date.now();
  const updatedInput = decision.behavior === "allow" ? (decision.updatedInput ?? p.input ?? {}) : null;
  const remember = !p.approval && typeof decision.remember === "string" && decision.remember.trim() ? decision.remember.trim() : "";
  const entry = { requestId, toolName: p.toolName, behavior: decision.behavior, reason: String(reason || ""), origin, updatedInput, at, ...(remember ? { remember } : {}) };
  try {
    store.addMessage(p.chatId, "approval_ruling", JSON.stringify(entry), at);
    sse(p.chatId, { type: "harness", subtype: "approval_ruling", ...entry });
  } catch (e) { console.error("[approval] ruling row:", e?.message || e); }
}

// Hook "afterPermission" — the ruling row (permissions.js): for EVERY request, with and without a marker (approvalRulingReport
// distinguishes itself). Its try/catch ("[approval] ruling row:") is carried by the function itself; the hook frame is the
// second net.
function approvalRulingHook({ request, decision, origin, reason }) {
  approvalRulingReport(request, decision, origin, reason);
}

export { approvalRulingHook, approvalRulingReport };
