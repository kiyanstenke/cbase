# `devtools/` — developer tools (code, git, terminal, debugger, LSP)

**What lives here:** `code-route.js` — `codeRoute(root, sub, m, req, res, url, opts)`, the code view of a root directory: git
tree and actions (`/git/*`: commit, stage, diff, pull, push, stash, merge, rebase, blame, log, worktrees, submodules, accesses
`/git/creds`), files (`/files/*`: tree, read, download, write, create, rename, copy, search, find, `/upload`), debugger
(`/debug/launch`), terminal (`/terminal`) and the editor's language service (`/lsp/*`, the core lives in `../lsp/`). It stays a
function with a `true|false` return ("handled here"), not a route function, and is the ONLY implementation of these branches —
workspace AND project level run through it. `opts.notFound` carries the wording for a missing root (`/files/tree`,
`/terminal`, `/debug/launch`) because the project level says "project path not found" and the workspace level "path not
found" — a parameter, not a common denominator.

**`browser-names.js`:** `describeProfile(dirName)` — name and workspace of an agent browser for the scanner in `../browsers.js`
(`startAgentScan`, wired in `server.js`): "chat-<chatId>" is named like the chat, "chat-<chatId>-agent-<agentId>" like the
subagent (`store.readSubagent`: description, else name) or the workflow agent (`dynworkflows/run.js:dynTrees`: label, else
"<workflow> #n"), both in the chat's workspace; a workspace profile like the workspace. The identity itself is computed by
`../browser-profiles.js:profileParts` without the DB. Guard: `server/backend/test/browser-agent-choice.test.js`.

**`user-browser.js`:** the browser of a chat — human and main agent work in it. `userBrowserTarget` computes scope, profile
and instance of the own browser of the pages (workspace `ws:<id>`; project `proj:<id>[@copy-<name>]` in the instance) for
`POST …/browser/ensure` of both levels — for a chat its profile is one of the login stocks. `chatBrowserTarget` the browser of
a chat (`chat:<id>`, profile `chat-<id>` at the chat's location, the chat's instance, stocks and initial fill).
`userBrowserApplies` (ordinary Coding chat, full toolset, no open graph workflow), `CHAT_BROWSER_SENTENCE` (the fixed
sentence in the system prompt), `userBrowserForRun` (at turn start in `runs/do-run.js`: ensure — starts it if it is not
running —, hold via `browsers.js:holdForAgent` against the idle timeout, address `http://127.0.0.1:<debugPort>` for
`writeMcpConfig` → `browser.cdpEndpoint`; if the start fails: a hint to the model in the same turn and a notification in the
bell, the turn runs in the Playwright profile), `closeChatBrowser` (archiving, deleting, project change) and the route
`POST /api/chats/:id/browser/ensure` (`userBrowserChatRoutes`, sub-slice of `chats/routes.js`; 429 at the cap, 403 for the
token of an instance). Guards `server/backend/test/agent-user-browser.test.js`, `server/backend/test/chat-browser.test.js`,
`web/test/chat-browser.test.mjs`, `web/test/browser-choice.test.mjs`.

**`terminal-folder.js`:** the start folder of a new terminal (`cwd` of `POST …/terminal`) — inside the root lexically and at
its real location, checked where the shell runs. Guard `server/backend/test/terminal-folder.test.js`.

**Terminal stream:** `GET /api/terminal/:id/stream` resumes instead of repeating — every data event carries an id and the
position reached; a subscription with the header `Last-Event-ID` (browser, by itself) or `?from=` (iOS; the header wins) gets
only the rest; EVERY full fetch (no point, point before the start of the buffer, unreadable) gets the whole buffer marked as
replacing — the client then resets; the first line always goes out, even empty (it sets the position); the heartbeat
(`../runtime/heartbeat.js`) carries no id. The protocol is in the leaf `../terminal-stream.js`, sessions and tick in
`../terminal.js`. Guards: `server/backend/test/terminal-stream.test.js`, `web/test/terminal-stream.test.mjs`,
`web/test/sse-rows-ios.test.mjs`.

