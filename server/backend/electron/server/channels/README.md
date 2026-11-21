# `channels/` — channels (coding chat ↔ coding chat)

**What lives here:** the channel.
- **Delivery** (`delivery.js`): `deliverChannel` as a turn to the participant, cards
  `channelCard`/`writeChannelCard`/`channelCardsEnter`, `channelWorkflowHolds`, `channelRestartGrace`, `channelAfterDelivery`
  at run end, `channelHumanInvolved`; the hook consumers `channelRestartGraceHook` (`restartGrace`), `channelHumanHook`
  (`beforeDeliver`; the condition `cause === "user"` sits here), `channelRestoredHook` (`chatRestored`) and
  `channelDeliveryHook` (`end`/`turnEnd`), registered in `server.js`; the cap `channelCapReached`; status
  `pauseChannel`/`resumeChannel`/`closeChannel`/`openChannel`; `channelParticipantsDeleted`.
- **Messages and files** (`messages.js`): `sendToChannel`, `resolveChannelFiles`/`reloadChannelFiles`/`stageChannelFiles`,
  `CHANNEL_FILES_MAX`.
- **Lifecycle** (`lifecycle.js`): `channelCreate`, `publicChannel`, the status reading `channelStatus*`.
- `deliver.js` (`deliverToChat`, delivery to ONE chat — a waiting workflow, otherwise `deliverUserPrompt`).
- `freeze.js` (`channelFrozen`/`channelFrozenError`: a channel with a participant of kind manager is read-only — no message,
  no delivery, no status, no note; every writing route answers 409 with `runs/manager-lock.js:managerLock`).
- The coding half of the agent-communication migration (`migration-communication.js:migrateCommunicationCoding`, on every
  start from `server.js`, with its table `migration-communication-table.js`).

