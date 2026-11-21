// The notifications of the scheduled jobs.
//
//   runEndNotification(a, run, …)    at the run end (run.js endRun): kind `schedule` with `chatId` (the jump target is the
//                                    Coding chat), title = name, text = `short` or the error. NO notice when the chat's
//                                    choice for `schedule` is off (neither bell nor push), when a question is open (its
//                                    own notice carries the question, runs/ask.js), when a repetition follows (a single
//                                    dropout is not news), and for `aborted` (the human stopped or dismissed). Push is
//                                    decided by pushAllowed via the chat's choice (workflows/run-state.js pushVerdictForNote).
//   scheduledApprovalRequest         hook "beforePermission"/"scheduled-approval": a Coding card in the scheduled turn
//                                    reports itself as a notice `approval` with `chatId` and `requestId` — otherwise a
//                                    Coding card reports nothing (runs/permissions.js), and a nightly run would stand
//                                    still without anyone learning of it.
//   scheduledApprovalRuling          hook "afterPermission"/"scheduled-approval": the notice is done (resolveNotices).
// In the scheduled turn question and approval ALWAYS push (pushVerdictForNote, `isScheduledTurn`); the user's own turns in
// the same chat follow the normal choice.

import * as store from "../store.js";
import { T } from "../i18n.js";
import { OFF } from "../notify.js";
import { recordNotice, resolveNotices } from "../services.js";
import { openAskOf } from "../runs/ask.js";
import { runCause } from "../runs/state.js";

/** Is a scheduled turn running in this chat right now (cause "schedule" in a job chat)? */
export const isScheduledTurn = (chat) => Boolean(chat?.jobId) && runCause.get(chat.id)?.cause === "schedule";

/** The notice at the run end. `status` and `reason` as in endRun, `again`: a repetition follows. */
export function runEndNotification(a, run, { status, reason = "", short = "", again = false }) {
  if (status !== "ok" && status !== "error") return null;
  if (status === "error" && again) return null;
  const chat = run?.chatId ? store.getChat(run.chatId) : null;
  if (!chat) return null;
  if (chat.notify?.schedule === OFF) return null;
  if (openAskOf(chat.id)) return null;
  const name = chat.title || T("Scheduled task");
  return recordNotice({
    kind: "schedule", chatId: chat.id, chatTitle: name, workspaceId: a.workspaceId, projectId: chat.projectId || null,
    title: status === "ok" ? name : T`Run failed: ${name}`,
    body: status === "ok" ? (short || T("Run finished")) : String(reason || "").slice(0, 300),
  });
}

// beforePermission/"scheduled-approval": only the Coding card in the scheduled turn. The subscriber decides itself
// whether it is responsible; an error does not cost the card.
export function scheduledApprovalRequest({ chat, chatId, requestId, toolName, approval }) {
  if (approval || !requestId) return;
  try {
    const c = chat || store.getChat(chatId);
    if (!isScheduledTurn(c)) return;
    const name = c.title || T("Scheduled task");
    recordNotice({
      kind: "approval", chatId: c.id, chatTitle: name, workspaceId: c.workspaceId, projectId: c.projectId || null, requestId,
      title: T`Approval: ${name}`,
      body: T`The scheduled run is waiting for your approval of ${toolName || T("a tool")}.`,
    });
  } catch (e) { console.error("[scheduled] reporting approval:", e?.message || e); }
}

// afterPermission/"scheduled-approval": every decided request — a notice of this requestId (it exists only in the
// scheduled turn) is done. Without a notice a pass over the bell without a hit.
export function scheduledApprovalRuling({ chatId, request }) {
  if (!request?.requestId) return;
  try { resolveNotices({ id: chatId, requestId: request.requestId, kinds: ["approval"] }); }
  catch (e) { console.error("[scheduled] resolving approval:", e?.message || e); }
}
