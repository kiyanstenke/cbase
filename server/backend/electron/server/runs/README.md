# `runs/` — runs (a run = one turn of a chat)

**What lives here:** the hub of the server — everything a turn needs from its start to its follow-up work, and what waits
between turns. No domain is imported here (only `routes.js` may): the domain side registers through the hook registry
(`hooks.js`) and through setters wired in `server.js`.

## The three questions

1. **Is the chat occupied?** `running` is not the only re-entry lock. A chat is also occupied while NO turn runs: during
   compaction (`compacting`), behind a run wait row ("parked is like running"), while the target gate judges
   (`state.js:targetCheck`, a counter) and while a graph workflow decides without a turn (`state.js:workflowDecides`). A
   message arriving then is queued (`queue.js:deliverUserPrompt`), steer and `/compact` answer 409, and whoever closes
   such a window lets the queue drain through `auto-continue.js:drainQueue` — that function asks every lock itself.
2. **Who owns it — the turn or the chat?** The turn owns its process, its instance and its wait phase. The CHAT owns
   subagents (`agents.js`), monitors (`monitors.js`), the wakeup (`wakeup.js`), open approval cards of background agents
   (`approvals.js`), silent hints (`hints.js`) and the queue (`queue.js`). What the chat owns survives the end of the turn
   and reports back through ONE wake path: `queue.js:deliverUserPrompt` with a cause.
3. **Where does it run and where do its files live?** `instance.js` fixes the instance at the turn start (a turn stays in
   the instance it began in); `runtime-location.js` says where a chat's runtime files live; `runtime-limit.js`,
   `runtime-write.js` and the read paths in `system-prompt.js` are the limit for everything the user container reads or
   writes for a project that runs in a project container.

## Terms

- **Run / turn:** one model turn of a chat, `do-run.js:doRun`. **Run kind:** a registered provider of the preparation of
  a turn (`hooks.js:registerRunKind`, default `runKindDefault`).
- **Cause:** where a turn comes from — `user`, `event`, `schedule`, `channel`, `agent` (completion notice), `message`,
  `wakeup` (`state.js:CAUSES`). Only `user` entries are bundled and steered; a turn that takes inputs per cause
  takes only inputs of its own cause (`state.js:inputFitsIntoTheRun`).
- **Queue:** the entries of a chat waiting for a turn (`pendingRunInputs`, persisted in `run_inputs`). **Bundle:**
  contiguous `user` entries from the head become ONE turn (`queue.js:headerBundle`). **Steer:** abort the running turn
  and run all queued user messages as one run (`queue.js:controlNow`). **Held entry:** an entry that waits while a card
  for the human is open (`queue.js:setInputHolds`).
- **Wait row:** the ONE parked continuation per chat (`pending_resumes`), kind `run` > `judge` > `compact`
  (`limit-gate.js:rowMayWrite`), reason `reset`, `probe`, `credit`, `project` or `serverEnd`. A lower kind never displaces
  a higher one; a second parked `run` is queued behind the first (`limit-gate.js:parkOrQueue`).
- **Toggle A / toggle B:** auto-continue at the usage limit / the credit gate (start nothing new from the gate
  threshold). A gate row belongs to toggle B and is woken independently of A. **Overruled:** "start anyway" — an
  argument of exactly one start, never a state.
- **Verdict:** a derived model call in the middle of a flow (target gate, workflow condition). At the limit it is parked
  as a `judge` row with the state it was created in (`auto-continue.js:parkJudge`, `resumeJudge`).
- **Hook / switch:** `fireHooks(kind, payload)` informs subscribers; `turnout(kind, payload)` asks responders and takes
  the first answer that is not `undefined`. The registration list is ONE place in `server.js`; order = registration.
- **Completion notice:** a subagent's report in the form `<task-notification>` (`completionNotice.js`), stored under the
  role of a user message but a system notice. **Agent message:** `<cbase-message …>` (`message-marker.js`). **Silent
  hint:** what an agent learns WITHOUT being woken (`hints.js:depositHint`), fenced in front of its next input.
