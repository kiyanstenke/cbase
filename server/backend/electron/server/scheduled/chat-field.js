// What the chat knows about its scheduled job: the field `job` on every row of GET /api/chats and the notification
// kinds of a job chat for PATCH /api/chats/:id. A leaf (store and notify.js) — chats/routes.js reads it without
// pulling in the run (run.js → runs/queue.js).

import * as store from "../store.js";
import * as notifications from "../notify.js";

/** The notification kinds a job chat carries: those of a chat and those of a schedule. */
export const JOB_NOTIFICATIONS = Object.freeze([...new Set([...notifications.CHAT_KINDS, ...notifications.SCHEDULE_KINDS])]);

/** The job field on a row of GET /api/chats (contract.js CHAT_JOB_FIELDS) — `null` without a job. */
export function chatJobField(chat) {
  const a = chat?.jobId ? store.getScheduledJob(chat.jobId) : null;
  return a ? { id: a.id, name: chat.title || "", status: a.status, nextAt: a.nextAt } : null;
}
