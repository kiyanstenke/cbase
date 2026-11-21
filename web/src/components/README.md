# `web/src/components/` — map

Rule: NO `./X` import under `components/`, only `@/components/…` and `@/lib/…`, so moving a file never breaks a
neighbour. The chat family lives in `chat/`; the shared chat set (below) stays at the top level.

## Folders

| Folder | What | README |
|---|---|---|
| `chat/` | the Coding chat: `ChatPane` (root), `ChatListPane` (chat list), `ChatStage` (drop target, header with banners, hero or history, approval cards, selection menu, footer), `ChatComposer` (input field), `ChatRightSidebar` (right rail), the streaming reducer `chatBubbles.ts`, hooks (`chatStream`, `chatCache`, `chatArchive`, `chatBackground`, `chatBackgroundTasks`, `chatModelChoice`, `chatDynTree`, `chatGraphRuns`, `chatAgenda`), `RunDisplay`, `StatusLine` | there |
| `scheduled/` | the Coding tab "Scheduled": jobs (`ScheduledTab`, `ScheduledList`, `ScheduledDetail` with the job's chat as `chat/ChatPane` in `onlyChat` mode, `JobDialog`) | there |
| `settings/` | `SettingsModal` and its pages | there |
| `pills/` | the header pills (active runs, services, agent browsers, VS Code); only `TopNav.tsx` renders them, on every page | there |
| `preview/` | preview links (ngrok): the `usePreviewLinks` state and "Share link" for the service rows of the services pill | there |
| `workflow/` | workflow editor, pane, tab, runs, triggers; `DynWorkflowsPane.tsx` is the per-workspace library (kind "Dynamic" in the "Workflows" tab, `WorkflowsTab.tsx`). Tab keys and kinds live ONCE in `lib/coding-tabs.ts` | there |
| `outerloop/` | the "Agents" tab with the kinds Subagents · Outer Loop · Instructions (`AgentsTab.tsx`; Subagents = `AgentsPane.tsx`, Instructions = `AgentInstructions.tsx`, both at the top level), the outer-loop list, its editor, the runs and the chat info `OuterLoopChatSheet.tsx` | there |
| `projects/` | the "Projects" tab (`ProjectsPane.tsx`), the creation dialog `ProjectCreate.tsx`, the layout view `ProjectLayout.tsx`, and `projects/git/` (the large view in the "Git" tab); the old folder dialog without an ops marker is `FolderDialog.tsx` at the top level | there |
| `timeline/` | the per-project timeline: `Timeline.tsx` (large in the project view, compact in the right chat rail), `TimelineRow.tsx`, `TimelineCard.tsx`, `TimelineForm.tsx` (kind → icon ONCE); wire `lib/api/timeline.ts`, jump to the chat row `lib/rows-jump.ts` + `chat/chatRowsJump.ts` | there |
| `git-bar/` | building blocks of the git bar (`GitSidebar.tsx`, top level) that carry a file of their own, e.g. `GitGraph.tsx` (graph over all branches as in VS Code); computation in `lib/git-graph.ts` | there |

## Frame

Header (`TopNav.tsx`) and a 52 px symbol rail on the left (slot `cbase-rail` in `app/layout.tsx`) share one colour
(`bg-frame`, class `.cb-frame` in globals.css); the page stands beside them as a rounded card with a hairline edge.
Two components fill the frame through a portal: `SymbolRail.tsx` (the tabs of a page as icons with a tooltip and up/down
keys; Coding only) and `HeadersMiddle.tsx` (the page frame in the middle of the header: workspace › project, "All
workspaces" on Apps). Its content ALWAYS carries no-drag, the header is a drag region, and the slot sits in the DOM AFTER
the tab strip because Electron computes regions in DOM order; if it does not fit the free band at its minimum widths,
`TopNav` puts it in a row of its own.

## Top level

- `CbKit.tsx`: the UI kit of ALL pages: `TabBar`, `Modal`, header, `Menu`, `Segments`, `Search`, `Toggle`, `Chevron`; the
  blocks of the quiet page without cards (`COLUMN`/`COLUMN_WIDTH`, `PagesHeader`, `Point`, `EmptySentence`, `RowsArrow`);
  and the form of the instances (`SELECTED`, `ROW`/`ROW_INSIDE`, `LIST_ROW`, `FACTS`/`Fact`, `Tile`, `Section`/`SectionHeader`,
  `EmptyRow`, `symbol`, the Coding symbols `SYM`, the same icons as the rail). Used by Projects, Instances, Services,
  Agents (subagents, outer loop), Workflows (graph list and Dynamic, not editor and runs), MCP, Context and Credentials:
  rounded rows without hairlines, tile in the colour of the state, facts with 12 px icons, summary above the list.
- `Origin.tsx`: `OriginMarker` and `OriginSection` (a whole kit `Section` with a tinted tile): project versus workspace
  entries in Agents, MCP, Credentials and Workflows; names via the `OriginNames` context of the Coding page.
- `CategoryBar.tsx` (the context categories; also exports `CategorySymbol` for the tile of each context row), `TopNav.tsx`,
  the Coding pages (Agents, Skills, Code, Terminal, Browser; the last three borderless on the stage with hairlines between
  their areas; terminal tabs and editor terminal take the page background colour, `xtermOnBackground` in `TerminalPanel.tsx`).
- `AgentMcpChoice.tsx`: the coding MCP servers of an agent type in the `AgentDialog` (`AgentMcpChoiceList`, field `mcp` =
  `{ serverId: null | [tool] }`): per server a checkbox, then "All tools" or "Selection"; orphaned ids and tools stay visible
  and deselectable. Server side `toolchain/agent-mcp.js`, computation `runs/agent-set.js codingSet`.
- `AgentInstructions.tsx` (props `workspaceId`, `projectId | null`): the third kind of the "Agents" tab. Per level an ordered
  list of sections (title, scope as a word, on/off toggle, up/down in the row); a click opens the editor (kit `Modal`: title,
  scope as `Segments` — All agents · Main agent only · Subagents only —, on/off, monospace text, character counter against the
  server's cap, delete with a question). In a project the workspace sections come first (readable, with the adoption toggle,
  opt-out), then the project sections (`OriginSection`). On a 409 conflict the editor keeps the input and offers "Load latest"
  or "Save mine on top". Reloaded on the global `instructions` event. Server seam `lib/api/instructions.ts`.
- Code tab with instance choice: `CodeArea.tsx` carries editor (`CodePane`) and git column (`GitSidebar`); on project level with
  the choice "Main | Copy k1 | …" (kit `Segments`, only for a relocated project with a ready copy; source `/api/projects`,
  computation `lib/code-instance.ts`). A copy goes to EVERY route as `instance=<identifier>` (the main carries no parameter);
  remembered per project in localStorage. A fallback (copy gone, removed, failed, 404 `UNKNOWN_INSTANCE` while editing) shows as
  a note above the editor and editor and git column are rebuilt per instance. A copy that is only NOT READY right now stays
  selected; a fallback with unsaved tabs keeps the shown copy (`holdFallback`, "Switch to main" with a question). In a copy the
  editor says there is no language service. Guards `web/test/code-instance.test.mjs`, `code-instance-binding.test.mjs` (iOS
  twin `Code/CodeInstance.swift`).
- Git of the right chat rail with instance choice: `chat/ChatRightSidebar.tsx` carries a kit `Menu` "Main | Copy k1 · this chat |
  …" above the git column (only for a relocated project with copies; computation `lib/bar-instance.ts`). Without a choice git
  follows the chat (`?chat=`); another choice sends `instance=<identifier>` or nothing for the main, never both; the shown AND
  controlled instance is the chosen one, a marker says so if it is not the chat's. The own instance comes only from a RESPONSE
  (a silent failure is not "the main"). Remembered per chat in memory only; fallback with a note if the chosen copy is gone.
  Terminal and own browser stay with the chat's instance. Guards `web/test/bar-instance.test.mjs`, `bar-instance-binding.test.mjs`
  (iOS twin `Chat/BarInstance.swift`).

## The shared chat set

`AssistantBlocks`, `AskCard`, `CaptureCard`, `ChannelCard`, `ApprovalCard`, `PermissionPrompt`, `MessageActions`,
`SelectionMenu`, `SlashPalette`, `ImageLightbox`, `LimitStrip`, `Autocompact`, `CbSendButton`, `AgentBar`, `NotifySheet`,
`ComposerStrip` stay at the top level (the shared set is not a second kit). Opening a Coding chat from any page goes through
`lib/chat-jump.ts` `openCodingChat`.

- `ComposerBase` (`ComposerStrip.tsx`) carries the optional prop `graphRow` (part `data-strip="graph-start"`, buttons
  `graph-abort`/`graph-hide`; only the Coding chat stage passes it), the running compaction as the first row (part
  `data-strip="compacting"`), and the goal row in the form of the ChatGPT app (`goalPaused`, `onGoalPause`; buttons `target-end` =
  trash, `target-pause`, `target-expand`). All rows sit 1 px below the input field (14.5 px), about 34 px high.
- `AgentBar` carries "Move to background" under the row of a running foreground agent (`data-agents-background`,
  `POST /api/chats/:id/agent/background`), "Stop all background agents" (`data-agents-all-stop`,
  `POST /api/chats/:id/agents/stop` with `from: "human"`, also without a running turn) and "Message" at the head of every living
  subagent (`data-agent-message`, sheet `chat/AgentMessageSheet.tsx`, `POST /api/chats/:id/agent/send` with `from: "human"`); a
  parked agent shows "waits until HH:MM" instead of the speed. With the optional prop `workflows` (state from
  `chat/chatDynTree.ts`; only `chat/ChatRightSidebar` passes it) it renders `chat/DynWorkflowTree`; the empty sentence appears
  only if `carriesWorkflow` (`lib/dyn-tree.ts`) says `false` explicitly (`null` means "not loaded yet", not "no workflow").
- `chat/RunDisplay.tsx` (activity display and metrics row; ONE component for the Coding chat) sits with its ingredients
  (`verbFor`/`fmtTokens` from `chat/ChatCatalog.tsx`, `CbIcon` from `chat/ChatIcons.tsx`); cycle guard
  `web/test/import-cycles.test.mjs`. There is no icon column in front of the history rows; every row starts at the text edge.

### Background Tasks (right rail, tab "Background Tasks")

ONE list for all kinds, newest on top, one heading with a total (`data-bg-tasks-header`), cards `div.space-y-1.5[data-bg-tasks]`,
each `overflow-hidden rounded-xl bg-panel cb-task-card` with `data-bg-task="agent:<id>"|"workflow:<runId>"|"graph:<startId>"`.
The list is computed by ONE hook, `chat/chatBackgroundTasks.ts` (`useBackgroundTasks`, pure parts `lib/bg-list.ts` +
`lib/bg-rows.ts`, guard `web/test/bg-list.test.mjs`, bound to iOS), ONCE in `chat/ChatRightSidebar`; `AgentBar` gets the state as
prop `bg`, and the number on the tab is the count of running rows of that list (`bgRunningCount`). The sections "Running"/"Ended" are ONE row list under ONE node
(`lib/bg-rows.ts`, guard `web/test/bg-rows.test.mjs`): a card that changes section at the end of its run stays the same
component and does not collapse; the marker `data-bg-section` sits at the section head. The tab icon is stacked layers with a
dot (`BackgroundTasksIcon`); iOS: `square.stack.3d.up`. Per kind:

| Kind | Included? | Why / how | Runs while | Stop |
|---|---|---|---|---|
| subagent (`cbase_agent`) | yes | work beside the main agent | `live` | `POST …/agent/stop` |
| dynamic workflow | yes | runs outside the turn | status `running` | in the card (`…/dyn-workflows/runs/:runId/stop`) |
| graph workflow in the background | yes | in the child chat, started by the chat | `graphOpen` | in the card (`…/graph-workflows/:startId/stop`) |
| background command / CLI monitor | yes | Bash `run_in_background`, monitor; event `background` | while reported | none (the server knows none) |
| wakeup (ScheduleWakeup/CronCreate) | yes | scheduled continuation of THIS chat | `wakeupAt` > 0 | none |
| outer-loop run (summariser, agenda keeper, own) | no, own area | the runs appear in Coding → Outer Loop and in the chat info (guard `bg-list.test.mjs` (f)) | — | — |
| scheduled (next occurrence) | no | an occurrence is the main agent's next MESSAGE in this chat, not work beside it; it would stand as "running" permanently. Place: Coding → Scheduled | — | — |
| compaction / autocompact | no | part of the turn, no run of its own | — | — |
| the chat's shared browser (`chat:<id>`) | no | a tool, not work; it has its "Browser" tab | — | — |
| agent browser, preview link, LSP, terminal | no | resources, not work; each has its own place | — | — |
| instance copy / relocation | no | belongs to the project or instance, not the chat | — | — |
| queue, auto-continue at the limit | no | the main run itself (strip, composer footer) | — | — |
| channel delivery | no | messages, not work; tab "Channels" | — | — |

## The archive (shared; Coding only)

Three shared building blocks, each with ONE flow for all menus. The pure computations are in `web/src/lib/archive.ts` (no import;
`web/test/archive.test.mjs` compiles and runs it), the routes in `lib/api/archive.ts`.

| File | What | Used by |
|---|---|---|
| `ArchiveEntry.tsx` | THE menu entry "Archive" for chat and folder: loads the precheck on appearing, shows the reasons as server text (`data-archive-reason`) and is then disabled; if the open question is the only reason, "Dismiss question and archive" appears below it (`data-archive-question-dismiss`); open shells ⇒ a question, even without a number if the precheck failed (`archiveShellQuestion`). Flow in `lib/archive.ts` (`loadPrecheck`, `archiveProcedure`); no substitute value for the precheck | `chat/ChatStage` (header), `chat/ChatListRows` |
| `ArchiveView.tsx` | the archive list in the list column per kind: archived folders first with their chats, then loose chats labelled with their active folder (`archiveGroups`), own search, per row ⋯ with "Restore" and "Delete permanently"; the delete question for a folder takes its numbers from the SERVER (`folderPermanentlyProcedure` → `folderDeleteQuestion`: the row may count search hits, the question must not); after deleting it reports the deleted ids as the window event `CHATS_DELETED` (`cbase-chats-deleted`); loads on opening and on `chat_archive`/`chat_created`, `chat_archive` bundled (300 ms; the open chat immediately) | `chat/ChatListPane` (button `data-archive-open="normal"`) |
| `ArchiveBar.tsx` | the bar in place of the input: "Archived on {date} — read only" + "Restore"; in Coding a child of the stage instead of `<ChatComposer>` | `chat/ChatPane` |

Guards: `archive.test.mjs` (computations, flows, bindings by path), `archive-binding.test.mjs` (the same computations in Swift),
DOM proof outside the gate: checked by hand in a real browser.

## The ChatPane family (`chat/`)

`ChatPane.tsx` is the root: it renders list, stage with the composer as a child, rail, and conditionally the provider-switch
sheet side by side. `onEvent` is the shell of the reducer, `runSlash` the shell of the slash switch, `open()` calls the cache
hook. The file stays under the line-count guard (2,000). It computes the state of every subagent ONCE (`agentsList` with
`runningBlockIds`) and passes it as the map `agentStates` to stage and marker; it calls `useArchive` (`activeChat =
chats.find(…) ?? archiveChat`, `?chat=`, preselection and `cbase-open-chat` go through `openTarget`).

| File | Content |
|---|---|
| `chat/ChatComposer.tsx` | composer JSX, handlers (mention, slash, picker), loaders, width measurement, the composer flags; in the form of the ChatGPT input (`.cb-composer`, button row inside the field, round send button `CbSendButton`); prop `effectiveModel` carries the already resolved model and `effortCatalog` the UNFILTERED provider list (model check marks, effort choice and the marker on the collapsed effort button hang on them); the effort picker entries come from `effortEntries` (`lib/effort.ts`) without an empty entry and without an Ultracode entry (Ultracode is a separate toggle below, independent of the level), and only when `effortPicker` says yes |
| `chat/ChatRightSidebar.tsx` | ONE flex rail `aside[data-chat-bar]`: right the activity bar (40 px, icons with counter badges from `BAR_SECTIONS`, `lib/chat-bar.ts`), left of it the draggable panel (280–640 px) with `GitSidebar` (state from `lib/git-state.ts`), artifact tree with upload, drop and text-artifact form, `ChannelSidebar`, `AgentBar`, `TerminalsPane` (own PTYs per chat) and `BrowserPane` (browser choice per PROFILE of an agent browser, `lib/browser-choice.ts`; the image fills the height and scrolls sideways, `lib/browser-surface.ts`; the button "Open in own window" `[data-browser-window]` goes through `openBrowserWindow`, page `app/browser/page.tsx` with `?profile=`/`?scope=`/`?id=`). Own state only for what the rail alone sets. In the archive: no terminal, artifacts without upload and paste, channels read-only (`ChannelSidebar onlyRead`) |
| `chat/ChatListPane.tsx` | the docked list, the rail of the collapsed list, the hover preview and the three menus (`ChatMenu`, `NotifySheet`, `FolderMenu`) as ONE fragment; own state only for what the list alone sets (collapse with `useAutoCollapse(900, …)`, peek, sorting, menu state) and the handlers only it calls (`forkChat`, folder create/rename/delete, `moveToFolder`); the "Archive" button in the list header switches the column to `ArchiveView`; the "Delete folder" question names the context files from the server's precheck ("number unknown" instead of a guessed 0) |
| `chat/ChatStage.tsx` | the root `div` of the chat surface as ONE tree (drop target, folder view, header with `LimitStrip` and workflow/task banners, hero or history with `BubbleRow`/`RunDisplay`/`PermissionPrompt`/`SelectionMenu`, footer with `NativeTaskBar`, `ComposerBase`, toast, slot `{children}`, context bar). Around the scroll area lies the margin surface `@container/history` (`data-history-margin`): from 816 px of stage the scroll area is 768 px wide and centred, the scrollbar stands in the 16 px gutter beside the reading column (736 px, also the composer width), a wheel over the empty margin is passed to the history by `useMarginWheel` (`lib/margin-wheel.ts`). Own state only for what the stage alone reads (scroll sticking with `useLayoutEffect` + ResizeObserver, height memory, header and footer measurement, `useGateThreshold`, `nativeTasks`, `heroProject*`, `lastAssistantIdx`, stable handler refs). In the archive: marker `data-archive-marker`, ⋯ with "Archive"/"Restore"/"Delete", no drop, no entry points, the task banner without ticking off |
| `chat/chatBubbles.ts` | history types (`RunSummary`, `QueuedMessage`, `WorkflowLine`, `AskBubble`, `Bubble`), `buildBubbles` and the streaming reducer (`reduceChatEvent`, `streamAfterEvent`, 23 pure mutators, `ReducerCtx`/`StreamState`/`ChatEvent`). Pure TS, leaf module without React (types through `@/…`, values relative `.js`); gate `web/test/reducer.test.mjs` |
| `chat/chatStream.ts` | `useChatStream({ activeIdRef, onEvent })`: the refs of the chat stream, `awaitChatStream`, `attachChatStream`/`openChatStream` with the three healers, the focus/online effect |
| `chat/chatSlash.ts` | `runSlash(text, attachments, h: SlashHandler)`: the slash switch (the same names as `SLASH_COMMANDS`), the handlers as a map destructured at the head; `/effort` checks against the levels of the EFFECTIVE model, searched in ALL providers (not in the picker list filtered to `connected`); `/effort ultracode` switches the mode on |
| `chat/ProviderSwitchModal.tsx` | the provider-switch warning modal (7 props, all required, no state); `pickModel`/`doProviderSwitch` stay in ChatPane |
| `chat/chatCache.ts` | `useHistoryCache(deps)`: cache ref, `putChatCache`/`dropChatCache`, `syncChatCache`/`reloadOpenChatLog`/`revalidateChat`; the 7 deps as getters because `loadArtifacts` in ChatPane sits behind the hook position; `open()` stays in ChatPane |
| `chat/chatModelChoice.ts`, `chat/chatBackground.ts`, `chat/chatArchive.ts`, `chat/chatDynTree.ts` | hooks: provider lists, preselection of the next chat, effective model, level and `pickEffort`, `ultracode`, `effortForCreation`; wait phase, the five wait states, their setters from the stream and the agents derived from it; metadata of an archived open chat, archive/restore, `openTarget` for every path by id, recheck every 15 s; the state of the progress tree of ONE Coding chat |
| `chat/ChatCatalog.tsx` | slash commands (`SLASH_COMMANDS`, `SLASH_RE`, `slashCommandLen`, `withSlashGlow`), aliases (`MODEL_ALIAS`, `MODE_ALIAS`), the model fallback (`CLAUDE_MODELS`, `CODEX_MODELS`, `modelsFor`, `contextWindowFor`), `PERM_MODES`, `STATUS_WORDS`/`verbFor`, `fmtTokens` (the ONLY version for the chat; the agent bar has its own format in `lib/agents.ts`), `fmtRunTime`, `artifactUrl`, `artifactNameFromTitle`, sidebar keys, `SORTINGS`, `greeting`, `IDEAS` |
| `chat/ChatBubbleRow.tsx` | pasted text as an attachment (`PASTE_*`, `isLargePaste`, `pastedFileName`, `pastedPreviews`, `PastedTextCard`), `ChatSkeleton`, `BubbleRow` (the metrics row via `MetricRow` BEFORE the actions, event rows without padding of their own and with `data-event`, `memo` with its own comparison `sameRow`: the map `agentStates` is compared via `bubblesKey`, so only rows whose subagents change state repaint) |
| `chat/RunDisplay.tsx` | `RunDisplay` (spinning hexagon in a 1 em box at the text edge, `data-run-hex`; status word, run time, tokens; whether it shows is decided by `runDisplayVisible`, `waiting` is required) and `MetricRow` (`data-metric-row`, `data-metric-hex`); the second ticks in the parent |
| `chat/ChatListRows.tsx` | the rows of the chat list: `Section`, `buildSections`, `ChatRow`, `FolderRow`, `FolderMenu`, `ChatMenu`, `MenuItem`; imported only from `chat/ChatListPane.tsx`; `ChatMenu` and `FolderMenu` carry the `ArchiveEntry` (`data-chat-archive`, `data-folder-archive`) |
| `chat/ChatIcons.tsx` | `svg` (default 15) and the inline icons of the Coding chat; `CbIcon` also takes `size="1em"` |
| `ModelChoice.tsx` | THE one model picker with search (see the file header); computation in `lib/model-search.ts`; guard `web/test/model-search.test.mjs` (nobody builds model rows themselves, no second search field, every place uses the component) |

Nothing is exported from `ChatPane.tsx` except `ChatPane` itself, otherwise component and helpers would import each other.
`web/test/credit.test.mjs` reads the family BY PATH (`readChatPaneFamily`: `chat/ChatPane` + `chat/ChatStage` + `chat/chatBubbles` +
`chat/ChatBubbleRow` + `chat/chatStream` + `chat/chatSlash` + `chat/ProviderSwitchModal` + `chat/chatCache`: the stage renders the
`<LimitStrip`, the reducer listens for `limit_line`); whoever moves a file or the role "limit" / `<LimitRow` / `<LimitStrip` updates
that list. `STATUS_WORDS`, `verbFor` and `fmtTokens` exist only in `chat/ChatCatalog.tsx` (guard Z8 in
`web/test/history-without-points.test.mjs`); the second `fmtTokens` in `lib/agents.ts` is a different format (the agent bar's) and Z8
allows exactly those two definitions. The model catalog lives in three places: `providers/connectors/claude.js` and
`connectors/codex.js` (server), `chat/ChatCatalog.tsx` (fallback + `/model` aliases) and `Chat/ChatViewModel+Slash.swift` (iOS).
File table, the three most common questions: `chat/README.md`.

## Leaf modules in `lib/` that the chat family depends on

All are pure leaf modules (no `@/` import; `lib` rule: `API_BASE` relative from `./api/core.js`, `dateLocale` from `./i18n.js`).

- `model-search.ts`: the computation of the model picker: `searchWords`, `modelHits` (EVERY word must appear in label, value or group
  name; groups without a hit drop out; an empty query ⇒ everything, as a copy), `firstHit`, `groupOf`, `labelOf` (`null` for a foreign value).
- `chat-format.ts`: `attUrl`, `fmtSize`, `fmtDur`, `clockTime`. `channel-card.ts`: `withChannelCard`/`ChannelCard` (the reducer needs it
  without React; `ChannelCard.tsx` re-exports both).
- `completionNotice.ts`: the completion notice of a subagent: TWO kinds under the role `user` (for the main agent the input of a new
  turn, for the human a system message). `FINISHED_MARKER` (`<task-notification>`, bound to `runs/completionNotice.js`),
  `isCompletionNotice`, `readCompletionNotice`, `finishedRow`. Every view that reads history rows asks HERE; iOS counterpart
  `Chat/CompletionNotice.swift`.
- `agents-message.ts`: the THIRD kind under the role `user`: an agent's message (cause "message", built by `runs/message-marker.js:buildMessage`),
  `<cbase-message from="…" kind="agent|outer_loop" address="…">…</cbase-message>`; `MESSAGE_MARKER`, `isMessage`, `readMessage`,
  `messageCard` (even a broken message never becomes a user bubble), `messageHeader`, `messageQueue` (asked FIRST by the completion
  notice's `queueEntry`). Drawn by `chat/AgentMessageCard.tsx`; iOS twin `Chat/InboundAgentMessage.swift`, bound in
  `web/test/agents-message-binding.test.mjs`.
- `hint.ts`: the hint row (message role `hint`, a stored value) as ONE switch for all history views: `hintSeparator(text)` (empty text ⇒ `null`) and the type
  `SeparatorKind` (`"completionNotice" | "hint" | "workflow-start" | "workflow-end"`); drawn by `chat/SeparatorRow.tsx`; guard `web/test/hint-row.test.mjs`.
- `workflow-marker.ts`: start and end marker of a dynamic workflow as ONE switch (`MARKER_ROLE` = `workflow_marker`, its own message
  role): `readWorkflowMarker`, `markerSeparator`; twin `Chat/WorkflowMarker.swift`. `workflow-approval.ts`: the approval card of a
  dynamic workflow without opt-in: roles `workflow_approval` (card) and `workflow_approval_ruling` (decision); a card is open until a
  decision exists for its `requestId`; twin `Chat/WorkflowApproval.swift`.
- `dyn-tree.ts`: the progress tree as a pure computation: load state `DynTreeStatus` (`treeAfterEvent` with a buffer for events during the
  request), `carriesWorkflow` (`null` = not loaded), `runningWorkflowAgents`, `treeModel` (bands per phase, n/m computed ONLY here),
  `agentHandles` (skip while "running" and "parked", restart only while "running"), `interventionPath`; event `dynwf_tree`; guards
  `web/test/dyn-tree.test.mjs`, `dyn-tree-binding.test.mjs` (iOS `Chat/DynTree.swift`).
- `graph-runs.ts`: the graph-workflow starts of a chat as a pure computation: `GraphRunView`/`GraphRunsStatus`, load state (an answer
  without a list and an error are NOT empty), `hasGraphRuns` (`null` = not loaded), `foregroundRow`, `GRAPH_STATES`, the card of a
  BACKGROUND run (`backgroundRuns`, `cardOf`, `responseForm`, `responseRequest` over the EXISTING routes), `childChatOf` (the target of
  "Open": the child chat), `graphDurationMs`, `graphOpen` (= stoppable); event `graph_run`; guards `web/test/graph-runs.test.mjs`,
  `graph-runs-binding.test.mjs` (iOS `Chat/GraphRuns.swift`).
- `dyn-library.ts`: the shapes of the library answers (`DynWorkflowEntry`, `DynWorkflowFull`), `listPath`; guard `web/test/dyn-library.test.mjs`.
- `coding-tabs.ts`: the tab keys of the Coding area in ONE place (`CODING_TABS`), from which come the order, the type and the whitelist
  for restoring after a reload (`savedTab`); an old tab key is the named legacy `OLD_TAB` (a reload leads to `workflows`);
  `WORKFLOW_KINDS` = graph · dynamic; bound to the page's tab list and to iOS `WorkspaceCategory` in `web/test/coding-tab.test.mjs`.
- `active-runs.ts`: which global events make the "Active runs" pill reload (`LOAD_EVENTS`: `init`, `run`, `workflow_run`, `dyn_workflow`).
- `agents.ts`: the agent list of the bar (`agentsList`, states, formats) and the **background state** as a pure transition function:
  `BackgroundStatus`, `BACKGROUND_EMPTY`, `BACKGROUND_KINDS`, `backgroundAfter(state, evt)` (`run_started`/`run_done` clear only the
  foreground, the agents stay until a `background` without them; `run_aborted`/`run_error` clear everything), `waitingUntilText`
  (bound to iOS in `web/test/waiting-until-binding.test.mjs`), `tokenKindFromReport` (a missing field is unknown, not "full";
  `tokenLowerLimit(kind)` shows the "min." marker, bound in `web/test/token-kind-binding.test.mjs`). The hook `chat/chatBackground.ts`
  holds exactly this state; gate `web/test/agents.test.mjs`.
- `effort.ts`: the effort levels of a model (exactly five: `low < medium < high < xhigh < max`): `effortLevels`, `effortSelection`,
  `effortSupported`, `effortFallback` (which level runs INSTEAD of the one set: the highest supported one that is NOT ABOVE the
  wanted one, else the lowest supported: clamped down, never up, because one more level costs thinking tokens against the
  subscription limit; ordered by `EFFORT_LEVELS`; the same computation as in `workflows.js`, bound pair by pair in
  `web/test/effort.test.mjs`), `effortEntryLabel`, `effortLabel`, `EFFORT_LEVELS` (the ORDER, the only source in the web, bound to the
  server and to `EFFORT_LABEL`), `EFFORT_DEFAULT` (only the fallback for a MISSING `efforts` list), `effortMarker`/`effortHint`,
  `EffortCatalog`, `effortEntries` (the ONE building block of all effort choices: empty entry with the caller's word, then per level the
  label and, on an unsupported one, the marker; iOS counterpart `Kit/EffortSelection.swift`), `effortNoLevels` (an explicitly EMPTY
  `efforts` list means "no levels", Haiku 4.5; missing stays "unknown"), `effortProvider` ("Default (global)" is an empty provider and
  computes with the globally active one), `effortWithoutSelection`/`effortPicker` (THE decision "picker yes/no": `caps.effort` off or a
  model without levels), `effortDefaultLevel`/`effortStandardLabel` (the empty word of INHERITING fields is "Default · <level>" with
  exactly the level that then thinks; variant `asChat` for a workflow's run level), and for Ultracode `ULTRACODE`/`effortChoiceBody`/
  `ultracodeBody` (no level: never in `EFFORT_LEVELS`, never on the wire; a toggle independent of the level, separate PATCH bodies).
  The source is `efforts` per model from `/api/providers`. ONE place for all choices (composer, workflow run, agents, default level in
  the provider settings: all call `effortEntries`; `web/test/effort.test.mjs` enforces it by searching `web/src`, named exception
  `chat/chatSlash.ts`); all ask the UNFILTERED provider list, because which levels a model supports depends on the model, not on the login.
- `history-state.ts`: the states of the history rows as ONE computation: `AGENT_STATES` (id → word, tone, pulse; the word is also the
  i18n key), `TONE_CLASS`, `toolRunning`/`groupRunning`, `agentState`, `runDisplayVisible`, `shimmerClass`, `lastResponseIdx`,
  `runningBlockIds`; bound to `mobile/CbaseMobile/Chat/HistoryState.swift` (`web/test/history-binding.test.mjs`).
- `margin-wheel.ts`: the wheel over the empty margin beside the narrow scroll area: `useMarginWheel(msgsRef, userWheel)` returns the
  callback ref of the margin surface, `marginWheelContinue`, `wheelPixel` (`deltaMode` → px), `marginWheelListener`; the user's intent
  (`userWheel`) runs BEFORE scrolling.

Checked by hand in a real browser (not in the gate): the slash picker, the limit strip, the channel bar, the chat scroll bar,
the history edge, the dynamic-workflow tree and library.
