# `scheduled/` — scheduled jobs in Coding

**What lives here:** the domain side of the scheduled jobs. A job hangs on EXACTLY one Coding chat (`chats.job_id`); every
occurrence is a message to that chat (cause "schedule"), not a new chat.

| File | What | Called by |
|---|---|---|
| `contract.js` | the contract between backend, web and iOS as a leaf without imports (pattern `../preview/contract.js`): cadences (`oneTime`, `daily`, `workdays`, `weekly`, `monthly`), day of month 1–28, weekday 0–6, status of the job (`active`, `paused`, `done`), causes and status of a run, the derived state for the UI (`queued`, `running`, `parked`), the fields of the responses, the fields of a PATCH and the job field on the chat list | all files here, web, iOS |
| `cadence.js` | a leaf that imports only `../cron.js` and `../i18n.js`: `cadenceOff(cadence, plan, {timeZone, now})` checks form and plan and derives cron and `oneTimeAt` (`hours`, `cron` and a missing cadence are an error, as is a missing clock time — no default 08:00), `nextOccurrence` (strictly after `from`), `periodMs` (the UPCOMING distance, the basis of catching up) and `cadenceText` (the finished text in the UI language, via `T`) | `routes.js`, `run.js`, `tick.js` |
| `run.js` | the run: `startRun(job, cause, { scheduledAt })` delivers an occurrence through the ordinary delivery (`../runs/queue.js` deliverUserPrompt — busy, compacting, parked or locked ⇒ queued, FIFO with the human's entries; if an occurrence of this job is already waiting, the new one is `failed`), `endRun` (the **run end**: row, repetition after `SCHEDULED_REPETITION_MS`, one-time ⇒ `done`, notice via `notification.js`) and the subscribers of the hooks (see below); `cadencePlainText` for the system prompt | `tick.js`, `routes.js` ("Run now"), `server.js` (hooks, `setScheduledCadenceText`) |
| `tick.js` | the **tick**: `scheduledTick()` — who is due: catch up (threshold `CBASE_SCHEDULE_CATCH_UP_MS`), book as `missed`, repeat or start, then move the occurrence on; tick `SCHEDULED_CHECK_MS` (`CBASE_SCHEDULE_TICK_MS`, 30 s); the **restart cleanup** `scheduledAtStart()` — an open run stays open when its chat has an active_runs entry, is parked at the limit or its entry is in the restored queue, otherwise it ends `error` "Server restarted"; test seam `scheduledTicks` | `server.js` at start |
| `routes.js` | `scheduledWorkspaceRoutes` (sub-slice of `../workspaces/routes.js`: list, creating chat AND job in one go, reading, PATCH only `PATCH_FIELDS` (if a job with a new plan or one made `active` again has no upcoming occurrence, that is a 400 — a done one-time job needs a new moment), DELETE — the chat stays —, "Run now", paging the runs), `publicJob`, `stateOf` and the **wakeup** `scheduleNextRoute` (`GET /api/schedules/next`, the earliest occurrence for the gateway, response `{nextAt, in, running}`) | dispatcher (`server.js` ROUTES, `../workspaces/routes.js`) |
| `notification.js` | `runEndNotification` (kind `schedule` with `chatId`, no notice when the choice is off, a question is open, a repetition follows or for `aborted`), `scheduledApprovalRequest`/`scheduledApprovalRuling` (a Coding card in the scheduled turn reports itself as an `approval` notice), `isScheduledTurn` (in the scheduled turn question and approval always push) | `run.js`, `server.js` (hooks), `../workflows/run-state.js` |
| `chat-field.js` | leaf (store and `../notify.js`): `chatJobField(chat)` (the field `job` on every row of GET /api/chats) and `JOB_NOTIFICATIONS` (the notification kinds of a job chat for PATCH /api/chats/:id) — `../chats/routes.js` reads it without pulling in the run | `../chats/routes.js`, `routes.js` |

**The hooks** (registered in `server.js`): `turnStart`/"scheduled" (`scheduledTurnStart`, the real START of an occurrence: sets
`startedAt`, reports `running` — the only place, `startRun` only reports `queued` —, closes an open question with its bell notice
— at the start, not when queueing: while the occurrence waits, the human can still answer the card),
`beforeRunBroadcast`/"scheduled-end" (`scheduledEndHook`, the run end of a turn with cause "schedule"; a parked turn ends only
with its continuation), `end`/"scheduled" (`scheduledWorkEnd`, a run that waited for its background work), `afterLimitCancel`/"scheduled-end"
(`scheduledDismissedHook`, the parked continuation is dismissed: kind "cancel" — the human at the strip — ⇒ `aborted`; any other
kind — attempt cap, switch off, credit situation — ⇒ `error` with the wording, without repetition),
`restartGraceAbandoned`/"scheduled" (`scheduledAbandoned`, the resume after the restart is given up ⇒ `error` without repetition),
`chatClosed`/"scheduled" (the job falls with its chat), `inputDismissed`/"scheduled" (the queued occurrence is dismissed ⇒
`dismissed`), `beforePermission`/`afterPermission` "scheduled-approval" (`notification.js`). Only a chat with `kind = normal`
gets an occurrence.

**The mapping turn ↔ run:** the occurrence carries the id of its run as the marker `scheduledRun` — in the queue entry, in the
turn's input (`../runs/queue.js` deliverUserPrompt, `../runs/human-input.js` inputOf) and in the entry a gate creates behind a
foreign wait row (`../runs/limit-gate.js` parkOrQueue). `run.js:waitingInTheQueue(run)` is the ONE question "is this run still
waiting?" (entry id or marker) — `stateOf` (queued), `waitingRun` (failed) and the restart cleanup read it. Start and end read
the marker from the inputs; without it (resume after a restart, continuation of a wait row) the run that the start of the turn
took over applies, and only then the oldest open run not waiting in the queue. **Limits:** the server recognizes the human only
by the fence — an agent shell without a fence (user container without a project container, local server) cannot be told from
the UI on a PATCH (`../runs/instance-switch.js` JOB_ONLY_HUMAN).

**Terms (→ file):** job, run → `../store/scheduled.js` (data layer) · the binding chat ↔ job → `../store/chats.js` (`chats.job_id`) · cadence, next occurrence, period, plain text → `cadence.js` · allowed values and fields of the seam → `contract.js` · run start → `run.js:scheduledTurnStart` · run end → `run.js:endRun` · is the run still waiting → `run.js:waitingInTheQueue` · tick and restart cleanup → `tick.js` · wakeup → `routes.js:scheduleNextRoute`.

**The most common questions:**
- Where are provider, model, effort level, permission mode, project and name of a job? → on the CHAT that carries it: `../store/chats.js` (`jobId`), written via `PATCH /api/chats/:id` with its rules. The job does not copy them.
- Why does "daily 02:30" fire at 03:30 on the day clocks go forward? → `cadence.js` computes via `../cron.js:nextCronAtZone` in the job's zone; a clock time in the daylight-saving gap fires an hour later at the same minute. Guard `server/backend/test/scheduled-cadence.test.js`.
- Why no day 29–31 for "monthly"? → Vixie cron would skip whole months; `contract.js:DAY_OF_MONTH`, checked in `cadence.js`, bound in the same guard.

**What does NOT live here:** the time zone per workspace (`../workspaces/timeZone.js`).
