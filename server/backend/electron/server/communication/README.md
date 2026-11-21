# `communication/` — agents talk to each other (tool pair `cbase_agents_list` / `cbase_agent_send`)

**What lives here:** the server side of the tool pair. ONE path for every message of an agent and ONE predicate for
everything it may read of other chats.

| File | What | Called by |
|---|---|---|
| `address.js` | `readAddress(to)` — leaf without imports: subagent (no prefix) · `wf:<runId>:<n>` · `graph:<startId>` · `channel:<id>` · `chat:<id>` · `outerloop:<agentId>` (the sender address of an outer-loop card — as a TARGET a 400 for everyone) | `send.js`, `projectbox/fence.js` (body `agentSendInScope`) |
| `sender.js` | `senderOf(chat, {ofProfile, workflowAgent, outerLoop})` → coding · outer_loop · subagent · workflow · special; `writePermissionToChats(role)` → free · no; `WRITE_PERMISSION_CODING` ("free"); `WRITES_CHANNEL` (coding: who writes to `channel:` and workflow aliases); `sendPermissionsOfTheRun(chatId, markers)` → markers `CBASE_WRITE_PERMISSION` and `CBASE_ONLY_SUBAGENTS` (role "special") | `send.js`, `target-chat.js`, `toolchain/mcp-config.js` |
| `visibility.js` | `readableReason`/`readable(reader, target)`, `commonChannels`/`commonChannel` — same workspace; coding chats without a special role, never a graph child chat | `read.js`, `target-chat.js` (search uses the same) |
| `send.js` | `sendMessage({chat, body, fence})` — originator `from` (required, 400) → address → role → allowlist per kind → handler; uniform response `{ok, state, text, …}`. A name without prefix that (also) matches a workflow agent goes to `wf:`, or together with a subagent is a 400 with candidates from both; `from: "human"` writes WITHOUT a running turn to a subagent (resolved like the stop, `sendToSubagentAsHuman`, without approval) or to a workflow agent, never from a project network (403), never to `channel:`/`chat:` (400) | `runs/routes.js` POST `/api/chats/:id/agent/send` |
| `target-subagent.js` | `subagentHelper(id, fence)` (the resolution that start, message, output and stop share), `sendToSubagent` | `send.js`, `runs/routes.js` (/agent, /agent/output, /agent/stop) |
| `target-channel.js` | `sendToChannelTarget` — participants only; a child chat of an ENDED graph run ⇒ 409 (`child-chat-end.js`); if the delivery takes the node path of an open child chat, the response comes from its result (`deliveries` of `sendToChannel`, `graphResponseText`); open ⇒ delivered / after the turn (with an open question card on the other side "noted"), waiting ⇒ approval, paused ⇒ stored, closed/rejected ⇒ refused without a new channel, an archived participant ⇒ 409 | `send.js`, `target-chat.js` |
| `target-chat.js` | `sendToChat` — write permission "free" (coding main agent, also node agent of a child chat): the MOST RECENT channel of the two chats decides (through `target-channel.js`), without a channel silently `channelCreate` (open, cap 0, creator = sender, no inbox item, only to a coding chat); "no" ⇒ 403. Archived target ⇒ 409 | `send.js` |
| `target-wf.js` | `sendToWorkflowAgent` — who writes to `wf:<runId>:<n>` (the main agent, role coding, and the human; otherwise 403) and the shape of the response; resolution, delivery, journal and transcript in `../dynworkflows/message.js` | `send.js` |
| `target-graph.js` | `sendToGraph` — also `graph:<startId>:<agentId|label>` to a living subagent of the child chat (`graphAddress` splits at the first colon) while the run is open; who writes to `graph:<startId>` (the main agent of the parent chat, role in WRITES_CHANNEL; otherwise 403, the human never arrives: 400 in `send.js`) and the shape of the response; resolution and delivery into the running node turn or the run's noted-messages store in `../workflows/graph-message.js` | `send.js` |
| `target-main.js` | `sendToMain` — a subagent or workflow agent of a coding chat writes to the main agent of its chat (address `main`), delivered through `deliverUserPrompt` | `send.js` |
| `child-chat-end.js` | `childChatEnd(chatId)` (the background row of a child chat whose run is NO LONGER open — `store.graphStartOfChild` + `graphRunsOpenOf`), `channelOfEndedChildChat(channelId, from)`, `runningNotMore(name)` — the ONE version; `workflows/graph-message.js` imports both. Leaf | `../channels/delivery.js` (`deliverChannel` holds BEFORE the node path: no card, no cursor, no turn), `../channels/messages.js` (`sendToChannel` throws ⇒ 409 on both send routes), `target-channel.js` (409 before files are loaded) |
| `read.js` | `readView` with the views `summary` (default, cap 20 with "N more"; `workflowAgents` with the agents of the chat's running workflows — run address, label, phase, state, waiting and parked ones too; `graphRuns` with the chat's graph workflows in the background — address `graph:<startId>`, workflow, node, status, noted messages, living subagents of the child chat, `../workflows/graph-message.js:graphRunsSummary`; per chat `note` — the newest of ITS workspace's summarizer instead of the first user message, with `source` (`NOTE_SOURCE`) — and the entry `notes` with source and foreign-text hint; the view `chat` carries the note in its header; an outer-loop run (`?outerLoop=`) gets only `summary` without subagents/workflows/channels, `chats` and `chat` — `VIEWS_OUTER_LOOP`, otherwise 400) · `start` (`startView`, the body of GET `/agents`) · `chats` (with `search` also full text: per chat up to three `hits` with an excerpt, `indexIncomplete` while the backfill runs) · `chat` · `channel` (`channelHistory`, ONE version with GET `/api/chats/:id/channels/:channelId`); `note` on every view with foreign text; no project boundary | `routes.js`, `runs/routes.js` (GET `/agents`), `channels/routes.js` (`channelHistory`) |
| `retrieval.js` | `summaryOnDemand(reader, target, {since})` — app-agent role `channel_status`, sandboxed; booking through `opts.atConsumption` → `addUsageEvent({…, source: "retrieval", agentId: "channel_status"})`, billing kind from the provider kind (`providers/connectors/consumption.js:bookingCounts`) | `read.js` (view `chat` with `summarize`) |
| `search.js` | `bringAlongChatSearch` (the existing rows in batches, `setImmediate` in between, triggered by the hook "restartGrace" — `chatSearchRestartGraceHook`, registered in `server.js` — and by every search on an incomplete index, after a failure at most once a minute), `searchInChats(request, chatIds)` in two steps: `matching` (which chats, how often — without a cap) and `hitsFor(ids)` (only for the chats shown, up to three each with `excerpt`, diacritics folded as in the index); the index itself is kept by `../store/chat-search.js` (contentless FTS5, triggers, state); the same search finds the summarizers' notes (`store.outerLoopNoteSearch`, an index of its own — notes of other outer-loop agents never): a matching chat counts them in `matching`, their hits (`role: "note"`) come before those of the messages, and if the message index is missing, the note search keeps searching alone | `read.js`, `server.js` |
| `target-outer-loop.js` | `checkSendMarker(chat, marker)` — the marker `<agentId>:<runId>` holds only for a RUNNING run of this agent on exactly the chat in the path, whose agent selected `cbase_agent_send` AND whose set carries it (otherwise 403); `sendAsOuterLoop` — only `chat:<id>` (every readable chat or the observed one itself; 404 unknown, 409 archived or open question card, 400 empty or with files), a card `kind="outer_loop"`, `from` = the agent's name, address `outerloop:<id>`, delivered through `deliverUserPrompt` (cause "message") — no channel, no item, no reply | `send.js` |
| `foreign-text.js` | `NOTE` — the foreign-text sentence on every response with chat-derived text. Leaf | `read.js`, `agenda/routes.js`, `outerloop/analysis.js` |
| `routes.js` | `communicationChatRoutes` — GET `/api/chats/:id/communication?view=…` (sub-slice of `chats/routes.js:chatRoutes`) | dispatcher |

**Terms:** sender = the chat in the route's path (a fence token belongs to an instance, not to a chat); role and write
permission rely on the MCP server's markers (`ofProfile`, workflow marker) — they catch misconfiguration, they are NO
boundary against an agent with Bash. "The description follows the execution": the MCP server builds the descriptions of both
tools from the same computation (`mcp/lib.js:runEnvironment`, `CBASE_WRITE_PERMISSION` from `sender.js`).

**Frequent questions:**
- Why does an agent get 403 on `chat:<id>`? → `sender.js:senderOf` (special chat, subagent, workflow agent) or
  `visibility.js:readableReason` (foreign workspace, child chat, special chat, manager chat); 409 → target archived or
  channel closed (`target-channel.js`).
- Why is a chat not in the summary? → `read.js:readableChats` (the predicate); the summary shows 20 and says "N more" — the
  view `chats` shows up to 200. If the search does not find a text: `indexIncomplete` (backfill running) or the kind is not
  in the index (`store/chat-search.js`: `CHAT_SEARCH_EXEMPT`, a turn cause outside `CHAT_SEARCH_CAUSES`, tool output).
- Why did a channel message not arrive? → `channels/delivery.js:deliverChannel` holds at the workflow gate, at an archived
  target (note on the sender's side, `channelArchiveHold`) and at an open question card. A frozen channel
  (`channels/freeze.js`) accepts nothing.

**What does NOT live here:** the MCP tools (`../../mcp/tools/agents.js`, visibility `../../mcp/visibility.js`); the channel
itself (delivery, cap, states: `../channels/`); the subagents' core (`../runs/agents.js`,
`../providers/agent-runtime.js`); the fence (rows "chat-agent-send" with body `agentSendInScope` and "chat-communication" in
`../projectbox/fence-table.js`).

**Wording on the wire (English plain text, read by the calling agent):** `FOREIGN_CHILD`, `FOREIGN_INSTANCE` and `NO_RUN` in `target-subagent.js` — imported as
constants by `runs/routes.js`; the tests match the English sentences.

**Guards:** `server/backend/test/communication-{address,send,read,description,teardown,old-names,workflow,graph,chat}.test.js`
(`chat`: silent channel and ping-pong, channel table, archive hold including restart grace, question hold, full text with
backfill and the binding of the kind markers, fence across project boundaries, cap without wakeup; `graph`: Claude node
"delivered" in the same turn, Codex node continuation before the next node, review gate ⇒ noted without a turn and without
a gate answer, also through channel and queue, after restart in the next node's order; refusals; format
`runs/message-marker.js`; `workflow`: human without a turn, noted in the first request, Codex continuation before the
result, gate ⇒ "not_delivered", restart, fence, StructuredOutput; `teardown`: request → booking, preamble on restart, ONE
channel reading; `old-names`: no old tool name as a string under `server/` and `mcp/`).
