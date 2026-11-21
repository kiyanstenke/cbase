# `components/scheduled/` — Coding → Scheduled

A **scheduled job** hangs on EXACTLY one coding chat; every occurrence is a short message to that chat (cause "schedule"), and the
agent carries out the instructions that stand in the chat's system prompt. The run values (name = title, project, instance,
provider, model, effort level, permission mode, notification choice) live on the CHAT; the job carries only instructions, cadence
and status.

| File | What |
|---|---|
| `ScheduledTab.tsx` | the tab (on both levels; inside an entered project the project's jobs): load the list, reload on the `scheduled` event (server `scheduled/run.js`, `tick.js`) and `chat_title`, segments upcoming · paused · done (kit `Segments`, `data-scheduled-segment`), "New job" (`data-scheduled-new`), kit `SplitPane` list/detail, the choice per scope in `localStorage` (`cbase-scheduled:<ws>:<project\|ws>`); after every own action `lib/scheduled.ts:reportScheduledChanged` — the server does not report create and PATCH, and the hidden chat list in Coding → Chats reloads only through it |
| `ScheduledList.tsx` | ONE row per job in the form of the coding pages (tile with a clock in the colour of the state, name, facts line: cadence in the server's plain text, remaining time to the next occurrence, last run); `occurrenceText` |
| `ScheduledDetail.tsx` | header (name, cadence, next occurrence, state) with "Run now" (`data-scheduled-now`, locked while a run is open), "Pause"/"Resume" (`data-scheduled-pause`), the runs (kit `Menu`, sheet `cb-pop` on the body, `data-scheduled-runs`, pages without closing) and "Settings"; below it the job's chat as `chat/ChatPane` in mode `onlyChat` (`key` = chat id) |
| `JobDialog.tsx` | create and edit (kit `Modal`): instructions, repetition, time of day or point in time, weekdays, day of month; "Advanced": name, project, instance (only when creating), permission mode (default full access), provider/model and effort level (`components/ProviderModel.tsx`), notification after every run; "Delete job" (the chat stays). When editing two PATCHes go out, each only with what changed: the job's and the chat's |

**What is NOT here:** the routes to the server and the shapes (`lib/api/scheduled.ts`), the calculations of the form, the segments and
the words (`lib/scheduled.ts`, guard `web/test/scheduled-form.test.mjs`, against contract and iOS `web/test/scheduled-binding.test.mjs`),
the tab key (`lib/coding-tabs.ts`), the clock on the chat list row (`chat/ChatListRows.tsx`, `data-row-job`; short-info text via
`lib/scheduled.ts:jobClock`), the backend (`server/backend/electron/server/scheduled/`).

**Three questions.**
- *Where do I change a job's model or permission mode?* → in the "Settings" dialog; it writes them to the chat via
  `PATCH /api/chats/:id` — the same rules as everywhere (400 for an unknown effort level, a provider switch starts a new session).
  The instance is switched by the instance choice in the header of the chat below.
- *Why is "Run now" grey?* → a run of this job is open (state queued, running or parked at the limit); the server otherwise answers 409.
- *Why does a job's chat also appear in Coding → Chats?* → it is an ordinary coding chat: with a clock in the row, never in the
  automatic archive; every occurrence brings it back from the archive.