**Routes (`routes.js`):** `channelRoutes` (in `ROUTES`) — `/api/channels/:id` with `/messages`, `/pause`, `/resume`,
`/close`, `/open`, `/read` and `/api/channels/:id/files/:name`; `channelChatRoutes` (sub-slice of
`chats/routes.js:chatRoutes`, `sub` under `/api/chats/:id`) — `/channels` (list; `GET /channels/:channelId` calls
`communication/read.js:channelHistory` — ONE version with the view "channel"); `channelWorkspaceRoutes` (sub-slice of
`workspaces/routes.js:workspaceRoutes`) — `/channels` per workspace (GET; POST creates WITHOUT approval — the human, UI and
test benches; an agent's way is `cbase_agent_send` to `chat:<id>`).

**What does NOT live here:** the queue a delivery falls into is `runs/queue.js:deliverUserPrompt`; persistence is
`store/channels.js`; a workflow runs in `workflows/driver.js:beginWorkflow`.

**Terms → file:** delivery, card, cursor, cap (8 agent rounds), status → `delivery.js` · message, attachment, files, send →
`messages.js` · create, status situation → `lifecycle.js`.

**Reach of a sender's files (`messages.js`):** attachments of a coding chat come through
`runs/runtime-location.js:attachmentFolderToRead` (after a deferred project switch also at the old place;
`channelOwnAttachment` returns `{ file, path }`). A coding chat of a project that runs in a project container gives only
project folder and attachments, not the workspace, checked by the real location (`runtime/real-path.js`); the attachment
folder itself counts only through the trusted anchors (`runs/runtime-limit.js:anchorOfTheInstance`). The reach is computed
by `runs/runtime-limit.js:areaInB`, for a chat in its COPY strictly and locked: its project folder does not count as a root
in B, no real location below it is within reach (a link in the attachment folder or `/proc/self/root<P>/…` would otherwise
bring bytes of the main instance into the channel). WHOSE project applies is told by `channelSituation`: the origin of the
request (`ctx.fence` of the route — also a subagent that lives on in the old project after a project switch), otherwise the
running turn (`runs/instance.js:turnIdentifier`), otherwise the current project; without an instance the plain reach.
Files of a message that lie in the project folder of a COPY live in its container: `channelInContainer` (from the
IDENTIFIER of the token or the turn, never the project alone), `channelCapCheck` (cap per message, an error instead of
silent truncation), `reloadChannelFiles` and depositing with the data read — through `runtime/fileAccess.js`, never from
the main instance. Guard `server/backend/test/channel-copy.test.js`. `resolveChannelFiles` checks the NUMBER per message
BEFORE any resolution (`CBASE_CHANNEL_FILES_COUNT`, default 50, the same number as `maxItems` on the tool) — 0-byte files
would otherwise run through a copy's container in any number.

**The source of a channel file:** `resolveChannelFiles` opens a path or attachment within the instance's area
(`runs/runtime-limit.js areaInB`) or in the runtime folder (`runs/runtime-write.js openFromRuntimeFolder`) through the
descriptor — a regular file only, a FIFO is "not a file" without stalling — and notes device, inode and size;
`depositChannelFiles` opens it again and deposits only the same one (`channelSourceCopy`), otherwise "changed — nothing
sent". Between a check by path and `copyFileSync` there would be a window in which the container swaps the file for a link
into B. Without an instance and outside the runtime folder the plain copy applies. Guard
`server/backend/test/runtime-read.test.js`.

**Frequent questions:**
- Why does a channel message not arrive in a workflow chat? → `delivery.js:channelWorkflowHolds` (the run waits at a gate,
  or a question card is open); delivery happens after the human's answer through `delivery.js:channelAfterDelivery`.
- Why does a channel message not arrive in another chat? → `delivery.js:deliverChannel` also holds at an ARCHIVED target
  (for all channels: no agent brings a chat back from the archive; the cursor stays, `channelArchiveHold` writes ONE card
  `systemKind: "archived"` per new state on the sender's side; delivery happens on the next occasion after the human brought
  the chat back) and at an open question card of the target (it is the question to the human, in EVERY channel; the
  delivery of every channel is `deliver.js:deliverToChat`). At the cap (`channelCapReached`) a channel pauses with a note.
  A silent channel (coding ↔ coding, cap 0) is created in `communication/target-chat.js` through `channelCreate`.
- What else holds or informs? A child chat of an ENDED graph run gets nothing (`communication/child-chat-end.js` —
  `deliverChannel` holds BEFORE the node path, `sendToChannel` throws ⇒ 409); the node path returns its state
  (`{ graph }`, `sendToChannel` collects it as `message.deliveries` for the response); an open question or approval card
  also holds an entry already QUEUED (`channelInputHolds`, source of `runs/queue.js:setInputHolds` — causes "message"
  and "channel"); `openChannel` (POST `/api/channels/:id/open`, only from "closed", note "opened");
  `channelRestoredHook` (bringing a chat back from the archive delivers); the archive note carries
  `noteId: "archive:<target>:<last>"` and stands once per state, across restarts too (`store.channelNoteStands`); the out
  card carries `recipient` with exactly one counterpart; `publicChannel` has `archived` and `questionOpen` per participant.
- Why is a channel suddenly paused? → `delivery.js:channelCapReached` (8 agent rounds since the last human involvement,
  pause with note); `delivery.js:channelHumanInvolved` resets `agentsSinceHuman` (not in a frozen channel).
- How is a channel created, and who may create it? → only through `lifecycle.js:channelCreate`: the human through
  `POST /api/workspaces/:wid/channels`, an agent silently through `cbase_agent_send` to `chat:<id>`
  (`communication/target-chat.js`, coding ↔ coding, cap 0); exactly two chats of the same workspace are required, a
  participant of kind manager is a 409 (`freeze.js`). `channelStatusSituation` carries `archived: true` on an archived
  participant.

**Child chat of a graph run:** `delivery.js:deliverChannel` first asks `workflows/graph-message.js:graphChildRun` — a
channel message to the child chat of a background run takes the node path (into the running node turn, otherwise noted for
the next; card at once, cursor moves forward), never a turn of its own and never a gate answer (`channelWorkflowHolds`
does not apply to it). The child chat is never the TARGET of a channel: `channelCreate` refuses it (except as creator) — it
creates a channel itself.

**Agent communication:** `lifecycle.js` also exports `CHANNEL_STATUS_ROLES`, `channelStatusSituation`,
`channelStatusSince`, `channelStatusHistory`, `channelStatusRow` — the reading of a chat for a model, ONE version for
`cbase_agents_list` (view `chat`, summary on request; `communication/read.js`, `communication/retrieval.js`). The preamble
of every delivery names `cbase_agent_send` with `to: "channel:<id>"`
(`migration-communication-table.js:channelResponseRow`); an entry queued earlier with the old sentence gets the new one on
restart (`delivery.js:preamblesRefresh`). `POST /api/channels/:id/messages` stays (test benches, tests, the fence), no MCP
tool calls it anymore. An agent writes into a channel with `cbase_agent_send` to `channel:<id>`
(`communication/target-channel.js` → `messages.js:sendToChannel`), to `chat:<id>` without an open channel silently through
`lifecycle.js:channelCreate` (`communication/target-chat.js`).

**Outer loop:** `lifecycle.js:channelStatusHistory(chat, since, filter, { fromId })` reads with `fromId` only rows ABOVE that
`messages.id` (the waterline of an outer-loop run) and also returns `untilId` — the highest id read before the cap
(otherwise `fromId`); without `fromId` unchanged. The roles of the input are `CHANNEL_STATUS_ROLES.messages`
(`outerloop/run.js:OUTER_LOOP_ROLES`) — the same list the channel status reads.

**Stored forms:** the note id prefix `archive:` (de-duplication key in `messages`) and the run kind `chat:channel` in `active_runs` (both
rewritten from the old product's German forms by the data migration); the pattern `OLD_CHANNEL_RESPONSE` stays German (it matches prompts
stored before the tool pair existed).
