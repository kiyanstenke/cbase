# `workflows/` — Workflow runs (definitions, triggers, runs, gates)

**What lives here:** the RUN of a graph workflow. The driver sits on the server, not in the prompt: every instruction node is a
turn of its own, a small sandboxed model judges conditions, loop lists and completion, and a question pauses the run.

| File | What |
|---|---|
| `definitions.js` | views of a definition — `workflowMeta` (list entry with trigger state and locks), `workflowFull` (graph plus editor hints), `triggerViews` (configuration plus operating state, account without token), `withLosses`, `saveWorkflow` (whole graph, names unique per scope, arming, run settings) and `workflowTriggerRoute` (`trigger-status`, `trigger-test`; a function with a return value, not a route function) |
| `run-state.js` | the caps `WORKFLOW_MAX_STEPS`/`WORKFLOW_MAX_VISITS` (check rounds are the run setting `run.doneRounds`), `workflowGraph`, views (`workflowRunView` including `compaction`, `runHistoryView`, `emitWorkflowRun`), step log (`logRunStep`, `runStepStart`, `closeRunStep`), `runStillOur`, locks (`lockSituation`, `runLockKey`), the setters `setTriggerWakeup` and `setGraphRunObserver` |
| `driver.js` | `beginWorkflow`, `driveWorkflow`, `finishWorkflow`, the verdict oneshots (`judgeWorkflowCondition`, `judgeNodeDone`, `doneJudgeModel`, `verdictOneshot`), compaction between two steps, the limit-side hooks `workflowDismissedHook` (afterLimitCancel) and `workflowContinueHook` (afterCompactResume) |
| `gates.js` | `workflowGateAfterRun` (one gate per run state, with a claim), `workflowRunFailed`, `holdWorkflow`, round cap (`answerCap`), review (`requestHumanReview`, `answerReview`, the agenda item "Request review"), `answerWorkflow`, skip and cancel, `dynApprovalDecided`; hook consumers and switch responders through which `runs/` reaches the workflow side without importing it: `workflowGateHook` (afterRun), `workflowFailedHook` (afterRunFailed), `followUpRunSwitch`, `graphHoldSwitch`, `verdictSwitch`, and for the restart `workflowLocksHook`, `workflowRunsHook`, `workflowAbandonedHook` |
| `triggers.js` | the poller (`startTriggerPoller`, `scheduleTriggerDrain`, `pollTriggerNode`, `fireTrigger`), waterline and read pointer per event kind, the start caps |
| `routes.js` | `workflowChatRoutes` (`/api/chats/:id/workflow`, `/workflow/skip`, `/workflow/cancel`), `workflowRunRoutes` (`/api/workflow-runs[/:id]`, `/api/gitlab/accounts[/:id]` with `/test`, `/projects`, `/groups`), `workflowWorkspaceRoutes` (`/workflows[/:id]`, `/workflows/:id/trigger-status|trigger-test`, `/effective-workflows`) |
| `shortName.js` | leaf without imports: `shortBase`, `withShortNames`, `WORKFLOW_MENTION`, `withoutQuotes`, `mentions` |
| `slash-workflow.js` | `/workflow:<shortname>` at the message route: `graphSlash` (refusals or the announcement), `announcementText` (the prompt the model reads) |
| `graph-start.js`, `graph-routes.js` | starting, viewing and stopping graph workflows from the chat (MCP `cbase_workflow_start/_status/_stop`): `startPerTool`, `graphRunView`, `reportGraphRun`, `stopGraphStart`, redeeming (`graphTurnCompletion`, `wakeGraphStarts`, `graphStartsRestartGrace`), the child chat in the background (`backgroundStart`, `graphRunsOpen`, `stopKindRuns`) |
| `graph-wait.js` | leaf: what a run is waiting for (`waitDetail`, `instanceOf`) |
| `graph-background.js` | the observer of background runs: silent hint and notification when a wait begins, output file and completion notice at the end, lapsing of undelivered messages (`letExpire`), worktree cleanup, hooks `graphApprovalRequestHook`, `graphApprovalRulingHook`, `graphChatClosed` |
| `graph-message.js` | messages to the node agent of a background run (`graphTarget`, `messageToNode`, `withEarmarked`, `messageFromQueue`, `putBackMessage`, `graphRunsSummary`, `messageFrame`) |
| `storage-gate.js` | leaf: the save gate (`storageSituation`) |
| `storage-queue.js` | leaf without imports: the shared arbiter of waiting for memory (`setStorageQueueSource`, `wakeStorageQueue`, `storageQueueSoon`) |
| `worktree.js` | leaf: the own git worktree of a run (`createGraphWorktree`, `graphWorktreeChanged`, `removeGraphWorktree`, `graphWorktreeRepos`) |

## Rules worth knowing

- **Verdicts are sandboxed** (`../runs/sandboxing.js`: empty folder, no tools). They only see their prompt, and the prompts say
  so. Condition and loop list answer `{"unclear": "<reason>"}` instead of guessing (`driver.js:unclearFrom`): the run then ends
  visibly `failed`, with the reason in the log row and the end note, without a second attempt; a real `[]` stays the empty list.
  The completion gate has no "unclear" — when in doubt "not done", and the agent of the step delivers more.
- **A run ends exactly once** (`finishWorkflow`), and every writer after an `await` checks `runStillOur` first: a verdict takes
  seconds, and the human may have skipped, cancelled or stopped in the meantime.
