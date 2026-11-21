# `runtime/` — runtime and basic HTTP tooling

**What lives here:** basic tooling with no domain knowledge. Most files are leaves (`node:*` and at most another file of this
folder); instances come in as objects from the caller, never from the store.

| File | What it does |
|---|---|
| `http.js` | Sending a response (`send`, compressed from `COMPRESS_FROM_CHARACTERS` on), reading the body (`readBody` with `BODY_MAX`, `readBodyOrEmpty`, `readRawBody`), download and range request (`serveDownload`, `serveRanged`, `supplyFile`), static files (`serveStatic`, `MIME`, `safeFileName`, `attachmentMime`, `dispositionHeader`), and the dispatcher's sentinel `NEXT`. |
| `sse.js` | Event streams per chat (`streams`, `sse`) and global (`broadcast`), the route function `eventStreamRoute` (`GET /api/events`: the global stream for the sidebar, initial state `running` + dynamic workflows + browsers). The run state comes in through the setter `setRunState`. |
| `heartbeat.js` | `HEARTBEAT` (`event: ping` + `data: {}`, no `id:`) and `HEARTBEAT_MS` (25,000) — ONCE for all event streams: `sse.js`, `../browsers.js` (screencast viewers), `../terminal.js`. |
| `loop-watch.js` | The event-loop watch: `startLoopWatch({ file, thresholdMs, tickMs })` measures the lateness of its own tick (500 ms) and, from 2 s of blocking on, writes ONE line `{ at, blockedMs, rssMb, heapMb, open }` to a file on the volume (survives the container's replacement by the gateway) and to the log; `open` are the open HTTP requests, newest first (`requestBegin`/`requestEnd` in the dispatcher); `capture` is the main thread's stack DURING the block (see `loop-stack-worker.js`). Only started with the ops marker. |
| `loop-stack-worker.js` | The stack watchdog of the watch, a worker thread: reads the tick's heartbeat in shared memory and, when it is older than `CAPTURE_MS` (1 s, at most once per `CAPTURE_GAP_MS`), takes ONE stack of the main thread through `inspector` (`connectToMainThread`, `Debugger.pause`) plus, on Linux, the main thread's kernel state and `wchan` while it waits. `pausedAfterMs` small = a synchronous JS stretch, large = a blocking native call (the stack then shows its JS caller). Guard: `server/backend/test/loop-stack.test.js`. |
| `process-watch.js` | B's policy for errors nobody catches: keep running and log loudly. Registered ONLY in `server/backend/headless.js` after a successful start (the reasoning is in the file header). |
| `origin.js` | The origin check `originVerdict(req.headers)`: locally only an IP literal or `localhost` as Host (DNS rebinding), a present Origin exactly `http://<Host>`, Sec-Fetch-Site only `same-origin`/`none`; otherwise 403. In server mode only the Host rule applies (the gateway rewrites Host and passes the public Origin through). |
| `inProject.js` | The ONE start function of the project containers (see below). |
| `git-run.js` | The ONE starter of the management git (see below). |
| `real-path.js` | The real location of a path and access through a checked descriptor (see below). |
| `target.js` | The target of a connection the backend opens on behalf of an instance, and the watch against B's own addresses (see below). |
| `fileAccess.js` | File access of a copy through its container (see below). |
| `fast-open.js` | Quick Open (⌘P) like VS Code: prefilter, score and order — the same computation as `web/src/lib/fuzzy-scorer.ts`, bound by `web/test/quick-input.test.mjs`. |
| `upgrade-way.js` | The ONE classification of WebSocket upgrades: `upgradeWay(rawUrl)` → "tunnel", "stream", "devtools" or `null`. |
| `response-header.js` | Response headers of an instance without Set-Cookie and relatives; the filtered upgrade handshake. |
| `serving.js` | How a foreign or agent-written file is served under the cbase origin: `nosniff` always, a CSP sandbox for every non-passive type. |
| `image-dimensions.js` | Width and height of an image attachment from its file header. |
| `upload-stamp.js` | The upload stamp: open chunk requests per project and operation; feeds `busy` of `/api/runs/active`. |

**`inProject.js` — the ONE start function:** `inProject(inst, cmd, args, opts)` is, without an instance, EXACTLY
`spawn(cmd, args, opts)`; with an instance it is `docker exec -i [-t] -u agent [-w cwd] [-e NAME …] <container>
/usr/sbin/cbase-wrapper --pgid-file <runtime>/processes/<id>.pgid -- cmd …`.
- The environment is an allowlist (`envAllowlist`: what the caller changes or adds relative to `process.env`, plus `ENV_TOGGLE`,
  plus `envAlways`); values never appear in argv. `envEmpty` puts names with an EMPTY value into argv as `-e NAME=`.
  `B_OWN_ENV` (B's package caches) never goes into a project container.
- The returned docker child carries the marker `inProject` and an overridden `.kill`: first the process group in the container
  (`docker exec … kill -<SIG> -- -<pgid>`, caught up while the pgid file is missing, cap `CBASE_IN_PROJECT_KILL_MS`), then the
  docker child.
- Escalation: the docker child dies on TERM at once, so a TERM to the group plans its own look-back after
  `CBASE_IN_PROJECT_ESCALATION_MS` (default 3000): `kill -0 -- -<pgid>`, and if the group is alive, `kill -KILL`. HUP (pty) does
  not escalate. `openEscalations()` counts the pending ones (tests wait for that, never for a duration).
- For the pty: `inProjectCall` + `inProjectKill` (terminal.js).
- Service: `opts.service = { log }` turns it into `docker exec -d` with `--log <file> --exit <processes>/<id>.exit` for the
  wrapper; the child carries `inProject = { identifier, container, pgidFile, exitFile, log }` and NO overridden `.kill` —
  `services.js` handles end and stop through the two files.
- Pause barrier: if the seam carries `frozen` and `childAfterThaw` (only together), a start into a frozen container goes
  through `childAfterThaw` — the caller holds its child at once, the docker CLI begins only after the thaw; a kill BEFORE the
  release only ends the waiting shell.
- `withGitWrapperFront(opts)` puts `GIT_WRAPPER_FOLDER` first in `PATH` for starts without an instance when the ops marker is
  set, so a run in B that calls `git` goes through the management git's wrapper too.
- docker program, runtime folder and container name come through `setInProjectSeam`, set in `server.js:startServer` — unset, a
  start WITH an instance throws.
- Guards: `server/backend/test/inProject.test.js`, `projectbox-pause.test.js` and `in-project-start-places.test.js` (the table
  of ALL start places; a NEW start place needs a row there, a new child process in the start paths a row with a reason).

**`git-run.js` — the ONE starter of the management git:** `gitRun(inst, cwd, args, { timeout, stdin, env, maxBuffer, fallback })`
calls, without an instance, ONLY `fallback()` — the calling file's own starter (without `fallback` it throws); with an instance
it runs `git` via `inProject` as agent in the project container with `GIT_TERMINAL_PROMPT=0` and returns
`{ code, signal, stdout, stderr, cap }` (does not throw on exit ≠ 0). `commandRun(inst, cwd, cmd, args, opts)` is the same for
other commands; it refuses without an instance.
- Caps that report themselves: deadline (`GIT_RUN_CAP_MS` 120 s, per call `timeout`) and output (`OUTPUT_CAP` 16 MB) end the
  command through inProject's `.kill`; the message is in `stderr`, `cap` says which. `withoutDeadline: true` means NO timer;
  `signal` (AbortSignal) ends the group, result `aborted: true`; `asUser: "root"` (commandRun only) for root steps.
- `accessAsEnvironment([{ host, access }])` — a network command's git access as ENVIRONMENT, in list form only: it resets the
  inherited helpers, then sets one helper per host that reads user and token from `CBASE_GIT_USERNAME_<i>`/
  `CBASE_GIT_PASSWORD_<i>` — each token ONLY to its host, including the port. Every entry carries a rejection marker
  `CBASE_GIT_REJECTED_<i>` so git-lfs does not loop with the same wrong access after a 401.
- `readingArgs`/`READ_TOGGLE`/`READ_SH`: the switches with which the read paths run no programs from the repo.
- `containerStands(r)` / `CONTAINER_STANDS` is the ONE pattern for "the project container is down"; "is paused" is a SEPARATE
  word (`containerPaused(r)`): frozen means wait, not wake.
- `runningCommandsIn(container)`, `commandsPast(container)`, `waitingForCommands(container)`: which commands are running IN the
  container — the freeze of a copy waits for them before `pause`.
- `hostFromAddress`, `networkHosts`, `lfsFetch`: hosts and LFS for cloning.
- Guards: `server/backend/test/projectbox-git.test.js`, `git-run-deadline.test.js`, `projectbox-git-worktree.test.js`,
  `git-read-paths.test.js`.

**`real-path.js` and `target.js` — what the backend in B does ON BEHALF of an instance:**
- `realPath(p)`/`realLocation(p, roots)` determine where the file system really ends up (realpath of the deepest existing
  ancestor, a symlink without a target counted with its target, ELOOP after 40 hops). `realRoot(w, anchor)`: a root under a
  trusted anchor (project folder, runtime folder) counts as `realpath(anchor) + relative rest` and does not count if a path
  part in between is a symlink. For a COPY: `realRoot(…, { strict })` and `withLocks(realW, lock)`.
- Access THROUGH THE DESCRIPTOR: `descriptorLocation`, `readInArea` (with `{ maxBytes }`: `ETOOLARGE`), `readBeginningInArea`,
  `editInArea`, `writeInArea`, `statInArea`, `entriesInArea`; a location outside throws `code: "EOUTSIDE"`. For the code view:
  `inFolderInArea`, `folderContentInArea`, `createFileInArea`/`createFolderInArea`, `renameInArea`, `removeInArea`,
  `traverseWithoutReferences`. `openFileWithoutReference` opens a REGULAR file whose last part must not be a symlink.
  B's own writers in the runtime folder use these primitives through `../runs/runtime-write.js`.
- `targetFor(url, inst)` maps `localhost`, 127/8, `::1`, `0.0.0.0` (and their equivalent spellings) to the instance's IP,
  otherwise `null`; an instance without an IP throws. `connectionTo(target)` is the matching `createConnection`,
  `requestInProject(url, init, inst)` a small fetch over `http(s).request` (redirects by hand, every hop mapped anew).
  `networkOptions(url, inst)` is the switch of the callers, and for every host that is NOT mapped the **watch**:
  `lookupInProject` sits as `lookup` in net.connect and rejects as soon as an answer is `addressOfB` or lies in ANOTHER
  project's network.
- Guards: `server/backend/test/network-target.test.js`, `tool-runtime.test.js`, `engine-in-project.test.js`, `channel.test.js`,
  `runtime-write.test.js`, `runtime-write-guard.test.js`.

**`fileAccess.js` — file access of a copy:** a copy's overlay view is mounted only IN the copy's container; whatever runs in B
(the loop engine's file tools, the code editor, channel files, project memory) would see the main instance there. So every
access to a path under a COPY's project folder goes through its container: one Node program per call via `commandRun` (`read`,
`readSeveral`, `write` with `expect` = sha256 of the expected content, `edit` as compare-and-swap, `stat`/`list`/`create`/
`name`/`erase`/`stamp`, tree walks `glob`/`grep`/`search`/`names`/`fast` — only the result comes back). NO fallback to B: a
failed call throws `FileAccessError`. `fileWay(inst, abs, { project, runtime })` decides per path "copy" or "b" (the runtime
folder stays in B, the deeper anchor wins; without a copy always "b"). Guards: `server/backend/test/fileAccess.test.js`,
`tool-runtime-copy.test.js`, `files-in-copy.test.js`.

**The dispatcher:** `http.js` exports the sentinel `NEXT`; every route function (`export async function <name>Routes(ctx)`,
first line `const { req, res, url, p, m } = ctx;`, last line `return NEXT;`) returns it when it is not responsible, and
`server.js` runs `for (const route of ROUTES) if ((await route(ctx)) !== NEXT) return;` — any other return value, including
`undefined` from `return send(res, …)`, means "answered". If the `return NEXT;` is missing, the request hangs instead of a 404
(guards: `server/backend/test/dispatcher.test.js`, `tools/check/lib/tree-rules.mjs`).

**What does NOT live here:** no domain — no schema, no domain routes (those are in `../<folder>/routes.js`), no instance row
(the run instance is read by `projectbox/run-instance.js`), no runs. `runtime/` imports nothing from `runs/` and nothing from
`projectbox/` (`server/backend/test/import-direction.test.js`); what it needs from there comes through setters at boot
(`setRunState`, `setInProjectSeam`).

**Terms → file:** response, body, cap → `http.js` · download, range request (206), static file, MIME → `http.js` · route
sentinel `NEXT` → `http.js` · event stream (SSE) per chat and global, `/api/events` → `sse.js` · heartbeat → `heartbeat.js` ·
start in the project container, wrapper, pgid file, group kill, escalation TERM → KILL, env allowlist → `inProject.js` ·
management git, git access per host, read switches → `git-run.js` · real location of a path (symlinks resolved), trusted
anchors, access through the checked descriptor → `real-path.js` · localhost of an instance, connection to its IP, watch
against B's addresses → `target.js` · file access of a copy → `fileAccess.js` · upgrade classification → `upgrade-way.js` ·
response headers of an instance → `response-header.js` · serving foreign files, CSP sandbox → `serving.js` · origin check →
`origin.js` · uncaught errors → `process-watch.js` · event-loop blocks → `loop-watch.js`.

**The most common questions:**
- How does a route read its JSON body, and where is the cap? → `http.js:readBody` (`BODY_MAX` 5 MB; only under a JSON content
  type, otherwise 415); raw and larger (uploads) → `http.js:readRawBody`; a body that may be missing → `readBodyOrEmpty`.
- How does an event reach the open chat or the sidebar of all chats? → `sse.js:sse` (per chat) / `sse.js:broadcast` (global).
- Why does a stop end the run in the project container although a killed `docker exec` ends nothing? → `inProject.js:inProject`
  (the overridden `.kill`: group kill via the wrapper's pgid file, then the docker child).
- Why does a video/download route answer 206 with `Cache-Control: private`? → `http.js:serveRanged` (Safari loads in byte
  ranges; without `private` a CDN caches publicly at the edge). With `{ fd }` it serves through an already opened, checked
  descriptor.
- How does a route serve a whole file? → `http.js:supplyFile` (open before the headers, `Content-Length` from fstat,
  `pipeline`) — never `createReadStream(…).pipe(res)`.
