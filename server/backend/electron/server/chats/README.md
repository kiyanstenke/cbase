# `chats/` — chats

**What lives here:**
- **Routes** (`routes.js`): in `ROUTES` (`server.js`) sit `chatFolderRoutes` (`/api/chat-folders[/:id]` with `/archive`,
  `/artifacts`, `/context`, `/context/upload`, `/context/file`, `/context/download`), `chatListRoute` (`GET /api/chats`),
  `chatCreateRoute` (`POST /api/chats`) and the **owner `chatRoutes`** of the family `/api/chats/:id(/sub)`: preamble
  (regex, `store.getChat`, 404), the write locks, then `fctx = { ...ctx, id, sub, chat }` through the sub-table of
  sub-slices in order — first `archiveChatRoutes` (`GET`/`PUT /archive`), then `coreChatRoutes` (GET/PATCH/DELETE, `/log`),
  `instanceChatRoutes` (`POST /instance`), `contextChatRoutes` (`/log/delta`, `/log/row/<id>`, `/clear`), `itemChatRoutes`
  (`/workflows` GET, `/skills`), `fileChatRoutes` (`/captures[/record]`, `/attachments`, `/artifacts[/file|/upload|/download]`,
  `/folder-context[/file]`, `/stream`) and the sub-slices of other domains (`runs/`, `channels/`, `workflows/`,
  `dynworkflows/`, `communication/`, `outerloop/`, `agenda/`, `toolchain/`, `devtools/`). The first result ≠
  `NEXT` answers; if everything falls through, the request ends in the dispatcher's 404 (guard
  `server/backend/test/dispatcher.test.js`). Sub-slices are named `*ChatRoutes` and live in the folder of their domain.
- **Creation** (`creation.js`): `chatCreation(body, { modeRequired })` computes the fields for `store.createChat` from the
  body of a creation path — or the refusal with status and wording (workspace, project, folder, provider, model, effort
  level, ultracode, instance). Two readers: `routes.js:chatCreateRoute` and the creation path of scheduled jobs
  (`../scheduled/routes.js` — a job chat is a coding chat). Guard `server/backend/test/chat-creation.test.js`.
- **Genus** (`genus.js`, a leaf: imports only store and i18n): `archivable` (coding chat, no special chat, no app agent, no
  child chat of a background run), `isChildChat`, `chatKind` (the kind of a non-archivable chat in words) and `forkRefusal`.
  Two readers: `routes.js` and `runs/routes.js` (`/fork`) — an import of `routes.js` there would close a cycle.
- **The ONE archive path** (`archive.js`): `chatArchive(chatId, { reason, dismissQuestion })` — check open work
  (`runs/archive.js:openWork`), write (`store.archiveChat` → `chats.archive_reason`), end the shells of the chat rail, send
  `chat_archive`; synchronous, no await between check and write. Two callers: `PUT /api/chats/:id/archive`
  (`reason: "user"`; the genus 400 and the 409 with `open` stay in the route, `dismissQuestion` only there) and the
  auto-archive (`reason: "auto"`; never dismisses a question, and an open terminal of the chat rail is open work there).
- **Auto-archive** (`auto-archive.js`): the global setting (`app_settings.chat_auto_archive` `{enabled, days}`, default
  off / 30, route `GET|PUT /api/chat-auto-archive` in `settings/routes.js`, both fields required, `days` whole 1–365) and
  the cycle the tick in `server.js` triggers (`CBASE_AUTO_ARCHIVE_MS`, default hourly; a PUT that enables it or changes the
  days triggers one right AFTER its response). The cycle is asynchronous: start in the next `setImmediate`, chunks of 25
  candidates with the event loop yielded in between, ONE at a time (a trigger during a running one is remembered and runs
  once afterwards; a setting changed between two chunks aborts; the server end halts it), and a throwing candidate costs
  only itself. Candidates (`store/chats.js:autoArchiveCandidates`): archivable, active, not pinned, with a message, last
  activity = max(last message, `created_at`, `restored_at`) older than `days` days. Guard
  `server/backend/test/chat-auto-archive.test.js`.
- **The ONE closing path** (`erase.js`): `closeChats(chats, deleteRows)` and `deleteChatPermanently(chat)` — channels
  closed, rows gone, then everything on disk and in the process. Every delete path goes through here (`DELETE
  /api/chats/:id`, `DELETE /api/chat-folders/:id?permanently=1`, `DELETE /api/workspaces/:id`, the rollback of a
  half-created fork). In three parts (processes and hooks, rows — `rowsTheChats`, files — `cleanUpChatFiles`). The checks before it (409 during a run, 400 for special
  chats) stay with the caller; archiving is NOT a delete path. Child chats of background graph workflows go with their
  orchestrator on every path (`withChildren`). Guard `server/backend/test/closePath.test.js`.
