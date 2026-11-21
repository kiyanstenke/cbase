// The contract of the scheduled jobs between backend, web and iOS as ONE leaf without imports — pattern
// `preview/contract.js`. The backend computes with these lists (store/scheduled.js stores their values,
// scheduled/cadence.js computes the cadences, the routes check against them); the binding test
// web/test/scheduled-binding.test.mjs holds web (lib/scheduled.ts) and iOS (Models/ScheduledModels.swift) to it —
// changing a line here turns the suite red until both clients have followed.

/** The forms of repetition. `hours` and `cron` no longer exist — they are a 400. */
export const CADENCES = Object.freeze(["oneTime", "daily", "workdays", "weekly", "monthly"]);
/** Monthly only day 1–28: on a 29th, 30th or 31st Vixie cron would skip whole months. */
export const DAY_OF_MONTH = Object.freeze({ min: 1, max: 28 });
/** Weekdays as in cron: 0 = Sunday … 6 = Saturday. */
export const WEEKDAY = Object.freeze({ min: 0, max: 6 });
/** The state of a job; `done` is a one-time job after its run. */
export const JOB_STATUS = Object.freeze(["active", "paused", "done"]);
/** Why a run came into being: the tick, "Run now", a caught-up occurrence, the repetition after an error. */
export const RUN_CAUSES = Object.freeze(["tick", "hand", "caughtUp", "repetition"]);
/** How a run ended; `open` means queued or running. */
export const RUN_STATUS = Object.freeze(["open", "ok", "error", "aborted", "missed", "failed", "dismissed"]);
/** The derived state for the UI — computed, never stored; `null` means "none of these". */
export const STATES = Object.freeze(["queued", "running", "parked"]);
/** Maximum length of the instructions. */
export const INSTRUCTIONS_MAX = 20_000;

/** The fields of a job in responses — the run values (name, provider, model, …) are on the chat, not here. */
export const JOB_FIELDS = Object.freeze([
  "id", "workspaceId", "chatId", "instructions", "cadence", "plan", "timeZone",
  "status", "nextAt", "retryAt", "lastRunAt", "lastStatus", "lastError", "createdAt", "updatedAt",
]);
/** What the routes attach to every job: name and project of its chat, the cadence in plain text, the derived state
 *  (STATES or null) and the last run (RUN_FIELDS or null). */
export const JOB_DERIVED = Object.freeze(["name", "projectId", "cadenceText", "state", "lastRun"]);
/** The fields of a run in responses. */
export const RUN_FIELDS = Object.freeze([
  "id", "jobId", "workspaceId", "chatId", "cause", "scheduledAt", "queuedAt", "startedAt", "endedAt",
  "status", "error", "short", "question",
]);
/** What a PATCH of the job may change — a missing field means unchanged; everything else the chat PATCH changes. */
export const PATCH_FIELDS = Object.freeze(["instructions", "cadence", "plan", "timeZone", "status"]);
/** The job field on every row of GET /api/chats: these fields or `null`. */
export const CHAT_JOB_FIELDS = Object.freeze(["id", "name", "status", "nextAt"]);
