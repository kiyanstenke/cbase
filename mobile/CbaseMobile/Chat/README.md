# `CbaseMobile/Chat/` — the coding chat of the iOS app

The chat view, its stage (the inverted list), the composer, the history model and the cards of the chat. The files are cut
along their clusters; `ChatViewModel` is ONE class: a class head plus `extension ChatViewModel` files
(`ChatViewModel+<Topic>.swift`).

**Whoever reviews the chat reads the family.** The stage, the composer and the keyboard mechanics were measured over weeks
(see `mobile/README.md`, "The composer sticks to the keyboard edge"); a second rebuild repeats every keyboard bug.

## Vocabulary

- **Stage** (`ChatTimelineStage`): the one list of history rows; a new kind of row is added in `ChatTimelineRow.swift`
  (private there): the stage knows only `TimelineRow`.
- **Completion notice**: a user-role row that starts with `<task-notification>`; for the main agent it is input, for the
  human a system row (`CompletionNotice.swift`).
- **Agent message**: the third kind under the role `user`, `<cbase-message …>`; a card, not a user bubble
  (`InboundAgentMessage.swift`).
- **Bound twin**: a Foundation-only file whose computation is executed by a web test and must give the same answers as the
  web counterpart (`xcrun swift`, macOS only). Whoever changes it changes the twin too; such files carry no `L(…)` call.
- **Draft**: a new chat is a draft until the first send (see below).

## Files

### Views and stage

| File | What |
|---|---|
| `ChatView.swift` | `MobileChatView` (the root), `ChatComposerRoot`, `ChatArrowOverlay`; the header on the left carries only "back" (`chat-back`), the chat list opens by swiping right |
| `ChatTimelineStage.swift`, `ChatStage.swift`, `ChatStageController.swift` | the stage: `ChatTimelineCollectionView`/`Cell`, the inverted UIKit list, `KeyboardFollowerView`; the composer hangs on the `keyboardLayoutGuide` by a constraint (`attachComposer`). `coordinator` is `fileprivate` and MUST stay with the stage |
| `ChatComposer.swift`, `ChatInput.swift`, `ChatStrips.swift`, `ChatStrip.swift` | composer island with its private helpers, input UIKit (`PasteInterceptingTextView`, `ChatInputTextView`, `KeyboardDismissGrip`), strips above the composer (limit, workflow, graph start, queue) and the docked strip stack (`CbStrip*`) |
| `ChatTimelineRow.swift`, `ChatToolRows.swift`, `ChatCards.swift`, `ChatAttachments.swift`, `ChatEnvironment.swift`, `ChatTextMarker.swift` | the rows (`TimelineRow` with its private rows), tool rows and task list, cards (ask, capture, permission), attachments and image/video viewers, environment keys, the text marker |
| `ChatRunStatus.swift`, `ChatShimmer.swift` | `RunIndicator` (hexagon at the text edge, the run row of Claude Code: [hexagon] "12s · 5k tokens" [pill `chat-tasks-pill`] "Thinking…", parts from `RunningTasks.rowsParts`), `RowsHexagon`, the shimmer of a running tool row (Reduce Motion ⇒ `.primary`) |
| `ChatSheets.swift`, `ChatDetailSheet.swift`, `ChatHeader.swift`, `ChatFolderViews.swift`, `ChatArtifactSheets.swift` | context bar, autocompact menu, settings sheet, goal sheet; the agents sheet (see "Background Tasks"); header (a child chat of a graph run is offered no instance choice: the server answers 409 INSTANCE_PINNED); folder and artifact views; artifact browser and detail |
| `ChatsOverviewPane.swift`, `WorkspaceViews.swift`, `FolderContentSheet.swift`, `SlashPicker.swift`, `Adjust.swift`, `SpeechService.swift` | the chats overview, the chat list model/row/new-chat sheet, one chat folder, the picker of the composer, rewriting marked text, reading a message aloud |
| `StatusForm.swift` | the form of the status messages, twin of `web/src/components/chat/StatusLine.tsx`: `StatusRow`, `SeparatorRow`, the card form `.cbCard()`/`CardsHeader`/`CardsButtonStyle` |
| `DaySeparator.swift`, `DaySeparatorRow.swift` | the day separator, twin of `web/src/lib/day-separator.ts`; `DaySeparator` is a bound computation (calendar day via `Calendar.current`) |
| `ChatQuotes.swift` | `QuoteAnnotations`: the card above the composer line (one entry per quote, edit, delete), the marker "1 annotation", `QuoteEditSheet` |
| `ClipboardImages.swift` | images from the pasteboard as attachments: whether it holds an image (decided by TYPES only, so no paste banner appears), which type goes out (png/jpeg/gif/webp raw, everything else as JPEG), loading via `NSItemProvider`; uploaded by `ChatViewModel.uploadImage`, the same path as the photo picker |
| `ProjectTimelineSheet.swift` | the timeline of THIS chat's project as a sheet (header button `chat-timeline-button`, only with `chat.projectId`), the same list as Projects → Timeline |
| `ChatGitBar.swift`, `BarInstance.swift`, `ChatInstanceRules.swift` | git view of a chat (`ChatGitBar` model, `ChatGitSheet` with an instance menu) and the instance choice. `BarInstance` and `ChatInstanceRules` are Foundation-only twins (`web/src/lib/bar-instance.ts`; tested by `web/test/bar-instance-binding.test.mjs` and `web/test/chat-instance-ios.test.mjs`): the default without a choice is the chat's instance (`?chat=`), another choice sends `instance=<id>`, never both; the signature carries the binding `chats.instance` |
| `ChannelPane.swift`, `ApprovalCard.swift`, `OuterLoopChatPage.swift`, `AgentMessage.swift`, `AgentMessageCard.swift`, `AgentJump.swift` | channels of the coding chat (opened via ⋯ → "Channels"), the approval card for a tool with an approval mark, the outer-loop chat info, sending a message to an agent (`POST /api/chats/:id/agent/send`, `from: "human"`, never throws; the path is NOT pre-encoded) and its card, the jump "agent in chat" (`AppState.openChat(_:agent:)`) |