**Routes (`routes.js`):**
- `devtoolRoutes` (in `ROUTES`) — `/api/terminal/available`, `/api/terminal/:id` (`/exists`, `/stream`, `/input`,
  `/resize`), `/api/browsers` and `/api/browsers/:id` (`/stream`, `/input`, `/act`) including the DevTools proxy
  `/api/browsers/:id/devtools/*` (`proxyDevtools`), `/api/lsp` (the agents' language service, see below),
  `/api/debug/available` and `/api/debug/:id` (`/stream`, `/command`, `/breakpoints`, `/evaluate`), `/api/pick-folder`.
- `codeProjectRoutes` (sub-slice of `projects/routes.js:projectRoutes`, `sub` under `/api/projects/:pid`) — answers only
  `/browser/ensure` itself (profile per project, `codeRoute` does not know that) and passes everything else to
  `codeRoute(proj.path, …)`: `/git/*`, `/files/*`, `/upload`, `/debug/launch`, `/terminal`, `/lsp/*`; `true` means answered
  (`return`), `false` runs into `return NEXT;`. For every `sub` outside `CODE_ROUTE_PREFIXES` it returns `NEXT` BEFORE
  computing the target instance (an unreadable instance would otherwise turn `/context/…` into a 409).
- `vscodeTunnelRoutes` — `GET /api/vscode-tunnel`, `POST …/start|stop|logout`; ONE response shape (`tunnelResponse`), which
  ONLY in project box operation additionally carries `projects` (per converted project its ready instances with container
  name from the identifier, never the DNS name) and `starting`. Guard `server/backend/test/vscode-projects.test.js`.

**The target instance:** `targetInstance(ctx, chatId)` determines the instance of every project route — with a fence token
the token's (a `?chat=` must lie in it, else 403; if the fence value lacks something, 403 as well, never main), otherwise the
chat's binding (`runs/instance.js:instanceOfChat`), otherwise main. `codeRoute` passes it to terminal, debugger and git, and
for a COPY `files-in-copy.js` answers the file routes through `runtime/fileAccess.js` (overlay view only in the copy
container). The instance choice of the Code tab — `?instance=<projectId>/<instance>` on every project route of `codeRoute`
(`selectedInstance`, `withSelectedInstance`): missing or empty changes nothing; `<id>/main` is main; a copy its instance, an
unknown one 404 `UNKNOWN_INSTANCE` with the identifier (never a fallback to main); no identifier or that of another project
400 `INSTANCE_INVALID`; with `?chat=` both must name the same instance (else 400); from a project network the token decides —
another identifier is 403 `INSTANCE_FOREIGN`. The response of a git call in a copy names it on the project level
(`instance: "copy-<name>"`, `code-route.js:gitResponse` — main never carries the field). Guards
`server/backend/test/fence-instance.test.js`, `files-in-copy.test.js`, `copy-worktrees.test.js`.

**Terminal and debugger under a lock:** both FIRST compute their instance (with `tag: "chat:<id>"` the chat's, with
`?instance=` as required equality — `routes.js:withChoice`, else 400) and then ask the lock of THAT instance
(`opts.sessionLock` → `routes.js:terminalLocked`: project lock, open relocation, a copy that is not ready) — 409
`{ code: "LOCKED", reason }`. Without a chat tag the server assigns the tag `proj:<id>` or `proj:<id>@copy-<name>`
(`opts.sessionTag` → `projectbox/idle.js:projectTerminalTag`), so idle counts a terminal or debugger of the Code tab with ITS
instance. A terminal with the tag of an archived chat is 409. Guards `project-lock.test.js`,
`project-terminal-copy.test.js`.

**In the project container:** on the project level `routes.js` passes the instance as `opts.instance` to `codeRoute`
(→ `debugLaunch`, `createTerminal`) and to `ensureUserBrowser`; on the workspace level it stays `null`. Without an instance
row (or without the ops marker) every start stays a local spawn; with it `../runtime/inProject.js` starts in the container.
Connections go via the IP of the instance (`../browsers.js`, `../debug.js`); an instance without an IP starts nothing. Guard
`server/backend/test/projectbox-network-paths-browser.test.js`.

**The project repo:** git tree (`/git`) and git actions do not see it — `../git.js` descends past its root and delivers the
code repos below (`projectRepos`/`findRepos`), `resolveRepoRoot` rejects it as a target. Guard
`server/backend/test/projectRepo.test.js`.

**Management git in the project container:** every git call of the code view carries the instance — fixed on the project
level (`opts.instance`), per repo on the workspace level (`opts.gitInstanceSource`, the factory
`../projectbox/git-assignment.js:gitInstanceForWorkspace`, asked only by a `/git` route; terminal and debugger of the
workspace level stay in the backend). The git view gets the SITUATION of the instance via the path of a turn
(`gitSituation`: `../runs/project-lock.js:startLock`): while a turn would have to wait, `/git` answers `starts: true`,
`reason`, `notice` instead of `{ repos: [] }`, without a docker call; a container in `error` or a failed read is `error`
(project level at the top of the response, workspace level per project under `projects`). A STOPPED container is woken by
whoever registers via `setGitWakeup(fn)`; a PAUSED one is NEVER woken (`reason: "frozen"`). Every `/git/*` action against a
not-ready instance answers **409** via `failed(e)` with the same situation; `error` always carries the text for clients that
read only that. A throw of the instance source is a response, not a 500. Guards `server/backend/test/projectbox-git.test.js`,
`projectbox-pause.test.js`.

**The limit of the file paths:** `/files/*` and `/upload` run in the backend. For a path of a converted project
`fileLimit(root, opts)` gives the paths of `../files.js` the real roots of its instance (project folder and runtime folder,
`../runs/runtime-limit.js:areaOfTheInstance`), and they then go through `../runtime/real-path.js` on the opened descriptor:
no link out of the project is followed, a FIFO does not stop the backend. Workspace level: the factory is asked per path
part FROM THE ROOT DOWNWARDS (the first part in the area of an instance is the project folder). If the source throws, 409.
Guard `server/backend/test/engine-in-project.test.js`.

**A copy that is not ready:** `routes.js:writeLockCopy(inst)` reads the instance row of a COPY fresh from the database and
returns `{ identifier, state }` if it is not `ready`; `codeProjectRoutes` passes it as `opts.writeLock` to `codeRoute`, which
stays domain-free. Then every path under `/files`, `/upload` and `/git` (without `/git/creds`) except `COPY_READING` answers
409 `COPY_NOT_READY` — closed where not explicitly reading: a new path is locked until it is listed there. Main never asks
the lock. Guard `server/backend/test/files-in-copy.test.js` — the paths come from the source of `code-route.js`.

**The write lock of setup and layout:** `opts.setupLock` (header of `code-route.js`) judges AFTER the body: every write path
first reads the whole body, passes it on via `againReadable` and THEN asks the lock — 409 `SETUP_RUNNING` (or
`LAYOUT_RUNNING` while the layout writes, `projectbox/setup/status.js:layoutWriteLock`). For `/git` the situation is wrapped
additionally: it asks the lock once more right before the first git call. On the workspace level (`opts.setupPerPath`)
`pathsTheRequest` computes the paths LIKE the paths that write. Guards
`server/backend/test/project-setup-findings.test.js`, `layout-procedure.test.js`.

**Language service:** the editor asks `POST <apiBase>/lsp/<action>` (`code-route.js`, target of the file via `lspTargetFor`:
project level the project of the route in its instance, workspace level the project under the folder of the file, else
`no_project`) — the computation is in `../lsp/` (README there), the language server runs in the instance (also in a copy),
the backend writes nothing for the editor. `/api/lsp` (agents, `routes.js`) runs over the same core
(`lsp/agents.js:agentAction`, `lspAgentTarget`/`lspCopyTarget` here): from a project container the fence token determines
the instance, the file must lie under the project folder, and the area of the instance limits reading and writing
(`../lsp/limit.js`). Guard `server/backend/test/language-service-fifo.test.js`.

**What does NOT live here:** the work itself — git (`../git.js`), files with root limiting (`../files.js`), terminal
(`../terminal.js`), debugger (`../debug.js`), language service (`../lsp/`), the agent's browser (`../browsers.js`,
`toolchain/playwright.js`). `codeRoute` has two callers: `workspaces/routes.js:tailWorkspaceRoutes` (`root` = workspace path)
as the LAST branch of the workspace family, and `routes.js:codeProjectRoutes` here (`root` = `proj.path`, plus
`opts.notFound`).

**Terms (→ file):** code view, git tree, git action, file tree, upload, terminal session, debug start, language service of
the editor → `code-route.js` for BOTH levels · terminal, agent browser, DevTools proxy, LSP for agents, debugger, folder
picker, VS Code tunnel → `routes.js`.

**The most common questions:**
- Why does a git route get 400 with `authRequired`, and where does the access come from? → `code-route.js:codeRoute`
  (branches `/git/commit|pull|fetch|push` via `workspaces/git-auth.js:gitAuthCtx`, errors via `gitErrPayload`).
- How does a file get from the folder into the browser, also as a video with a range request? → `code-route.js:codeRoute`
  (branch `/files/download` → `runtime/http.js:serveDownload`).
- Where does the chain end if no branch matches? → `codeRoute` returns `false` (`handled`), the caller continues its chain —
  on the project level `return NEXT;` in `codeProjectRoutes`, on the workspace level the next branch of
  `tailWorkspaceRoutes`.
- Why does the same route answer differently per level when the folder is missing? → `routes.js:codeProjectRoutes` passes
  `opts.notFound`, the workspace level keeps the default. Both wordings are pinned individually in
  `server/backend/test/code-scopes.test.js` — they are intended.
