# `outerloop/` — the outer loop (agents observe chats and write notes)

**What lives here:** the domain side of the outer loop. An outer-loop agent is its own kind of agent, managed by the human: it
observes chats (origin workspace, project or chat), is woken by triggers, reads the chat since its last FINISHED run and writes one
note per run. Three are built in per workspace (not deletable, "Reset to template"):

- the **summarizer** — only its notes appear in `cbase_agents_list`;
- the **agenda keeper** — it catches the agenda of the observed chat up when the main agent forgets it, with two fixed tools
  (`cbase_agenda`, `cbase_agenda_maintain`), only in a quiet chat, only forwards; its agenda core is `../agenda/upkeep.js`;
- the **timeline agent** — it enters what really happened in a project, with two fixed tools (`cbase_timeline`,
  `cbase_timeline_write`), only on chats of a project with the timeline switched on, and it reads a long track WITHOUT GAPS; its
  domain side is `../timeline/`.

Name in the interface: "Outer Loop".

| File | What | Called by |
|---|---|---|
| `template.js` | Leaf without imports: `SUMMARIZER_TEMPLATE`, `AGENDA_KEEPER_TEMPLATE`, `TIMELINE_TEMPLATE` (each with its own `revision`, name, job, triggers), `TIMELINE_RULE_BUNDLE`/`TIMELINE_RULE_CITATION`, `templateOf(agent)`. Whoever changes a wording counts up the `revision` of THAT template | `seed.js`, `publiclyVisible.js`, reset (`routes.js`) |
| `catalog.js` | Excerpt of the coding catalog `../toolchain/tool-catalog.js` (`OUTER_LOOP_GROUPS`, `OUTER_LOOP_CATALOG`, `OUTER_LOOP_SELECTABLE`), built-ins (`OUTER_LOOP_BUILTIN`), triggers (`TRIGGER_KINDS`, `TRIGGER_LIMITS`, `checkTrigger`), `OUTER_LOOP_FENCE_DROPPED`, `outerLoopCatalog(wid)` (response for the editor), `checkAgentBody` (the 400 check; the MCP choice refers to coding MCP servers of the workspace; the legacy area field is accepted and ignored) | routes, `set.js` |
| `activation.js` | `isTargetChat`, `areaMatches`, `available`, `effective`, `activation` (→ `{ active, source, since }`), `sinceFor`, `activeAgentsFor`, `defaultSinceNew` — pure, reads the store | routes, `trigger.js`, `run.js` |
| `seed.js` | `seedSummarizer`, `seedAgendaKeeper`, `seedTimelineAgent` and their `seedMissing…` counterparts, `agendaKeeperId(wid)`, `timelineAgentId(wid)` — idempotent | `workspaces/routes.js` POST, `server.js` at start |
| `timeline.js` | The outer-loop part of the timeline agent: `timelineBlocks` (the input blocks `<timeline-most-recent>` and `<tool-index>` via `../timeline/read.js`), `toolIndexBlock` (oldest first, cap `TOOL_INDEX_MAX`, defused), `indexRow` | `input.js` |
| `analysis.js` | The computation behind `cbase_chat_analysis`: `checkRunMarker`, `analysisHistory`/`-Search`/`-Call`/`-Notes`, `analysisResponse` — read-only | `routes.js` |
| `publiclyVisible.js` | `publicAgent` (with `chatKind` — genus of the chat for origin chat, for "Go to chat"; `null` = no target), `publicAgentShort` (row of the chat info), `publicRun`, `publicNote`, `ineffectiveReason` — ONE shape for routes and event | routes, `run.js` (event `outer_loop`) |
| `intended-end.js` | Leaf without imports: `INTENDED_END` — the codes with which the server ends a run ON PURPOSE (state aborted, the error field holds the code, not a sentence). ONE list: both clients show each code quietly with their own text; the guards `web/test/outerloop-keeper.test.mjs` and `outerloop-set-binding.test.mjs` load it directly | `abort.js`, `run.js`; web/iOS via the guards |
| `track.js` | The track of a gapless agent: `nextStage(agent, chat)` from the last run that says something about its track (error with work ⇒ +1, finished ⇒ −1), `capOnStage` (2^-stage of both caps), `STAGE_MAX` — above it `run.js` visibly skips the smallest track | `run.js`, `input.js` |
| `abort.js` | `outerLoopTurnStart({ chat })` (hook `turnStart`: a turn aborts the open runs of every agent with the switch `abortingTurn` on this chat, code `INTENDED_END.turn`), `abortOuterLoop({ agentIds, runIds, reason })` (FIRST the open rows → aborted, THEN the aborter; `runIds` = exactly these runs — deleting a project), `setOuterLoopAborter(fn)` — the seam between the delete paths and the run | agent DELETE (`routes.js`), `projectbox/erase.js`, `workspaces/routes.js` DELETE, `projectbox/idle.js` (a run in the project does NOT hold up deleting, it is aborted as soon as nothing else works; every other reason waits for it); `server.js` sets the aborter |
| `routes.js` | `outerLoopWorkspaceRoutes` (inventory with catalog, create, read, change only the sent fields, delete — built-ins 409, running runs ended via `abort.js` —, reset against the agent's OWN template, paging runs via `after=<runId>`), `outerLoopProjectRoutes` (takeover per project), `outerLoopChatRoutes` (analysis route; chat info, switch per chat, chat-owned agents, notes). An unknown body field is a 400; the chat write paths check the archive a second time AFTER the body | dispatcher |
| `set.js` | `outerLoopSet(agent, chat, { withToken })` — tool set of a run after the fence, approval and coding-server cuts (ONE computation for `tools/list`, the tool briefing and the column `item_set`; `dropped = { fence, approval, locked, genus }`, `genus` stays empty — the clients still read the field), `selectedCodingServer`, `needsProject`, `setRow`, `externalNames`, `AGENDA_KEEPER_TOOLS`, `TIMELINE_TOOLS` | `run.js`, `input.js` |
| `input.js` | `outerLoopFrame(agent, chat, set)` (system addition with the identifier line `FRAME_IDENTIFIER_LINE` and its own tool briefing; for Codex the built-ins row tells the truth about its shell), `buildInput(…)` (fenced input from the watermark `messages.id`; for the keeper also the block `<reverted>` with the corrections, at most `CORRECTIONS_MAX`, and EVERY lock of the agenda), `withoutFenceLeftovers` | `run.js` |
| `run.js` | Start of a run (gate, core, end → note, usage, parking), open cores, abort (per agent, chat or exactly these runs), start/server end; the session is in the row from the first sign of life; `wakeOuterLoopAtGate` (runs parked at the credit gate continue before the reset as soon as a newer measurement shows the gate free for every model) | `trigger.js`, `server.js` |
| `trigger.js` | Hook subscribers (run end, turn end, chat closed, restart grace; self-wake lock), quiet debouncing, tick `OUTER_LOOP_TICK_MS` (`CBASE_OUTER_LOOP_TICK_MS`, default 60 s), after-run, the aborter for `abort.js`; test seams `outerLoopTickNow`, `outerLoopQuietNow`, `outerLoopWakeParkedNow` | `server.js` |

Outside the folder but part of the outer loop: the data layer `../store/outer-loop.js` (tables and the note FTS), the cost
computation `../account/prices.js` (`costFor`, in US DOLLARS: the reported amount, else estimated at list price, a subscription
`null`) and the leaf `../communication/foreign-text.js` (`NOTE`).

**Terms:**
- **Origin** — `workspace` (neither project nor chat), project (`projectId`), `chat` (`chatId`, created in the chat info, follows
  the chat: deleted with it, rests in the archive, not copied on fork; without "default for new chats").
- **Takeover** — a workspace agent applies in a project as long as no "off" row stands there.
- **Activation** — computed, not written: row "on" OR (no row AND (origin chat OR default for new chats and the chat was created
  from `defaultNewSince` on)); only on target chats (normal coding chats), never in the archive.
- **Area** — gone from check, response and interface. Only `activation.js:areaMatches` still reads the dead column as an
  exclusion (an agent of the former "managing" area matches no chat).
- **Effective** — enabled ∧ provider ∧ model. The seeded summarizer is enabled but ineffective without a model.
- **Watermark** — `until_message_id` of the last FINISHED run on (agent, chat): the next one reads rows with `messages.id` above
  it; for the first run from `sinceFor`.
- **Triggers** — `[{ kind: "quiet", minutes: 1–1440 }, { kind: "interval", minutes: 5–10080 }, { kind: "run_end" },
  { kind: "clockTime", times: ["HH:MM", …] (1–24) }]`, each kind at most once, at least one; stored in the order of the kinds,
  clock times ascending without duplicates. A run additionally carries the after-run kind.
- **Run states** — `running` · `parked` (open) · `finished` · `aborted` · `error` (ended). The store changes only open rows: an
  aborted run does not come back to life through a late writer.
- **Ids of the built-ins** — the summarizer has the id of the workspace, the agenda keeper `<workspaceId>-a9e0da`, the timeline
  agent `<workspaceId>-71e11e` — deterministic, so the golden fixtures get no new ids. The timeline agent has no column: the
  store recognises it by its id.
- **Gapless** (only the timeline agent) — if the track is above the cap, the input reads FROM THE FRONT, `untilId` is the last
  row SEEN, every row carries its row number; a finished run with a remainder sets the after-run marker itself until the track
  is empty. Every other agent reads the most recent part.

**Rules, each from a finding:**
- **Without a choice in the backend container, flat.** A run without a choice on the project (`set.js:needsProject`) runs with
  the empty cwd AND the flat runtime folder — even on the chat of a converted project. The project's runtime folder is mounted
  rw in the project container; the CLI would read its MCP file there via the path name. Only with a choice AND an instance does
  the run take the chat's location. On a chat without a project, external servers run in the backend container.
- **External servers are coding servers through the airlock.** The MCP file of the run holds only the wrapper
  (`../../mcp/airlock.js`) with a run token of the role `outer_loop` (`../toolchain/airlock-routes.js`), never a credential of
  the real server. The airlock checks every call live against the same choice; a marked tool is missing from the set
  (`dropped.approval`), one deselected for coding at the server too (`dropped.locked`).
- **Codex has no individual built-ins.** Without a choice `../runs/agents.js` switches shell and view_image off
  (`../providers/connectors/codex.js`), plus the goal tools and `request_user_input` in EVERY Codex run; the frame NAMES what
  Codex does not let you switch off (apply_patch, rejected by the read-only sandbox, and the three MCP resource tools). WITH a
  choice the shell stays (it reads every file the process may read, not only the project) and the frame names the tools by
  their wire names instead of the selected ones. That is a limit, not a bug. Re-measure on every Codex version jump
  (the private CLI measurement scripts).
- **A clock time with nothing new is consumed.** The tick remembers up to when it has already seen the clock times; a message
  after an empty clock time waits for the next one. A clock time postponed by an open run is caught up by the next pass.
- **Runs carry `chatKind`** (like the agent), so that "Go to chat" hits the chat (`null` = no target).

**Rules of the agenda keeper:**
- **Two writers, one precedence.** The keeper STARTS only in a quiet chat (`run.js:keeperWaiting`: at the quiet trigger the clock
  rewinds, an interval consumes nothing, a clock time is postponed, and `startOuterLoopRun` checks before every row — otherwise a
  run that only failed with a 409 when writing would end finished and move the watermark), writes only in a quiet chat, only on
  the state it read (base version, else 409), and a turn aborts it (`abort.js:outerLoopTurnStart`). What the main agent reverts
  it does not repeat: a lock on the item, and the block `<reverted>` in its input against new creations.
- **Ended on purpose is not an error.** An abort at the turn and a postponement in a busy chat write a CODE from
  `intended-end.js`, not a sentence; both clients show it grey with their own text. A new intended reason goes into that list.
- **Tools only via the set.** The MCP server offers `cbase_agenda_maintain` to NOBODY without an outer-loop marker
  (`../../mcp/visibility.js`); with a marker only the run whose set carries it has it — `set.js` attaches it to the keeper alone.
  The server checks the same at the run marker (403).

**The three most frequent questions:**
- Why does an agent not run on a chat? → `activation.js:activation` — `source` says at which step it fails.
- What may an outer-loop agent select, and who rejects the rest? → `catalog.js:checkAgentBody` against `OUTER_LOOP_SELECTABLE`
  and `OUTER_LOOP_BUILTIN` — outside: 400; every run has `cbase_chat_analysis`, it is never selectable.
- What happens to running runs when an agent, project or workspace is deleted? → `abort.js:abortOuterLoop` — rows to aborted,
  then the aborter (cores silenced); afterwards `../store/outer-loop.js` or the delete lists in `../store/workspaces.js` take
  the rows. A chat goes through the close path (`../chats/erase.js`; sessions of the runs via `../chats/sessions.js`).

**What does NOT live here:** sending from a run (`../communication/target-outer-loop.js`), the notes in the list of
`cbase_agents_list` (`../communication/read.js`), the core of a run (`../runs/agents.js`), the MCP tool
(`../../mcp/tools/outerloop.js`), the fence row of the analysis route (`../projectbox/fence-table.js`) and idling
(`../runs/routes.js` reads the runs from the store — `runs/` never imports this folder, guard
`server/backend/test/import-direction.test.js`).

**Guards:** `server/backend/test/outerloop-agenda-keeper.test.js`, `outerloop-routes.test.js` (every route via the real server),
`outerloop-run.test.js` (run via the real core), `outerloop-codex.test.js`, `outerloop-trigger.test.js`, `outerloop-idle.test.js`,
`outerloop-data.test.js`, `outerloop-analysis.test.js`, `outerloop-track.test.js`, `closePath.test.js` (every delete path of a chat
takes the outer loop with it), `schema-register.test.js`.