- **CLI sessions of a deleted chat** (`sessions.js`): the closing path takes the transcripts with it — the chat's Claude
  session, its Codex rollouts, the sessions of its subagents and of the outer loop runs on it, the carried AND every
  previous one (`previous_sessions`, written by two triggers in `store/subagents.js`), in ALL CLI homes (the backend's and
  those of every project runtime folder). Three points in time: `sessionsBeforeDeletion` while the rows exist,
  `collectSubagents` per chat before their records fall, `cleanUpSessions` after ALL rows — an id another chat or subagent
  still carries (`store.sessionCarried`; a fork inherits its original's session) stays. The mechanics live in
  `../runs/session-transfer.js`. Open: sessions of the agents of dynamic workflows, further CLI folders under the id
  (`file-history/` …), the Codex entry `[projects."…"]`, and ids overwritten before `previous_sessions` existed.
- **The history in a window** (`log-window.js`): without parameters `GET /api/chats/:id/log` returns the full history (old
  contract); `?window=1[&before=<id>][&from=<id>]` → `{ total, lastId, older, rows }` — the latest `WINDOW_ROWS` before
  `before`, starting at a bubble boundary (`BOUNDARY_ROLES`), with `from` everything from the boundary at or before `from`;
  long tool results truncated to `TRUNCATE_CHARACTERS` (`truncated` = full length; never those a client reads as JSON —
  `staysWhole`); `GET …/log/delta?…&truncate=1` truncates likewise; `GET …/log/row/<id>` returns one row untruncated.
  Guard `server/backend/test/log-window.test.js`.
- **Captures at the turn end** (`captures-show.js`): the subscriber `capturesShowHook` of "beforeRunBroadcast" (registered
  in `server.js`) ends a running capture of the main agent and shows every capture marked to show (`../captures.js:toShow`)
  that is not sent yet, in capture order, as a card (`postCaptureMessage`: `addMessage` role `capture` + SSE
  `capture_message`, one notice per turn); from the seventh per turn on with `collapsed: true` (`CAPTURES_PER_TURN`). Guard
  `server/backend/test/captures-turn-end.test.js`.
- **Outputs** (`outputs-routes.js`): the sub-slice `outputsChatRoutes` — `GET /outputs` (list of the output folder) and
  `GET /outputs/file?path=<rel>[&inline=1]` (the file via the checked descriptor, `nosniff`, active types in the sandbox
  CSP, `private, no-cache`). GET only. The computation lives in `../runs/outputs-view.js`. Guard
  `server/backend/test/outputs-view.test.js`.
- **Ultracode** (`ultracode.js`): `ultracodeFollowUp(chat, fields)`, the ONE ultracode rule. Effort level and ultracode
  are two INDEPENDENT axes: the rule only normalises the toggle (`chats.ultracode`) to 0/1 and never touches level, model
  or provider. Every write path passes through it (`chats/routes.js`, `chats/creation.js`, `runs/routes.js`,
  `workflows/driver.js`, `workflows/triggers.js`, `workflows/graph-start.js`, `scheduled/routes.js`). Guard
  `server/backend/test/ultracode-rule.test.js`.
- **"Auto" is gone** (`auto-gone.js`): the one-time migration `migrateAutoChats` (called from `server.js` after the
  provider migration; marker `migration.effort_auto_gone` in `app_settings`): every chat without a level gets ONCE the
  level it really ran with (Claude/Codex: the value from `~/.claude/settings.json` / `~/.codex/config.toml`, else the
  catalog level of its model; third-party providers: the default level plus a message of role `hint`; a model without
  levels keeps `""`).
- **Helpers** (`helpers.js`): `artifactSiblings` (the other chats of the same folder, with which artifacts are shared
  READ-ONLY), `artifactSource` (source chat of an artifact access: own or sibling, else `null`) and `folderContextChanged`
  (a context file change to all chats of the folder).

**The archive at these routes:**
- **Write lock:** after the 404 line and BEFORE the sub-table `chatRoutes` answers an archived chat with 409
  `archiveLock()` unless `archiveAllowed(sub, m)` admits the request — every `GET`, `DELETE ""`, `PUT /archive`, `POST
  /stop` (the emergency valve), and the stop of a dynamic workflow and a graph workflow. Every future sub-route is
  thereby locked on its own. Because `chatRoutes` reads the chat BEFORE the body, the sub-slices of this file check a
  SECOND time after `await readBody(`/`await readRawBody(` (`archivedNow`, fresh from the DB); an exception carries the
  comment `// archive: <reason>` at the body await. `archive.test.js` counts both in the source. The second check applies
  to THIS file only — the body paths in `runs/`, `channels/` and `workflows/` start a run (which restores the chat) or
  come via MCP from the running chat. The same allowlist applies to a read-only chat (`runs/only-readable.js`); a manager
  chat has its own (`runs/manager-lock.js`).
- **Folders:** `chatFolderRoutes` carries `GET`/`PUT /archive` and `DELETE ?permanently=1`. The pre-check names what the
  NEXT action affects: on an active folder `chats` = the chats archiving would take along (`store.chatsInFolder`), on an
  archived one exactly those `?permanently=1` deletes (`finalSet` — ONE function for confirmation and deletion);
  `contextFiles` in both cases, `null` if counting fails (`contextFilesCount` — never a guessed 0). An active chat with open
  work or a non-archivable chat in the folder (`folderLocks`, reason `not_archivable`, way out `PATCH {folderId: null}`)
  yields 409 and nothing changes. `?permanently=1` only works on an archived folder (else 400), any other value is 400.
- **Genus:** `POST /api/chats` refuses a folder of another genus (400), `PATCH folderId` likewise and also every
  non-archivable chat (in: no; out with `folderId: null`: always). The fork (`runs/routes.js`) takes over the genus of its
  original and with it its folder; a non-archivable chat is a 400 there (`genus.js:forkRefusal`).
- **Child chats of background graph workflows:** a child chat (row in `graph_starts` with `child_chat_id`) appears in no
  chat list, `GET ""` carries `parentChatId`, `archivable` excludes it, and the orchestrator's archive is 409 while a child
  waits or runs. `DELETE ""` on the orchestrator first calls `workflows/graph-start.js:stopKindRuns` (at most 15 s; if one
  is still stopping ⇒ 409), checks again and then closes.
- **Lists:** the archive side at `GET /api/chats` and `GET /api/chat-folders` is read via `runs/archive.js:archivePage` —
  only a MISSING parameter means "active only", an empty or unknown one is 400.
- **No empty chats in the lists:** a chat without a row in `messages` AND without a queued input (`run_inputs`) appears on
  no side of `GET /api/chats` and does not count in `chatCount` of `GET /api/chat-folders`; `GET /api/chats/:id` still
  returns it (a draft). The filter is an OPTION (`onlyWithMessage`) at `store.listChats`/`chatFolderCounts`, set ONLY at
  these client routes — the agents' tools and the delete set of a folder still read every chat. Guard
  `server/backend/test/chat-list-without-empty.test.js`.
- **Project switch mid-turn:** `PATCH projectId` is ALLOWED while a turn runs and beside live subagents or dynamic
  workflows — the switch applies from the next turn. The running turn is pinned to its project (`runs/instance.js:pinTurn`)
  and counts toward the idle state of its old project; the fence admits the calls from the instance of a live run to the
  routes of THIS chat (`projectbox/fence.js`). The PATCH marks the turn (`turnProjectSwitched`) — the next turn carries
  ONE silent hint where the previous one ran. Guards: `server/backend/test/project-lock.test.js`,
  `server/backend/test/fence.test.js`.

**What does NOT live here:** runs — `doRun`, queue, questions, approvals, limit gates, system prompt — live in `runs/`;
the persistence of chats, folders and messages in `store/chats.js`; the event stream per chat in `runtime/sse.js`.

**Terms → file:** capture as a message → `captures-show.js` · sibling chats, shared artifacts, folder context →
`helpers.js` · chat folder, chat list, history, attachments, artifacts, stream → `routes.js` · archive of a chat or folder,
write lock, delete set of an archived folder → `routes.js` · creation → `creation.js` · genus, archivable, forkable →
`genus.js` · delete permanently, the closing path → `erase.js` · CLI sessions of a deleted chat → `sessions.js` · archive
a chat (route and tick) → `archive.js` · auto-archive, setting and cycle → `auto-archive.js` · history window →
`log-window.js` · open work, restore, event `chat_archive` → `../runs/archive.js`.

**The most common questions:**
- May a chat read another chat's artifacts, and which? → `helpers.js:artifactSource` / `helpers.js:artifactSiblings` (only
  the same chat folder; writing always happens in the own chat).
- Where does a new sub-route of `/api/chats/:id` go, and why does an unknown sub-path answer 404 instead of hanging? →
  `routes.js:chatRoutes` (the sub-table; a new sub-slice is named `*ChatRoutes`, ends with `return NEXT;` and is entered
  there — `tools/check/lib/tree-rules.mjs` compares declaration and registry). A new WRITING sub-route is 409 on an
  archived chat on its own (`routes.js:archiveAllowed`); if it reads a body and then writes without a run, it calls
  `archivedNow(id)` after the await — or carries `// archive: <reason>`, otherwise `archive.test.js` is red.
- What happens on deletion to a chat's subagents that outlived their turn, and where does a new leftover of a chat go? →
  `erase.js` (closes every open core of the chat via `runs/agents.js:closeAgentsOfTheChat`, then records, silent hints and
  the output folder); a new leftover belongs there, not in one of the callers.
- What does "delete permanently" delete on an archived folder, and where does the confirmation get its numbers? →
  `routes.js:finalSet` (the same set for `GET …/archive` and `DELETE …?permanently=1`) and `routes.js:contextFilesCount`
  (`null` = unknown); deletion per chat via `erase.js:deleteChatPermanently`.