### `ChatViewModel` and its extensions

`ChatViewModel.swift` is the class head: the `@Published` state, constants (`client`, `workspace`, `onChanged`,
`onCreated`), the private run variables (stream, draft, echo), `init`/`deinit`, and the stored properties Swift forbids in
extensions, followed by `SubagentLive`/`SubagentEntry`. Every extension is `import Foundation` + `extension ChatViewModel {`.

| Extension | What |
|---|---|
| `+Draft` | composer draft per chat (UserDefaults): `draftKey`, `writeDraft`, `flushDraft`, `dismissDraft` |
| `+Provider` | provider, model, context window (`contextDisplay`, `autocompactMarker`), autocompact (`autocompactEffective`, `autocompactCap`, per-run values while a workflow with its own compaction is open) |
| `+Lifecycle` | `canSend`, `start`/`startListening`/`stopListening` (history and stream TOGETHER), `loadInitial`, `applyTimeline`, `send`, the echo (`echoUserMessage`, `claimEcho`, `dropEcho`) |
| `+Workflows` | `loadWorkflows`, `loadSkills`, `loadSlashWorkflows`, limit wait row, workflow run actions |
| `+Assignments`, `+Actions` | stop/steer/queue/upload/compact/clear; rename, pin, move, fork, delete, settings, goal, mentions |
| `+Questions` | ask, capture and approval cards: `pushAsk`, `answerAsk`, `decidePermission`, … |
| `+Artifacts`, `+Quotes`, `+Archive` | attachments and artifacts; quotes (sent as `> …` BEFORE the message, twin of `web/src/lib/quotes.ts`, kept in `quoteDeposit` in the app's memory); the archive of an open chat (`archived` reads ONLY `chat.archivedAt`) |
| `+Stream` | the SSE stream: `listen`, `handle`, `handleHarness`; `run_started` and a non-aborted `run_done` clear only monitors, commands and wakeups: background agents survive the turn |
| `+Blocks`, `+Timeline` | history blocks from the stream (`handleStreamEvent`, `appendText`, `addTool`, …) and `buildTimeline` (the history from the log) |
| `+Subagents` | pace measurement, `agentBlocks`, the ONE computation for marker and sheet (`agentStates`, `assignment`), `intoTheBackground`, `stopAllBackgroundAgents`, token kind of a FINISHED agent (bound in `web/test/token-kind-binding.test.mjs`) |
| `+Server` | server side: `loadDraftOptions`, `ensureServerChat`, `resolvePendingUploads`, result/tree helpers |
| `+Slash` | slash commands (`runSlash`, `slashCatalog`, `slashHits`, …); `slashWord(in:)` and `slashSorted` are also used by the workflow node's command field |
| `+Reconcile` | reconciliation of the own history with the server: `loadHistory` (in parallel to the stream), `reconcileHistory` (every `connected`: all rows up to `lastId`, count check against `total`, delta or full, then `streamText` as the open bubble; mid-turn with an open bubble NO replacement), `rowFromStream`, `reconnect`, `openBubble` (the truth about the open answer, not `streamOpen`). Guard: `CbaseMobileUITests/Tests/ChatReconcileUITests.swift` |
| `+Window` | the history as a WINDOW (contract `server/backend/electron/server/chats/log-window.js`): `loadWindow`, `loadOlder` (called near the start of the stage, not during an open answer), `resolveTruncation` ("Truncated — load in full" in the tool page) |
| `+DynTree`, `+Tasks`, `+GraphRuns`, `+Agenda`, `+BackgroundTasks` | the progress tree, running tasks, graph-workflow starts, agenda and the one Background-Tasks list of this chat; counterparts of the web hooks `chatDynTree.ts`, `chatTasks.ts`, `chatGraphRuns.ts`, `chatAgenda.ts`, `chatBackgroundTasks.ts`; all only with `withDynWorkflows` (set by `ChatView`) |

Members used by another file of the family lost their `private` and carry `// internal, for extensions` at the line end.
Whoever needs a member from a neighbouring file removes the `private` and sets the marker instead of copying it or moving
the file. `fileprivate` couplings are exactly the marked ones.

## Bound computations (Foundation only, no `L(…)`)

Each is the Swift twin of a web file and is run by a test in `web/test/`; changing one side without the other turns the
gate red.

| File | Twin | Test |
|---|---|---|
| `HistoryState.swift` | `lib/history-state.ts`: the ONE rule for "running" (tool, group, subagent, run row, running answer) | `history-binding.test.mjs` |
| `InboundAgentMessage.swift` | `lib/agents-message.ts` (on UTF-16) | `agents-message-binding.test.mjs` |
| `DynTree.swift` | `lib/dyn-tree.ts`: progress tree computation (loading state, bands, n/m, handles for skip/restart) | `dyn-tree-binding.test.mjs` |
| `GraphRuns.swift` | `lib/graph-runs.ts`: state, foreground row, card, response form, request | `graph-runs-binding.test.mjs` |
| `RunningTasks.swift` | `lib/running-tasks.ts`: which items count, "at least …", `rowsParts`, `hasStop` | `running-tasks-binding.test.mjs` |
| `BackgroundTasks.swift` | `lib/background-tasks.ts`: order by start time | `background-tasks-binding.test.mjs` |
| `ContextDisplay.swift` | `lib/context-display.ts`: denominator, share, percent and title of the context bar | `context-display-binding.test.mjs` |
| `Agenda.swift` | `lib/agenda.ts`: shape and computation of the agenda (tree, visible rows, newer version wins, the keeper's mark) | agenda tests |
| `CompletionNotice.swift` | `lib/completionNotice.ts` | completion-notice tests |

## Features worth knowing

- **Completion notice**: `CompletionNotice.isNotice`/`row` are the ONE switch used by `buildTimeline`, the stream (`user_message`)
  and `startInjectedTurn`; it makes a separator row instead of a user bubble and closes no question. The agents sheet can
  stop all background agents (`chat-agents-stop-all`, with confirmation), move a foreground agent to the background
  (`chat-agents-background`) and shows "waits until HH:MM" for a parked agent.
- **Agent message**: `InboundAgentMessage.isMessage`/`card` is asked BEFORE the completion notice, by `+Timeline`, `+Stream`,
  `+Blocks` and the queue strip (`CompletionNotice.queue`, a system row without a trash can).
- **Context bar**: OpenRouter picks the provider per request; the server attaches name and window to the chat
  (`upstreamProvider`/`upstreamWindow`) and reports `harness/provider`. `contextDisplay` is computed from the catalog window;
  the server computes with the catalog number.
- **Dynamic workflows**: `WorkflowMarker.swift` (start/end marker, own role `workflow_marker`, identifier
  `chat-workflow-marker-<phase>`), `WorkflowApproval.swift` (card under `workflow_approval`, ruling under
  `workflow_approval_ruling`, `POST …/dyn-workflows/approval`; open until a ruling exists), `DynTree.swift`,
  `DynWorkflowTree.swift` (one `CbPane` card per run in the agents sheet, no accent; phases as sections with a tile row; a tap
  on an agent row swaps the page for its transcript). Wiring: `+Stream` (`dynwf_tree`, `workflow_marker`,
  `workflow_approval`, `workflow_approval_decided`), `+Timeline` (the three roles).
- **`/workflow:<short name>`** instead of a workflow button: the third group of the slash picker lists the chat's graph
  workflows (`slashWorkflows`, loaded at EVERY opening, only with `withDynWorkflows`). Only the server computes the short
  name; an entry without one is missing. A server refusal (4xx with `{ error, reason }`) goes through the existing `catch`
  in `send`: error row, text and attachments back into the field.
- **Graph workflows in the background**: `GraphRuns.swift` (above), `GraphRunCard.swift` (card of ONE run under "Background
  Tasks": chevron, title, running time, stop with confirmation, state word in the tone's color, worktree, "Open" = the child
  chat WITH composer via `ChatViewModel.graphChildChat`), and `GraphRunResponse` inside it: every waiting state is answerable
  IN the card (buttons, free text, the questions of an ask card), sent by `ChatViewModel.respondGraphRun` to the EXISTING
  route on the child chat. Nothing is computed in the view: whether "Send" works is `GraphRuns.responseRequest(…) != nil`.
  The row for a not-yet-started foreground start sits in the composer's strip stack.
- **Background Tasks**: ONE list in the agents sheet (`SubagentsSheet`, header "Background Tasks", newest on top, every card
  in the form of `DynWorkflowCard`): subagents, workflows and graph workflows, ordered by `BackgroundTasks.swift`
  (a finished subagent without a start time is placed by its position in the history, `ChatViewModel.taskSequence`).
  Commands, monitors and wakeups are counted in `backgroundRunning`; the header button carries the dot. Outer-loop runs are
  NOT part of it. The pill "N running tasks" opens `RunningTasksSheet` (presented from the chat ROOT, never from the cell;
  "Open" closes it first and then opens the agents sheet).
- **Skills**: `SkillWriteCard.swift` shows the tool block of `cbase_skill_write` (Undo with state fetched fresh via
  `skill-history?skillId=`, or the request card: approve/reject); client and workspace come through the environment
  `chatSkillContext`, set per cell in `ChatTimelineStage.rowView`.
- **Agenda**: `Agenda.swift`, `AgendaSheet.swift`, `+Agenda`: a tree (`visibleRows`, level `min(depth, 3)`, parents compute
  their status on the server), read-only, "in work" dot on the header button, the agenda keeper's mark on a step.
- **Archive**: `ArchiveBar.swift` ("Archived on … — read only" + "Restore") is rendered ONLY by `ChatComposer`: the island
  stays, `inputActive` (= `model.chat.archivedAt == nil`) is the one reading; `ArchiveList.swift` is the archive view.
- **A new chat is a draft**: no entry creates immediately. "Start" in `NewChatSheet`, "New chat" of the drawer and "Start
  chat" on an instance open a draft through `AppState.openDraft(_:)` with the values of `NewChatDraft`;
  `ensureServerChat` → `createChatNow` (`+Server`) creates on the first send with exactly them. Attachments stay local
  (`pendingUploads`) until then. ONE creation per draft: `ensureServerChat` remembers it as `creationJob`, a second send
  (and `updateSettings`/`setGoal` via `waitForCreation`) waits for the same job. An EXPLICIT effort choice goes out with
  `effortChoice: true`, like on the web.
- **Artifacts and folder context are saved BY HAND** (like the web `ArtifactModal`): no writing while typing or on leaving.
  `ChatFolderViews.swift` holds the edit state `ArtifactDraft`, `ArtifactTextBody`, `ArtifactSaveButton` and the modifier
  `ArtifactEditing` (status line, `interactiveDismissDisabled` with unsaved text, own back with a question). No rebuild on
  saving: `saveArtifact`/`FolderContentViewModel.save` patch the row in place instead of reloading. XCUITest
  `ChatRowsUITests/testArtifactIsEditedInPlaceAndSavedOnlyByButton`.

## The three most common questions

- Where does an SSE event arrive and become a history block? → `ChatViewModel+Stream.swift:listen` → `handle` →
  `ChatViewModel+Blocks.swift:handleStreamEvent`, which turns `content_block_start`/`_delta` into blocks via
  `appendText`/`appendThinking`/`addTool`; the history from the log (on opening) is `ChatViewModel+Timeline.swift:buildTimeline`.
  A user row that starts with `<task-notification>` is a completion notice on all three paths.
- Where does the composer hang on the keyboard? → `ChatStageController.swift:attachComposer`, the constraint to
  `hostView.keyboardLayoutGuide.topAnchor`; the mechanics are in `mobile/README.md`.
- Where is an ask card answered, where is a slash command evaluated? → `ChatViewModel+Questions.swift:answerAsk`, triggered
  from `AskCardView` in `ChatTimelineRow.swift` via `onAnswerAsk` in `ChatView.swift`; slash:
  `ChatViewModel+Slash.swift:runSlash`, called from `send` in `ChatViewModel+Lifecycle.swift`.

## Not here

The chat models (`Chat`, `Attachment`, `LogEntry`, `ChatArtifact`, …) live in `Models/Models.swift`; the type scale of the
history (`chatFont(…)`) in `Kit/ChatFont.swift`, the text size of the whole app (`TextSize`) in `Kit/TextSize.swift`.
English texts of this folder are in `Kit/LocDE*.swift` (key = English text); dynamic keys (state words, pill, kind words)
are entered there by hand because `loc-audit.sh` sees only literal calls.

## Rules

- `private` at file level applies per smaller file: whoever needs a private type from a neighbouring file removes the
  `private` instead of copying it.
- Identifiers go on the TEXT or the BUTTON, never on a stack above (it would overwrite the children's identifiers);
  containers that must keep a child's identifiers use `children: .contain`.
- Bound computations stay Foundation-only; their words are German keys for `L(…)`, translated at the place of display.