- **Open work / quiet:** the ONE computation of what is still going on (`routes.js`, `/api/runs/active`: `busy` for the
  deploy's idle gate, `quiet`/`open` for the test harness). What waits for a clock does not count.
- **Background work:** live subagents, running dynamic workflows and graph workflows of a chat — ONE query
  (`background.js`).
- **Read-only:** chats of a kind whose agent no longer exists accept nothing (`only-readable.js`, `manager-lock.js`).
- **Sandboxed oneshot:** a `runOnce` with foreign text runs in an empty cwd without tools (`sandboxing.js`).

## Map of files

| File | What |
|---|---|
| `state.js` | State of all runs: `running`, `compacting`, `runWaiting`, `pendingRunInputs`, the controller maps, `stopRun`, `waitForRunEnd`, `CAUSES`. Maps and sets are MUTATED across file boundaries, never rebound. |
| `do-run.js` | `doRun` in one piece — the turn; turn preamble, turn completion, wait phase. Close to the line-count guard: new things go into a building block of their own. |
| `queue.js` | Queue, delivery (`deliverUserPrompt`), injection into the running process, bundling, steer. |
| `limit-gate.js` | The two usage settings, limit windows, the gate verdict at the spawn layer (`gateVerdictHook`), the wait row, `creditGateHolds`, `projectLockHolds`, `clearAwayGateWithoutTurn`. |
| `auto-continue.js` | Scheduling and firing of a parked continuation, the sweeper, parked verdicts, history rows of role `limit`, `drainQueue`, the queue after a restart. |
| `resume.js` | Resumption of interrupted work after a restart. |
| `post-run.js` | After the run: automatic title, target verdict and target gate, clearing and compacting the context, autocompact. |
| `compaction-baseline.js`, `compaction-attachments.js`, `after-compaction.js` | cbase's own compaction: wordings and numbers, the attachments after a compaction, the first turn after it. |
| `system-prompt.js` | `buildSystemPrompt` and its blocks (project memory, project focus, copy paragraph, subagent choice, target, scheduled job, folder context), `resolveCwd`, caps for stored tool inputs/outputs, engine transcript. |
| `hooks.js` | Hook registry: run kinds, event hooks (`HOOK_KINDS`), switches (`SWITCHES_KINDS`), `observeHooks` for the golden harness. |
| `permissions.js`, `approvals.js`, `approval-ruling.js` | Remembered rules and `requestPermission`; the waiting room of open approvals with ownership per agent; the ruling line of a card. |
| `ask.js`, `question-history.js` | Question cards (cbase_ask); when a card closes in the history and what the agent reads about it. |
| `agents.js` | Owner of the subagents per chat: spec factory, core, live agents, caps, parking, stop, orphans, consumption. |
| `agent-set.js`, `call-blocks.js` | A subagent's toolset (a child never gets more than its parent agent); which call block belongs to a subagent start. |
| `background.js` | Open background work of a chat, with sources set from `server.js`. |
| `completionNotice.js`, `message-marker.js`, `monitor-notice.js` | The forms of system notices under the user role: completion notice, agent message, monitor notice. |
| `monitors.js`, `wakeup.js` | Owners of monitors and of the wakeup per chat — both outlive the turn; the wakeup and a persistent monitor also a restart (the monitor starts again with the same id and log; a crash loop is given up after `CBASE_MONITOR_RESUME_MAX` attempts with one notice). A persistent monitor has no total event cap, only the throttle. |
| `hints.js` | The silent hint to the next turn. |
| `human-input.js` | ONE reading of what the human typed in this turn; the announcement `/workflow:<short name>`. |
| `agenda-block.js` | Who keeps the agenda, and the fenced block that brings it into a turn without a resumed session. |
| `archive.js` | The archive seen from the runs: open work (`openWork`, the reasons `ARCHIVE_REASONS`), fetching a chat back at every run start, the event `chat_archive`. |
| `only-readable.js`, `manager-lock.js` | Chats that only stay readable. |
| `instance.js`, `instance-switch.js`, `wait-phase-yield.js` | The instance of a run and of a turn; the ONE way to change a chat's instance; giving up the wait phase when the chat stands elsewhere. |
| `runtime-location.js` | The runtime folder per project: where MCP file, attachments, outputs, profiles and worktrees of a chat live. |
| `runtime-limit.js`, `runtime-write.js` | The limit of a project in a container for readers and writers in the user container: anchors, area, descriptor-checked reading and writing. |
| `outputs.js`, `outputs-view.js` | The output place of a chat (what agents must still read after their end) and its read-only view for the human. |
| `session-location.js`, `session-transfer.js` | Where the CLI sessions live and when they move; the mechanics of the move. |
| `backend-access.js`, `lfs-environment.js` | A run's access to the backend; the Git/LFS environment of agent starts. |
| `git-post-work.js` | Removing worktrees of projects in a container — as a job in the project container, as post-work if it is stopped. Never removes a worktree with unsaved changes. |
| `project-lock.js` | The lock per project seen from runs/: the question, the reasons `project`/`serverEnd`, the check-back. |
| `server-end.js` | The orderly end of the server process. |
| `sandboxing.js`, `saver.js` | The sandboxing of a oneshot; the CPU saver toggle and who carries it. |
| `booking.js`, `lateBooking.js`, `turn-output.js`, `upstream-display.js` | Booking a main turn's consumption; late booking after a crash; the main run's output per turn; the provider behind a router (display only). |
| `routes.js` | Routes: `/api/runs/active`, `/api/active-runs`, and under `/api/chats/:id` stop, steer, permissions, ask, fork, monitor, agent*, wakeup, compact, auto-continue, message. The named exception that may import domains. |

## What does NOT live here

- The domains: workflows (`workflows/`, `dynworkflows/`), channels (`channels/`), scheduled jobs (`scheduled/`), project
  containers and copies (`projectbox/`, `stacks/`), the outer loop (`outerloop/`). They subscribe
  to hooks or are set through setters; `runs/` never imports them (guard `server/backend/test/import-direction.test.js`).
- The provider connectors and the subagent core (`providers/`), the MCP tools and their rules (`../mcp/`), persistence
  (`store/`), the SSE stream (`runtime/sse.js`).
- The routes of dynamic workflows (`dynworkflows/routes.js`) and the global usage toggles (`settings/routes.js`).

## Invariants and traps

- **`/api/runs/active`:** `busy` is true as soon as a run OR a live background agent exists (an agent that outlives its
  turn has no journal; a swap would lose its work). Running dynamic workflows do NOT count in `busy` — they have a journal
  and resume after the restart — but are listed. A waiting wakeup counts in neither. A new item of open work needs its
  row in `routes.js:openWork` and its subtest in `server/backend/test/quiet.test.js`. A new field is visible from a
  project network only once it is in the fence's allow list (`projectbox/fence.js`).
- **Gate order in `doRun`:** fetch back from the archive, then the project lock, then the credit gate — all behind
  `running.add` and before the try. A turn that does not get past them gives everything back in
  `limit-gate.js:clearAwayGateWithoutTurn` (ONE place for holding, throw, error state and stop).
- **A stop during the gate await** does not park: `creditGateHolds` asks the abort marker after its await.
- **Own log and stderr lines** that reach a run must not match the limit patterns in `../limits.js`
  (`detectLimitHit`, `detectModelSwitch`) — "… limit reached" would park a run instead of failing it.
- **System prompt and cache:** nothing volatile goes into the system prompt (no time, no agenda content, no run
  history). The description side must match the execution side: a run is told only about tools it has.
- **Setters, not imports:** a setter that is left unwired silently does nothing — where that silence would be the fault
  (stopping a run that waits for an approval), a leaf with a real import is used instead (`approvals.js`).
- **Tests wait for events, not durations:** `wakeup.js:wakeupNow`, `auto-continue.js:wakeupCycles` and
  `hooks.js:observeHooks` are test seams.

## Frequent questions

- Why can a chat not be archived, and why is an archived one suddenly active again? → `archive.js:openWork` and
  `archive.js:fetchBack` (every run start in `do-run.js`).
- Why does a run not start but wait? → `limit-gate.js:gateVerdict` and `limit-gate.js:parkOrQueue`; who wakes it:
  `auto-continue.js:fireAutoContinue`. With reason `project` or `serverEnd` the lock per project holds
  (`project-lock.js`, `limit-gate.js:projectLockHolds`), woken by the instance's transition to ready.
- What happens to a second message during a run? → `queue.js:enqueueRunInput`, `takeNextRunInput` and `headerBundle`.
- Why does a channel message not go into the running turn of a scheduled run? → `state.js:inputFitsIntoTheRun`; it
  becomes a follow-up run of its own.
- Why does "steer" not start although the turn is stopped? → `queue.js:controlNow` asks again after
  `state.js:waitForRunEnd` (which returns silently after its deadline); if the old run still stands, the messages go back
  to the front of the queue.
- Who starts the queue after a compaction? → `post-run.js:compactChatContext` (finally) through `drainQueue`, never
  directly.
- Why does a subagent keep running after the turn, and how does the main agent learn that it is done? → `agents.js`
  (owner per chat) and `completionNotice.js` through `queue.js:deliverUserPrompt` (cause `agent`).
- Where does a runtime file of a chat live? → `runtime-location.js:locationFor`/`locationForChat`.
- Why does a turn run in the project container instead of the user container? → `instance.js:instanceOfChat` at the
  turn start in `do-run.js`.
- Where does the system prompt come from, and what follows the run? → `system-prompt.js:buildSystemPrompt`; then
  `post-run.js:maybeAutoTitle`, `goalGateAfterRun`, `compactChatContext`.
- Why does a resume find its session after a project's relocation? → `session-location.js:sessionForStart`,
  `session-transfer.js`.
- Which target applies, and may a continuation of the target gate still begin? → `post-run.js:targetNow` and
  `targetResumptionDropped`.