- **Dynamic workflows inside a graph step:** a step may call `cbase_dynamic_workflow` (opt-in via ultracode in the run settings
  or the keyword in the node text, `dynworkflows/approval.js`). Without opt-in the gate holds at the approval card LIKE at an
  open question (`pending` `{ kind: "dyn_approval", node, requestId }`), only at the card of ITS step. `dynApprovalDecided`
  releases the step before the decision starts a run; the completion notice arrives as a follow-up turn of the same step.
- **Triggers are polled, not webhooks.** The waterline is kept per event kind (`since_kind`, `since` is the minimum): a kind
  whose poll fails keeps its line and shows its error in the status at every tick. A kind reads ascending from its line, at most
  1,000 entries per poll; beyond that it continues from its read pointer (`continue_kind`) at the next tick. Both start caps
  (`CBASE_TRIGGER_MAX_FIRES`/`_MAX_ACTIVE`, read at call time) only defer, neither discards. The dry run ("check now") takes its
  own path: one page per kind, the newest entries.
- **Starts from the chat happen only on announcement.** The human names the workflow with `/workflow:<shortname>` in a message
  (never inside a quote line "> …"); the message route rewrites the prompt (`slash-workflow.js`), the model earmarks via
  `cbase_workflow_start`, and the END of the turn redeems the row into a run (`graph-start.js:graphTurnCompletion`). A stopped
  or failed turn dismisses the earmark, a parked one keeps it. In the foreground at most one workflow is open per chat.
- **Background runs** run in a child chat of their own (`kind = 'normal'`, linked only through `graph_starts.child_chat_id`, in
  no chat list, following the orchestrator into archive and deletion). One level only. The orchestrator never answers for the
  human: a wait is reported to it as a silent hint, the end as a `<task-notification>` (`graph-background.js`).
- **Save gate:** a background start waits as `waiting_storage` while the user container is above 80 % of its memory limit
  (working set, without page cache) or the host is below 20 % free. Per pass at most ONE start leaves the memory wait, the
  oldest — counted across graph starts, stack copies and the other registered sources by the one arbiter `storage-queue.js`
  (woken by the tick, the trigger wakeup, the heavy load and the end of a copy's build).
- **Worktree:** `worktree: true` gives a run its own git worktree without a project lock, created when redeeming. One run folder
  `graph-<startId>` with every code repo of the project under its usual relative path, branch `cbase/graph-<startId[0..8]>`;
  ignored `.env*` files (depth ≤ 2) are copied, `node_modules`/`.venv` linked and anchored in `info/exclude`. A repo without a
  committed file is listed in `info.skipped` instead; the project repo cbase keeps in the project folder is never branched. At
  the end the worktree is removed if unchanged, otherwise it stays and view and completion notice name its path. In a
  converted project all git and file work runs inside the project container, removal as a checked teardown job
  (`runs/git-post-work.js`); `force` never removes unsaved changes there. A background start pins its child to the instance of
  the starting turn (`graph_starts.instance`); a foreground start with worktree is refused while the chat's copy is waiting or
  being built.
- **Messages to the node agent** (`cbase_agent_send` with `to: "graph:<startId>"`, only from the main agent of the parent chat):
  into the running node turn ("delivered"), after it into the same process ("after_turn"), otherwise into the earmark store
  `graph_messages` and along with the next turn the driver or a gate starts (`withEarmarked`). A message never answers a gate.
  What is still earmarked when the run ends lapses, and every sender gets exactly one note.

## What does NOT live here

The graph library (`normalizeGraph`, `countSteps`, `triggerNodes`, `eventSummary`, the prompts of steps and verdicts) is the root
`../workflows.js`; persistence is `store/workflows.js` and `store/graph-starts.js`; the check model of the completion gate comes
from `settings/agent-models.js` (app agent `workflow`, or `run.doneModel`). The effective workflows of ONE chat
(`/api/chats/:id/workflows`) live in `chats/routes.js`, the project workflows including their trigger routes in
`projects/routes.js`. `run-state.js` imports nothing from this folder: wakeup and observer arrive as setters from `server.js`
(an import would close a cycle). Unset, the wakeup silently does nothing — hence a test of its own pins the wiring
(`server/backend/test/gitlab-trigger.test.js`).

## Terms → file

Workflow definition, list entry, full entry, saving, losses, trigger view, trigger test → `definitions.js` · graph (nodes,
edges) → `../workflows.js` · run state, caps, step log, lock, trigger wakeup → `run-state.js` · driver, verdict (condition,
completion) → `driver.js` · gate (review, round cap, completion check), the human's answer, hold at an approval card, hook
consumers and switch responders → `gates.js` (`driver.js` for the limit side) · trigger poller, waterline → `triggers.js` ·
short name, mention `/workflow:` → `shortName.js` · graph start from the chat, announcement check, run view, event `graph_run` →
`graph-start.js` (routes `graph-routes.js`) · what a run waits for → `graph-wait.js` · hint, notification and completion notice
of a background run, deleted child chat → `graph-background.js` · `/workflow:` on send, the prompt for the model →
`slash-workflow.js`.

## The three most frequent questions

- What does saving a workflow check, and why do losses come before the editor hints? → `definitions.js:saveWorkflow` (409 on a
  duplicate name per scope, model only if `modelKnown`; run settings as a partial patch with three statements per field —
  missing = unchanged, empty = back to default, only an unknown non-empty value is a 400 —, and only what changes is checked) /
  `definitions.js:withLosses`.
- Why does a trigger test not move the waterline? → `definitions.js:workflowTriggerRoute` (`dryRun` without `fire: true`;
  otherwise the test would swallow the events the user is waiting for).
- Why did my message not answer the waiting gate? → `gates.js:followUpRunSwitch`: only a human's message is the answer of a
  waiting run; a message from an agent, a channel or a watch is earmarked or put back and never decides for the human.
