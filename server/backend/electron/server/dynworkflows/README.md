# dynworkflows/ — dynamic workflows

An agent writes an orchestration script in the script language of Claude Code's workflow tool — **1:1**: a script that
runs there runs here unchanged — and cbase runs it outside the turn. Every `agent()` can run a model of ANY provider
(`provider::model`). This folder holds: the script language (check, sandbox), the run with journal and resume, opt-in and
approval card, the workflow agents (model, frame, toolset, worktree, agentType), StructuredOutput, concurrency, the
budget "+500k", the size guideline, parking at the limit, the library with `workflow(name)`, the progress tree with
skip/restart, messages to workflow agents and the ultracode reminders.

## Files

| File | What |
|---|---|
| `script.js` | Read a script BEFORE it runs: `checkScript(text)` → `{ meta, body }` (V8 syntax check of the whole text, `meta` as a pure literal through the shipped TypeScript parser, static prohibitions `with`/`import()`/`await using`), `checkBody`, `MetaError`/`ScriptError`. |
| `sandbox.js` | `startScript({ script \| body, args, budget, host })` → `{ meta, end, abort, quiet }`: the `vm` context INSIDE the backend process with the baseline's wrappers, `workflow()` as a sub-step, the time limit per section and the catcher for unhandled rejections. Wordings and caps as exports (`AGENT_CAP`, `LIST_CAP`, `SYNC_DEADLINE_MS`, `sectionDeadline`, `CLOCK_TEXT`, `RANDOM_TEXT`, `AGENT_CAP_TEXT`, `NESTED_TEXT`, `unknownWorkflowText`, `DELETED_GLOBALS`). LANES: `parallel()`/`pipeline()` report their fork to the host synchronously at the call (`host.fork(lane, variety)` → `{ slot(i), connect() }`), every thunk or item runs in its slot, and `host.agent(call, lane)` gets the caller's lane — tracked by one `AsyncLocalStorage` per run across the vm boundary (only when the host forks; `withoutLane()` is the measuring point). |
| `run.js` | The run: `startDynWorkflow` (tool, opt-in, card or start), `savedWorkflow`, `stopDynWorkflow`, `skipDynAgent`/`restartDynAgent`, `decideApproval`, `dynTree`/`dynTrees`, the hooks `dynWorkflowsChatClosed`, `dynWorkflowsOpen`, `dynWorkflowsAtStart`, `dynWorkflowsAtServerEnd`, `dynWorkflowsRestartGrace` (`DYN_RESUME_CAP` = 2), `interruptIfServerEnds` (the run freezes at the first touch with the server's OWN end, its core stays open until `close`); start and end marker (`MARKER_ROLE`), the global event (`GLOBAL_EVENT`), completion notice and output file. |
| `journal.js` | The key chain `v2:` (`key`, `chainOptions` = the baseline's calculation, `normOptions` = cbase addition) in TWO chain kinds: "branches" (`CHAIN_KIND_NEW`: `branchKey` for fork/slot/join, `replacedKey`) and "linear" (the fallback for old journals); `chainKindOf` (the ONE place for "missing ⇒ linear"), `ChainKindError`; `createChain` → `{ kind, further, fork }` (resume prefix; with substitute options a call also hits under the key of a retired predecessor of its model, `../providers/retired.js:predecessorOf`), `createPlayback` (cache hits in the old completion order), `servedFromTheJournal` (the same calculation as a prediction over `n`, for the tree), `newRunId`/`newTaskId`, `RUN_ID_PATTERN` `^wf_[a-z0-9-]{6,}$`. A leaf (only `node:crypto`). |
| `model.js` | `resolveAgentModel(raw, chat)`: the resolver of its OWN for `agent({model})` — Claude aliases (`CLAUDE_ALIASES`) always mean Claude, `provider::model`, unique catalog id; unknown ⇒ `ModelError` with the selection, before anything starts. |
| `frame.js` | The frame of a workflow agent: system addition `WORKFLOW_AGENT_FRAME` ("your last text is literally the return value"), provenance frame `framedJob` (computed job, relay of the human request up to `RELAIS_MAX` 4000 characters), `sanitizeResult` (invisible characters, tag and frame patterns). A leaf. Pin-sync "workflow-agent-frame". |
| `approval.js` | Opt-in and approval card: `carriesKeyword` (detector for "ultracode" like the binary), `keywordInTurn`, `graphStep`, `nodeOpens`, `createCard`/`readCard`/`openCard`/`readJob`/`writeRuling`; roles `workflow_approval` and `workflow_approval_ruling`. Pin-sync "workflow-keyword". |
| `structured.js` | StructuredOutput: `checkSchema` (before the start), `openOutput` (reference per `agent()`), `takeOutput` (ajv check on the messenger's way back), `FOLLOW_UP`, `FAILED_ATTEMPTS_MAX` = 5, `withoutResultText`. A leaf except for ajv and the name leaf of the MCP tree. |
| `cap.js` | Concurrency: `runCap()` (default `RUN_CAP_DEFAULT` = 8), `userCap()`/`setUserCap(n)`, `runSlots(runId)` (slots under both caps and at the storage gate, ONE queue), `storageCandidates()` (the source "dyn-workflows" of the arbiter `../workflows/storage-queue.js`), `createStagger()` (prompt-cache staggering), `capStatus()`. A leaf except for `store.js` and the two leaves of the storage gate. |
| `budget.js` | Budget "+500k": `budgetFromText`, `budgetInTurn`, `budgetOfTheTurn` → `{ total, turnId }`, `potFor` → `{ total, consumed(), book(n) }`. Reads only `runs/human-input.js` and `runs/turn-output.js`. |
| `size.js` | Size guideline and size warning: `SIZES`, `size()`/`setSize`, `sizeForMcp()`, `sizesWarning`. A leaf except for `store.js`. |
| `parking.js` | Parking per provider: `createProviderPark()` (who of which provider parks, `atGate`, `atProject`), `wakeGateWaiting()` (called from `PUT /api/credit-gate` and `gate-wakeup.js`), `gateWaitingCount`, `wakeProjectWaiting()` (called from `projectbox/idle.js:wakeProject` at the transition to `ready`), `projectWaitingCount`. A leaf without imports; the wakeup comes from the caller. |
| `gate-wakeup.js` | `wakeGateWaitingIfFree()`: wakes the workflow agents waiting at the gate as soon as a NEWER measurement shows the gate free for every model (`runs/limit-gate.js:gateFreeForAllByMeasurement`, no network call) — called on the sweeper's tick (`server.js`); one measurement wakes at most once. |
| `tree.js` | The view of the progress tree: `treeView({ run, journal, events, live, cap })`, `agentState` (finished · error · skipped · stopped · running · waiting · without-result; read from the last `launched` of an `n`), `TREE_EVENT` = `dynwf_tree`, `LOG_CAP` 200, `RUNS_CAP` 20. Pure; only import the leaf `journal.js`. |
| `reminder.js` | Ultracode reminders and guide: `ultracodePreamble` (connected through `runs/do-run.js setTurnPreamble`), `reminderStep` (full · tight every `REMINDER_TICK` 10 user turns · off; full again when the turn is not resumed), `reminderBlock`, `guideText`, `reminderChatClosed`. Pin-sync "ultracode-reminder". |
| `guide.md` | The cbase revision of the authoring guide (skill "workflow-authoring"); travels with the full reminder and with the keyword. Pin-sync "cbase-guide". `dynworkflows-reminder.test.js` runs every ```javascript example through the sandbox. |
| `names.js` | Which names a saved workflow may carry: `RESERVED_NAMES` (the clients' local slash commands — a copy, bound in `web/test/list-binding.test.mjs` — and the CLI's `workflows`), `nameForbidden`. A leaf without imports. |
| `slash.js` | `/name <rest>` (a refusal): `slashCall(text)`, `dynSlashRefusal(chat, text)` — called at the message route BEFORE the spawn; if the name hits a saved workflow of the chat ⇒ 404 `dyn_slash`. |
| `routes.js` | The routes (three families, see below) and `save` (library: meta check, name rules, never overwrite). |
| `message.js` | Messages to the agents of a RUNNING workflow: `workflowTarget(chatId, address)` (run address `wf:<runId>:<n>`, agentId and unique label as alias — `workflowAliasHits`), `messageToAgent(run, n, text, from)` by the state table (running ⇒ `ctl.control`, "delivered" or for Codex "after_turn"; waiting ⇒ `e.earmarked`, as a fenced block on the job, `jobWithMessages`; parked ⇒ on the continuation's input; finished ⇒ 409), journal kind `message` and transcript kind `message` (ONE row, later possibly "not_delivered" with a reason), the hooks for `run.js` (`messagesFromJournal`, `deliverAfterStart`, `earmarkParked`, `reportUndelivered`, `reportLeftBehind`) and `workflowAgentsList` (overview of `cbase_agents_list`). Does NOT import `run.js` — `run.js` registers with `setRunAccess` (no cycle). Who may write is decided by `communication/target-wf.js`. |

## Routes

Everything under `/api/chats/:id/` goes through the sub-table `chats/routes.js:chatRoutes` (archive write lock in front):

| Route | Caller | What |
|---|---|---|
| `GET` / `POST /dyn-workflows` | `cbase_dynamic_workflow_list` / `_save` | those effective in the chat (project chat: only those taken over) / store a script (from a project chat it is taken over there at the same time) |
| `POST /dyn-workflows/run` | `cbase_dynamic_workflow` | start (201), card (202), errors 400/404/409; `los()` only AFTER the answer |
| `POST /dyn-workflows/stop` | `cbase_dynamic_workflow_stop` | stop by the agent (task id or run id) |
| `POST /dyn-workflows/approval` | card in web/iOS | `{ requestId, decision: "accept"\|"reject" }`, both required; 409 for a decided card and in the archive |
| `POST /dyn-workflows/structured-output` | messenger `StructuredOutput` | `{ reference, object }` → ajv verdict |
| `GET /dyn-workflows/tree` | web/iOS | the newest runs as a view (`{ runs, additional }`) |
| `GET /dyn-workflows/runs/:runId/agents/:n` | click on an agent row | the transcript of the `n`-th `agent()` |
| `POST /dyn-workflows/runs/:runId/stop` | stop at the tree's header | stop by the human — allowed in the archive (`archiveAllowed`) |
| `POST /dyn-workflows/runs/:runId/agents/:n/skip` · `…/restart` | actions on an agent row | locked in the archive |

Plus `dynWorkflowWorkspaceRoutes` (`workspaces/routes.js`): `GET /api/workspaces/:wid/dyn-workflows`, `GET`/`DELETE
/api/workspaces/:wid/dyn-workflows/:id` (list, view with script, delete); `dynWorkflowProjectRoutes`
(`projects/routes.js:projectRoutes`): `GET /api/projects/:pid/workspace-dyn-workflows` (with `enabled`), `PATCH
…/workspace-dyn-workflows/:name/enabled` (`enabled` required and a boolean). Outside this folder: `GET`/`PUT
/api/dyn-workflow-cap` and `GET`/`PUT /api/dyn-workflow-size` (`settings/routes.js`), `/message` with `/name`
(`runs/routes.js` → `slash.js`; answer 404 `dyn_slash`, no start), the field `dynWorkflows` in `/api/runs/active` (read
from `store/dynworkflow-runs.js`, never through this folder).

## Tools, tables, hooks, events

- **Tools** (`../../mcp/tools/dynworkflows.js`): `cbase_dynamic_workflow` (inputs `script` · `scriptPath` · `name` ·
  `args` · `resumeFromRunId`; precedence `scriptPath` > `script` > `name`; a script file in the runtime folder of a
  relocated project is read by `runs/runtime-limit.js:readInRuntimeFolder` through the checked descriptor — a symlink
  to the outside is "not readable: EOUTSIDE"; likewise `workflow({scriptPath})`), `_stop`, `_list`, `_save`, plus the
  messenger `StructuredOutput` (only with `CBASE_SCHEMA`). In the toolset of every coding chat and every graph step,
  ALWAYS; never for subagents (`mcp/visibility.js alwaysLocked`) and workflow agents (marker `CBASE_WORKFLOW_AGENT`,
  `lockedForWorkflowAgent`). The description names the opt-in ways and the size guideline (`sizesSet`); the guard
  `mcp-schema.test.js` binds the opt-in condition from `run.js` check by check to the description. For a chat in a COPY
  the start reads the script ahead through the copy's file access (`run.js:readAloudCopy`) — never from the main
  instance (`runs/runtime-limit.js:readInTheInstance`).
- **Tables**: `store/dynworkflows.js` — `dyn_workflows`, `project_dyn_workflow_enabled`;
  `store/dynworkflow-runs.js` — `dyn_workflow_runs` (status running · finished · failed · stopped · interrupted,
  `stopped_of`, `args`, `attempts`, `resume_of`, `budget_total`/`budget_consumed`, `attempt_from_journal`/
  `attempt_from_event` — the boundary of the running attempt, set by `pickUpDynRun` — and `end_ordered` — the latest
  interruption was an ordered server end and does not count as an attempt), `dyn_workflow_journal` (with `phase`),
  `dyn_workflow_agent_history` (transcript per agent), `dyn_workflow_events` (phase/log/failures/warning),
  `dyn_workflow_agent_todos` (legacy: DDL and deletion with the chat remain, nothing reads or writes it);
  `store/ultracode-reminder.js` — `ultracode_reminder`.
- **Hooks in `server.js`** (runs/ does not import this folder, except `runs/routes.js` → `slash.js`, the printed
  exception of the hub guard): hook "chatClosed" → `dynWorkflowsChatClosed` (every delete path), restart hook →
  `dynWorkflowsRestartGrace`, `setBackgroundSource(dynWorkflowsOpen)` (the second source of the ONE query
  `runs/background.js` — archive lock, end of work, holding of a graph step), `setTurnPreamble(ultracodePreamble)`; at
  start `dynWorkflowsAtStart`, at `server.close` `dynWorkflowsAtServerEnd`. `run.js` itself reads `runs/do-run.js
  agentContextWithoutTurn`, `runs/agents.js openAgents`, `runs/queue.js deliverUserPrompt`, `runs/hints.js`,
  `runs/background.js backgroundEnds`.
- **Events**: in the chat's stream (`harness`) `workflow_marker` (`{ phase: "start"|"end", runId, taskId, name,
  status?, at }`, end status finished · stopped · failed · interrupted), `workflow_approval` /
  `workflow_approval_decided`, `dynwf_tree` (the WHOLE view per run, bundled into one report per tick); globally on
  `/api/events` `dyn_workflow` (`{ chatId, runId, open }`, start and end — the pill "Active runs" reloads on it).

## Terms and semantics of the script language

- **Wrappers**: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`, plus `console` (every
  line a log, `error`/`warn` with a prefix) and `setTimeout`/`clearTimeout` as in the baseline.
- **Host**: `host.agent({ n, prompt, opts, phase, workflow? }, lane)` (`lane`: what the fork's `slot(i)` returned,
  `null` in the root and without `host.fork`) answers with a value, with `null` (skipped/failed — the script sees
  `null`) or rejects (the script sees an error); `host.workflow({ name } | { scriptPath })` → `{ script, name? }`;
  `host.event` gets `phase`, `log`, `failure` in script order. Every `agent()` reports SYNCHRONOUSLY before the script
  awaits for the first time: the order at the host is call order, not completion order (the key chain builds on that).
  Equally synchronous: `host.fork(lane, variety)` at the call of `parallel()`/`pipeline()` (optional; `run.js` only
  passes it in chain kind "branches").
- **Boundary**: only strings and numbers cross it; answers and `args` are built from JSON INSIDE the context.
- **`parallel`** is a barrier and never rejects because of a branch (branch → `null` plus failure `parallel[i]
  failed: …`); **`pipeline`** has NO barrier, `null` ends an item's chain; both tick once (`setTimeout 0`) before they
  touch their entries.
- **`agent(prompt, opts)`**: `model` (see `model.js`), `effort` (per agent, clamped to ITS model; unknown ⇒ throw),
  `schema` (StructuredOutput), `agentType` (the same list as `cbase_agent`, ignoring case; unknown ⇒ throw with the
  list; the spelling `subagent_type` counts too; without `model` the definition's model applies), `isolation`/`repo`
  (worktree; ambiguous ⇒ throw before any process), `label`, `phase`. Model, effort, schema and type throw BEFORE
  journal or process exist.
- **`workflow(name | {scriptPath}, args)`**: a saved workflow (the chat's effective view, looked up fresh) or a script
  file as a sub-step, in the same context with cap, counter, budget and abort of the parent run; ONE level
  (`workflow()` in the child throws `NESTED_TEXT`). An `agent()` from the child is in the parent run's journal with the
  field `workflow`.
- **Caps and prohibitions** (wordings from the binary of the pinned version): 1000 `agent()` per run, 4096 entries per
  list across the boundary, 30 s for the synchronous part; `Date.now()`, `new Date()`, `Date()`, `Math.random()` throw
  (they would break resume), no code generation from strings, `WeakRef`, `SharedArrayBuffer` & co. deleted — and
  `Temporal`. A script has at most 524,288 characters (`script.maxLength` of the baseline).

## The run

- **Place**: outside the turn, modelled on the graph driver. The tool returns at once (task id `w…`, run id `wf_…`,
  script path `<data>/outputs/<chatId>/workflows/<runId>/script.js`), the chat is free; at the end the output file
  `result.json` lies next to it (return value, failures, events, journal, changed worktrees), and the completion
  notice (`<task-notification>`, `<name>` = workflow name, `<summary>Workflow "…" completed|failed`) arrives through
  the ONE wake path (`deliverUserPrompt`, cause "agent").
- **A core of its own per run** (`openAgents(…, { own: true, workflowAgent: true, frame, sink, deposit })`): not the
  chat's core — `/stop`, `/agent/stop`, `/agents/stop`, idle clean-up, inventory and the cap of 20 subagents do not
  reach it. Before every start the credit gate; consumption is booked per agent at once.
- **Workflow agent**: the chat's toolset 1:1 (browser included) MINUS `cbase_agent*`, `cbase_dynamic_workflow*`,
  `cbase_monitor*`, `cbase_ask`, `cbase_wakeup` (`runs/agent-set.js workflowAgentSet`); a definition (`agentType`)
  brings role and tool list ∩ toolset and — without `model` in the call — its model. Approval requests are rejected
  without a card (`WORKFLOW_AGENT_REJECTION`). Transcript through the sink into `dyn_workflow_agent_history` (call
  block `dynwf:<runId>:<n>`), in the chat only the two markers. Stall: 180 s without progress ⇒ restart, up to 5
  (`providers/agent-runtime.js workflowStallRule`).
- **Result**: without a schema the last text through `sanitizeResult`; with a schema the ajv-checked object. Agents
  the script did not wait for run to their end at the host after an `ok` end and are counted; their answer no longer
  reaches the script (see residual risk). Changed worktrees stay in place and appear in journal, completion notice and
  output file (`worktrees`) — never silently deleted.
- **Safety net**: `run.js:runFailed` — a throw after the script's end (database, output file, delivery) ends "failed"
  AND delivers exactly ONE completion notice "failed" (never after stop, deletion, server end).

## Journal, key chain, resume

- **Entries** (`dyn_workflow_journal`, per `agent()` with `n` and `phase`): `launched` (prompt, options, resolved
  provider/model/effort, `workflow` from a child, `chain` — the run's chain kind; if MISSING it was the linear one) ·
  `started` (`agentId`, `resumed` after a park) · `result` (`value`, `fromCache`, `worktree`, `tokens`/`tokenKind`, in
  kind "branches" possibly `replaced: <agentId>`) · `failed` (`error`, marker `skipped` only through the action) ·
  `waiting` with `reason` `cap` (+ `cap: "run"|"user"`) · `stagger` · `storage` (+ `situation`) · `limit` (+ `image`
  of the parked agent) · `credit-gate` (+ `percent`, `window`, `until`) · `project` (+ `state` of the instance) ·
  `restart` with `from: "human"` (does not count for the prefix; the stall restart writes none) · `message`.
  `phase()`/`log()`/failures/size warning live separately in `dyn_workflow_events`.
- **Key** as in Claude Code: `v2:` + sha256(state of the lane ‖ `\0` ‖ prompt ‖ `\0` ‖ normalised options) with schema,
  model, effort, isolation, agentType, disallowedTools, bashCommandClamp (recursively sorted; the two lists without
  duplicates and sorted; label and phase not) — checked against a real Claude Code journal
  (`fixtures/dynworkflows-journal/<pin>/`). cbase addition before that: `model` = the RESOLVED `provider::model`, plus
  `repo`. `disallowedTools`/`bashCommandClamp` are ONLY in the key: cbase's `agent()` cuts nothing with them.
- **Two chain kinds** (the calculation is spelled out in the header of `journal.js`). **"branches"** (every new run):
  every lane carries its state; `parallel()`/`pipeline()` fork the lane they are called in — synchronously at the
  call: the lane moves to `fork`, every thunk or pipeline item (across all stages) begins on `slot:i` of the state
  BEFORE the fork, and after all slots ended the lane moves to `join` over the slots' states. A branch's keys thus no
  longer depend on which neighbour finished first. Plus **"replaced"**: if an agent() runs LIVE at a resume although
  its key already had an end in the old journal, the lane continues behind its result on sha256(key ‖ `\0replaced\0`
  ‖ agentId) — everything behind gets new keys; the result carries `replaced: <agentId>`, and a hit on it takes the
  same detour (deviation: the baseline derives "replaced" from the order of its ONE journal; cbase writes it onto the
  result because `resumeFromRunId` begins a new journal here). **"linear"**: ONE chain across all agent() in call
  order, the old five options — the FALLBACK: a journal whose `launched` carry no `chain` resumes linearly and keeps
  writing linearly (the LAST `launched` of the predecessor wins; without any `launched` the new kind). No mixed
  chains. An unknown kind (journal of a newer server) does not resume (`ChainKindError`). A server from before the
  change reads a "branches" journal without crashing but computes linearly: only the agent() BEFORE the first
  `parallel()`/`pipeline()` hit. Without `parallel()`/`pipeline()` both kinds compute the same keys.
- **Prefix rule**: the longest unchanged prefix comes from the cache (only "finished with a result") — ONE prefix
  across all lanes in call order; an agent that only started does not break it (runs anew), a failed or skipped one
  breaks it, as does a new or changed call, and in kind "branches" also a result whose agent was started once more
  afterwards. Hits go back in the old completion order (`createPlayback`). Deviation from the baseline: cbase's
  `launched` (at the call) counts like `started` — an agent that was still waiting for a slot at the abort does not
  break the prefix.
- **Restart (the normal case)**: a deploy does not wait. At the server end every run becomes "interrupted" (end
  marker), after a crash at the next start (`dynWorkflowsAtStart`, without a marker). The restart hook resumes THE SAME
  run (run id, task id, journal, script file, `args`, budget base); finished agents from the cache, interrupted ones
  anew, those parked at the limit are picked up parked (not with a schema — the reference belongs to the old server
  run). A pick-up counts `attempts` only after an end that was NOT ordered (crash, throwing continuation); an ordered
  server end does not count and does not give up — otherwise every deploy would cost an attempt. After a crash at the
  cap `DYN_RESUME_CAP` (2) the run is given up (failed, end marker, completion notice "failed" after the hook). A
  throwing continuation becomes an error row (role `hint`). The core's instance is the one of the start, pinned to
  the run (`instance_identifier`); an instance that no longer exists throws at the next `agent()` (never a start in
  the main instance).
- **The server end without a race**: `dynWorkflowsAtServerEnd` only runs at `server.close` — before it lies the
  "serverEnd" chain (up to 45 s, among it `docker stop -t 30` of every project container). So a run freezes at the
  FIRST touch with the server's own end (`run.js:interruptIfServerEnds`: at an agent's end in the core's callback,
  BEFORE script and messages; on entering `agent()`; after every wait for a slot; at a failing start): row
  "interrupted" (ordered), end marker, script aborted, `serverEnd` — no `failed` (the prefix stays), no log(), no
  message "not_delivered", no new agent. The question is `runs/server-end.js:ownServerEnd()`, NOT the gateway's
  foreign marker (freezing cannot be undone in a process that lives on). Freezing does not close the CORE: running
  agents keep working until `close`; whoever ends WITH a result within the window is in the journal and comes from the
  cache at the restart. Guards: `dynworkflows-server-end.test.js`, `dynworkflows-resume.test.js`.
- **The boundary of the running attempt**: a restart continues THE SAME journal, the entries of all attempts follow
  one another. `pickUpDynRun` records in the same UPDATE how many journal and event rows precede it
  (`attempt_from_journal`/`attempt_from_event`; on the run `attemptFrom`). A column on the run instead of a journal kind:
  the journal keeps the baseline's shape. Read only by the tree.
- **`resumeFromRunId`** (tool): a NEW run against the old one's journal, only a run of this chat (otherwise 404), a
  running one has to be stopped first (409); without `script`/`scriptPath`/`name` the old one's script, without
  `args` its `args`; an interrupted predecessor is thereby superseded. Through the card: if the predecessor is
  running when accepting, the card stays open (409); if it is gone, the workflow starts from the top.

## Opt-in and approval card

A start runs freely when (a) the chat is in ultracode mode — in a graph run also through its run settings —, (b) the
human input of THIS turn carries "ultracode" (only the ONE reading `runs/human-input.js`; channel, schedule, event,
completion notice never count), or (c) the node text of the graph step the chat stands at carries the word
(`nodeOpens`, the same detector). Otherwise: the **approval card** (name, description, phases from `meta`), the tool
answers 202, nothing runs. The job (script, `args`, call block, request, predecessor, budget) lies in
`<outputs>/workflows/approvals/<requestId>.json` (read and removed through `runs/outputs.js:workflowFileToRead`, hence
also at the old location of a deferred project switch — otherwise 410). Accepting starts and deposits a silent hint
(source "dynworkflow-approval"); rejecting reports it as a system message (cause "agent"). Every card is decided
exactly once (409). A graph step may start and holds until ITS workflow has finished and its completion notice has
been processed in the step (`dynWorkflowsOpen` → `step`), or at ITS card like at a question (`workflows/gates.js`). A
card created in a graph step carries `graph: { runId, step }`, and `openCard` only reads the cards of the step the
chat stands at now — a card from an ordinary turn, an aborted run or a fork holds no step.

## Stop, skip, restart, message

- **Agent** through `cbase_dynamic_workflow_stop`: run and agents end, end marker "stopped", no notice (baseline).
- **Human** through `POST …/runs/:runId/stop`: the same, plus a SILENT hint (source "dynworkflow-stop") for the next
  turn, without waking. `stoppedOf` is in the row; end and stop crossing ⇒ exactly one arrives.
- **Deleting the chat** (hook "chatClosed"): stop silently, delete rows and reminder state — before that the changed
  worktrees of the workflow agents from the journal, ONLY in the runtime folder of a relocated project
  (`runs/agents.js:cleanUpWorktreesInRuntimeFolder`; the branch stays). **`/stop`** lets the workflow run.
  **Archiving** is locked while one runs (`runs/archive.js`, reason "dynworkflow").
- **Skip**: `ctl.stop(agentId, { ofHuman: true })` — `agent()` yields `null` ("returned null — skipped by the user"),
  journal `failed` + `skipped`, no hint, the run keeps running. **Restart**: the same turn with the same input anew
  (the same path as the stall restart), only in the middle of an attempt. 409 reasons: `run-closed`, `agent-closed`,
  `not-started` (still waiting to start), `running-not` (restart of a parked agent or between two turns). There is no
  "stop per agent".
- **Message** (`message.js`): `POST /api/chats/:id/agent/send` with `to: "wf:<runId>:<n>"` — from the main agent
  (`cbase_agent_send`) or from the human. No return channel. A restart (human or stall) appends what was delivered to
  the killed attempt to the new one's input; a server restart appends the agent's messages from the journal to the new
  job. StructuredOutput: after a message the NEWEST valid object counts. Fenced on EVERY path. Between the server end
  and the moment the script reaches agent(n) again after the restart, the address answers 409 "restarting" —
  "finished" only for `result`/`failed` as the last state in the journal (or a value from the cache). If the start
  throws, the messages passed along go back and become "not_delivered".

## Concurrency: two caps, the storage gate and the state "waiting"

A run may carry up to 1000 `agent()`; at any time only as many run as the two caps allow and memory permits.

- **Cap per run** = **8**, fixed (`RUN_CAP_DEFAULT`); the knob `CBASE_DYNWF_RUN_CAP` overrides the default.
- **Cap per user** across ALL workflows of this server: setting `dyn_workflow_user_cap`, default 8, `GET`/`PUT
  /api/dyn-workflow-cap` (without `cap` ⇒ 400, whole number 1–64).
- **"waiting"**: whoever gets no slot is in the journal with `reason: "cap"` and starts as soon as a slot frees up —
  ONE queue across all runs, first in first out; an entry held only by ITS run cap does not hold up other runs. The
  key chain is fixed at the call, not at the start. Further reasons: `storage`, `stagger`, `limit`, `credit-gate`,
  `project`.
- **Storage gate**: before a waiting call gets a free slot, `cap.js` asks `workflows/storage-gate.js:storageSituation`
  at most once per pass — closed above 80 % of the container limit (measured as `memory.current − inactive_file`) or
  below 20 % free on the host; always open on a Mac without cgroup and meminfo. Closed ⇒ "waiting" with `reason:
  "storage"` and `situation`, and nobody behind it starts (FIFO). Storage waiters are released ONLY by the shared
  arbiter `workflows/storage-queue.js` (source "dyn-workflows"), at most ONE per pass across graph starts, copies,
  detection, setup, instance starts and workflow agents together. It is woken by the tick (`CBASE_GRAPH_TICK_MS`,
  default 30 s) and at the end of every workflow agent. A slot without a new process (a parked agent continues) does
  not ask the gate. RESIDUAL RISK: agents that get a slot in the same pass see the same measurement. Guards:
  `dynworkflows-save-gate.test.js`, `dynworkflows-cap.test.js`.
- **Staggering**: agents of the same prefix (provider, model, agent type) start after the first event of the first,
  at the latest after 5 s — only with `caps.prefixCache`.
- **Not the cap of 20** subagents per chat: workflow agents live in their own core (not counted there).

## Parking at the limit

Parking happens at journal level, never in the chat's wait row (`pending_resume` is one row per chat). An agent at the
usage limit parks through the per-agent park mechanism; `parking.js` only remembers which provider parks — while one
parks, the run starts no new agent of THAT provider (`waiting`/`limit`), others keep running. If the credit gate
stands for the provider (≥ 99 %, Claude only), the agent waits until the reset or until the human switches the gate
off (`waiting`/`credit-gate`, `wakeGateWaiting`). With auto-continue off nothing parks: `agent()` yields `null`, and
`log()` names the agent.

If the project's instance is busy (start, creation, recreation) or the server ends in a relocated project, the start
gate answers with the verdict of the per-project lock — asked under the project of the CORE (pinned when it opened):
`slotTake` parks the agent (`waiting`/`project` with `state`, `park.atProject`) — not tied to auto-continue, no
attempt consumed. It is woken at the transition to `ready` (`wakeProjectWaiting`), at the latest after the fallback
check (`runs/project-lock.js:projectCheckBackMs`). During a relocation the lock rejects: then the start gate applies
like any other refusal.

## StructuredOutput

`checkSchema` before the start (root `object` with `properties`, `required` ⊆ `properties`, ajv compiles;
unsatisfiable ⇒ throw, no process) → `openOutput` (reference) → schema and reference through the environment
(`CBASE_SCHEMA`, `CBASE_SCHEMA_REFERENCE`) to the agent's MCP server, only then the messenger `StructuredOutput`
appears (input schema = the schema) → `POST …/structured-output` → `takeOutput` checks with ajv, an invalid object goes
back as an error tool result → if the turn ends without a valid call, the run follows up ONCE (`FOLLOW_UP`) → after 5
failed attempts or an unsuccessful follow-up `null` plus `log()`. The native flags (`--json-schema`,
`--output-schema`) are not used; the same path for Claude, Codex and the loop engine (there the follow-up is the
normal case).

## Budget "+500k"

If the human writes "+500k" in their message, the turn gets a HARD upper bound for output tokens — shared by the main
run and all dynamic workflows this turn starts. In the script: `budget.total` (null without a statement),
`budget.spent()`, `budget.remaining()`.

- **Detection** (`budget.js`): ONLY the ONE reading of the turn's human input; channel, schedule, event and completion
  notice never set one. Spellings: "+500k" as a word of its own and "use 2M tokens"/"spend 500k tokens". Several
  statements: the last wins. Through the approval card the budget travels along in the job.
- **Counting**: one pot per turn = output of the main run in this turn (`runs/turn-output.js`) + output of every
  workflow agent of all runs of this turn, booked at its END (`run.js bookAgent`) + at a restart the last booked state
  as the base. Codex and the loop engine report a lower bound; it counts anyway.
- **Dropping** (`sandbox.js`, 1:1 the baseline): from `spent() ≥ total` on every further `agent()` throws
  (`WorkflowBudgetExceededError`), also `parallel`/`pipeline` on entry; running agents run to their end. A slot in
  `parallel`/`pipeline` that still wanted an agent afterwards becomes `null`, with the note "parallel: N slot(s)
  dropped — token budget exceeded" as a failure.

## Size guideline and size warning

- **Guideline**: small · medium · large · unrestricted, default medium, setting `dyn_workflow_size`, `GET`/`PUT
  /api/dyn-workflow-size` (without `size` or unknown ⇒ 400). The model gets it as a HINT at the end of the description
  of `cbase_dynamic_workflow` (under 5 · 10 · 50 agents, unrestricted without a guideline) — NOT in the system prompt;
  passed as `CBASE_DYNWF_SIZE`, only for the main agent and only when it differs from the default.
- **Warning**: once per run, event "warning", never in ultracode mode. Fires at `scheduled > 25` or `tokens >
  1,500,000` or `projected > 1,500,000`, checked at every `agent()` call and every agent end.
- **Projection**: `projected = max(tokens, round(cut × scheduled))`, `cut = tokens / finished` (70,000 while none has
  finished). Deviation from the baseline: it divides by the ENDED agents, and the threshold 25 applies regardless of
  the guideline.

## Library and `/name`

Per workspace in the database, the script BYTE-EQUAL, `meta` read with the same parser that reads a script before the
run. Takeover per project like skills; saved from a project chat means: stored in the workspace AND taken over there.
Never overwrite (409). Rejected (400): names that do not work as `/name` (`form`), the reserved ones (`names.js`) and
names a skill in the workspace already carries. `/name <rest>` is checked by the SERVER before the spawn (`slash.js`):
`text` is read, not the display; only in a coding chat (no run kind). A hit answers 404 `dyn_slash` — nothing reaches
the CLI, no run starts, nothing is queued. A saved workflow starts from the library or from the model
(`cbase_dynamic_workflow` with `name`). Guard `dynworkflows-slash.test.js`.

## Progress tree

Route and event build with THE SAME function (`tree.js treeView` from row, journal, events and the core's live
state), so after a reload the tree shows what it showed live. Per agent ONE state word; the client computes the display
word through the bound table (web `lib/history-state.ts`, iOS `HistoryState.journalAgent`), and grouping, n/m and the
buttons per row through its tree calculation (web `lib/dyn-tree.ts`, iOS `Chat/DynTree.swift`, bound in
`web/test/dyn-tree-binding.test.mjs`). A chat shows the newest 20 runs (`additional` counts the rest), a header the
newest 200 `log()` lines (`logsTruncated`).

- **Time per agent**: `startedAt` = the FIRST `started` in the shown attempt (not `launched` — waiting for a slot lies
  in between), `endedAt` = the `result`/`failed`. Without `started` there is no `startedAt`. The client computes the
  duration.
- **The wait reason**: the RUNNING run carries `cap: { run, user }` (the numbers in effect now); a waiting agent
  carries `reason` and, for "cap", the kind from the journal. The client computes the text ONCE (web `waitText`/
  `bandWaitText`, iOS likewise, bound). Residual risk: the kind is the one at queueing time.
- **Across a restart** the view shows the RUNNING attempt (boundary `run.attemptFrom`): an agent it (re)started with
  its entries from THIS `launched` on; an agent before it only if the restart serves its result from the journal
  (`journal.js:servedFromTheJournal`); every other agent of an earlier attempt is missing until the script reaches it
  again. phase()/log() only of the running attempt; the output file carries everything. `store.dynRunStatus` (phase
  and n/m for `/api/runs/active`) does NOT compute like this: it keeps counting across all attempts.

## Ultracode reminders

At every user turn (human input, `humanFrom`) `ultracodePreamble` asks what the model last learned about the mode:
mode on and not reported ⇒ the FULL reminder with the guide, still on ⇒ the TIGHT one every 10 user turns, off after
"on" ⇒ the off notice; the keyword in the turn attaches the guide for exactly that turn. Everything goes into the USER
MESSAGE in front of what was typed, never into the system prompt (prompt cache), and only into a toolset that carries
`cbase_dynamic_workflow`. The counter survives a restart (`ultracode_reminder`).

## `busy` and deploy

Dynamic workflows do NOT count in `busy` of `/api/runs/active`: they are in the field `dynWorkflows`, the deploy does
not wait for them but shows them, and the restart resumes them — the price: agents that were in the middle of a run at
the swap begin anew. The deploy's oneshot detection excludes workflow agents (process marker `.workflow.mcp.json` or
`CBASE_WORKFLOW_AGENT=`); the gateway's idle reaper still counts `dynWorkflows` as activity.

## Knobs (gate values in `tools/check/targets/check.mjs`)

| Environment | Default | Gate |
|---|---|---|
| `CBASE_DYNWF_SECTION_MS` | 30,000 (time limit per section) | 5,000 |
| `CBASE_DYNWF_RUN_CAP` | 8 | 16 |
| `CBASE_DYNWF_USER_CAP` | 8 (otherwise the setting) | 8 |
| `CBASE_DYNWF_STAGGER_MS` | 5,000 | 0 |
| `CBASE_DYNWF_STALL_MS` / `_STALL_REPETITIONS` | 180,000 / 5 (`providers/agent-runtime.js`) | 3,600,000 |

A single test file only behaves as in the gate with these values.

## Tests

Sandbox seam without a server: `dynworkflows-sandbox.test.js` (the original examples of the pinned baseline against
hand-written expectations, prohibitions, the tail after the script's end) with `dynworkflows-harness.mjs`. Unit:
`dynworkflows-cap.test.js`. All others drive the main seam with `agent-harness.mjs` (real server, real MCP server,
real core, fake providers): `-run`, `-agents`, `-stop`, `-approval`, `-journal` (without a server: both chain kinds
against their real Claude Code journal), `-resume`, `-server-end`, `-concurrency`, `-structured`, `-budget`, `-size`,
`-call` (`workflow()`/`name`), `-limits` (parking, gate, stall), `-agent-type` (worktree, agentType), `-tree`,
`-reminder`, `-slash`, `-interventions` (skip, restart), `-library`, `-save-gate`, plus `graph-dynworkflow.test.js`
(opt-in in the graph, step holds, card bound to the step) and in `mcp-schema.test.js` the binding opt-in ↔
description.

**Where the reference measurements come from:** the example scripts of the pinned Claude Code and their hand-written
expectations are measured and kept outside this tree; only the behaviour reaches the product. The journal fixture
`fixtures/dynworkflows-journal/<pin>/` is produced with `node
server/backend/test/fixtures/dynworkflows-journal/generate.mjs [<version>]` (local CLI against an API mock; TWO passes
in the same journal — the second through `resumeFromRunId`, so that "replaced" is measured on the baseline too; the
fixture 2.1.296 stays as proof of the linear calculation and is never regenerated). The test reads it for the pin
from `server/backend/Dockerfile`: when it moves, the test is red until the new version's fixture exists.

## Three typical questions

1. *A script from Claude Code behaves differently here.* — Which wrapper? `sandbox.js:PRELUDE`; compare the wording
   with the binary of the pinned version, then a probe in `dynworkflows-sandbox.test.js`. If a journal key differs:
   `journal.js:chainOptions` and the branch calculation (`branchKey`, `replacedKey`) against
   `dynworkflows-journal.test.js`; if the sandbox reports the wrong lane: `dynworkflows-sandbox.test.js`.
2. *Why does the workflow not start but show a card?* — `run.js:startDynWorkflow`, the ONE condition before
   `createCard` (`chat.ultracode`, `keywordInTurn`, `nodeOpens`); the word only counts in the human input of THIS turn
   and never in a quote, bracket, tag or behind `/` (`approval.js:carriesKeyword`).
3. *An agent says "waiting" or runs anew after a deploy.* — The reason is in the journal (`cap` · `stagger` ·
   `storage` · `limit` · `credit-gate` · `project`, `run.js:slotTake`); after a restart all agents run anew that are
   not "finished with a result" in the journal, and everything behind the first failed one (`journal.js:createChain`).
   If a test hangs after a script: `abort()` in the `finally`; "everything reported" means `quiet()`, not a waiting time.

## What does NOT live here

- `runs/` never imports this folder (hub guard `import-direction.test.js`), except `runs/routes.js`; the rest goes
  through the hooks in `server.js`. The agent core (`providers/agent-runtime.js`, `runs/agents.js`,
  `runs/agent-set.js`), the data layer (`store/dynworkflows.js`, `store/dynworkflow-runs.js`,
  `store/ultracode-reminder.js`) and the tools (`../../mcp/tools/dynworkflows.js`, locks in
  `../../mcp/visibility.js`) live in their own places.
- The holding of a graph step at card or workflow: `workflows/gates.js` (`dynApprovalDecided`),
  `channels/delivery.js`.
- The UI. **Web**: `components/chat/DynWorkflowTree.tsx` + `lib/dyn-tree.ts`, `chat/WorkflowApprovalCard.tsx` +
  `lib/workflow-approval.ts`, `lib/workflow-marker.ts`, `workflow/DynWorkflowsPane.tsx` + `lib/dyn-library.ts`,
  `settings/UsageSettings.tsx`, `lib/active-runs.ts` + `pills/ActiveRunsPill.tsx`. **iOS**: `Chat/DynTree.swift`,
  `Chat/DynWorkflowTree.swift`, `Chat/WorkflowApproval.swift`, `Chat/WorkflowMarker.swift`,
  `Workflows/DynWorkflowsPane.swift`, `Settings/WorkflowCapSection.swift`, `Settings/WorkflowSizeSection.swift`.

## Residual risk ("vm in the server, 1:1")

The context runs in the server's process, without a process of its own and without an additional protective shell —
like Claude Code. An escape from `vm` reaches the server; a script that eats memory takes it down. Not adopted from
the baseline: freezing the intrinsics and the await rewriting (both against thenable escapes), a memory cap. Only
coding chats start workflows, and those have Bash anyway.

Two deviations from the baseline, both against a server that stands for ALL chats:

- **Time limit per section** between two await points (default 30 s, `CBASE_DYNWF_SECTION_MS`): the context runs with
  `microtaskMode: "afterEvaluate"`, every return into it is an evaluation with `timeout`. Claude Code only limits the
  synchronous beginning. Here the run ends as failed (`error.kind` "deadline"), the backend stays reachable.
- **Catcher for unhandled rejections** of a script-owned promise (recognised by the context's promise prototype);
  otherwise a `Promise.reject(…)` without a handler would end the process.

After the script's end (ok, runtime error, abort, synchronous deadline) no pump, tick, timer or answer goes into the
context any more: a `.then` continuation of an `agent()` that was not awaited would otherwise run after the catcher
was unregistered, and its throw would end the backend process. A `log()` in such a continuation therefore does not
appear, and an `agent()` there starts nothing.

Open:

- The server calls objects and intrinsics of the context also OUTSIDE the pump (without a time limit): `JSON.parse`
  and `Map.prototype.get` when receiving, `JSON.stringify` of the return value (`toJSON`), getters on a thrown object,
  `constructor[Symbol.species]` at `then`. A script that overwrites one of them makes the server hang forever — and
  the restart runs into it again.
- The cap of 1000 and the budget only check the wrappers INSIDE the context; a forged call message starts agents past
  cap and budget (only the slots brake).
- Not the sandbox: a restart (human or stall) of an agent with a schema inherits the old attempt's reference; a
  structured result goes to the script unsanitised; a stop does not reach an "interrupted" run (the next restart
  resumes it); the wordings in `sandbox.js`, `script.js`, `budget.js`, `structured.js` carry no pin-sync stamp; the
  name rule skill ↔ workflow only applies when saving the workflow.
