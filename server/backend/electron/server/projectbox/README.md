# `projectbox/` — project containers

**What is here:** the substructure of the project containers: one container per project, with its own dockerd, inside the
user container. Everything a converted project needs from the backend lives here — creating, starting, stopping and
recreating its container, restoring its stack after a restart, the API fence for calls from the project network, names,
tokens, deletion, and the relocation of an existing project into its container.

## Terms

- **B** — the user container: the backend process and the outer docker daemon it talks to.
- **Project container** — `cbase-p-<projectId>`, image `cbase-projectbox:latest`, with an inner dockerd; "inside" always
  means inside it. Its network is the **project network** (a /24 out of level 2), its data the volume from
  `creation.js:volumeName`.
- **Instance** — one running form of a project: `main` (the project container) or a copy `copy-<name>` (a stack copy with
  its own container). The row lives in `project_instances` (`store/project-instances.js`); its states are `create`,
  `start`, `ready`, `recreate`, `relocation`, `clearAway`, `stop`, `stopped`, `error`. The working states hold `busy`.
- **Converted** — a project with an instance row that carries `converted_at`. Only then do its processes start in the
  container; a project without a row runs in B as before.
- **Ops marker** — `ops.js:projectboxOps()`: true EXACTLY when the backend runs in a user container with nested docker.
  Without it nothing under `projectbox/` calls docker; new routes answer 404 with `ONLY_IN_OPS`.
- **Desired state** (`desired`) — the snapshot of what ran inside (containers with state, native services), written at
  server end and by the desired tick, restored after a start.
- **Restart grace** — the pass after every start of B that picks up what a crash or restart left half done (hooks
  registered in `server.js`).
- **Fence** — the rule table for requests that come from a project network (`fence-table.js`, `fence.js`).
- **Helper** — a short-lived container from the projectbox image for root work between volumes (`helper.js`).
- **Heavy load** — ONE lock per B for heavy disk operations (`heavyLoad.js`).
- **Journal, turnaround, return path** — a multi-step procedure writes each step BEFORE its effect (`journal.js`); before
  the turnaround an error takes the return path, from it on the procedure only goes forward.

## Map

| File | What | Guard |
|---|---|---|
| `ops.js` | The ops marker `projectboxOps()` (read at run time, never frozen at load) and the 404 wording `ONLY_IN_OPS`. No imports. | `projectbox-ops.test.js` |
| `docker.js` | The docker seam: `docker(args, { stdin, capMs, env, stdoutFile, maxBytes })` against the daemon of B and `dockerIn(container, args)` against the daemon INSIDE a project container. Only `spawn` with an argument array, never a shell string; a cap per call that says it is one (the default is an estimate — a call that hits it deserves a measured cap of its own) and a cap on the OUTPUT; without the ops marker no child starts (`NO_OPS`). `dockerKind` (the LIVING docker child, its lifetime belongs to the run), `dockerProgram` (for the pty), `dockerStream` (one long-lived child with a line callback, used for `docker events`). `pause`/`thawOut`/`thawAll` are the ONLY places for `docker pause`/`unpause`; while a container is frozen, `dockerIn` and every start through `runtime/inProject.js` wait for the thaw. Every `stop`/`rm`/`kill`/`restart` through `docker()` notes "cbase stopped this itself" BEFORE the child (`selfStoppedSince`) — `dockerKind`/`dockerStream` note nothing, so a stop through them is red in the guard. `advanceCap()` is the clock seam for tests. | `projectbox-ops.test.js`, `projectbox-pause.test.js`, `projectbox-stop-places.test.js` |
| `address.js` | `hostPort(host, port)` (IPv6 in brackets), `instanceIp(inst)` (THROWS without one — never a fallback to 127.0.0.1, where a service of B would answer), `urlWithHost(url, host)` for addresses a process inside reports about itself. No imports. | `projectbox-network-paths.test.js`, `projectbox-network-paths-browser.test.js` |
| `browser-network.js` | Two seams `server.js` sets: `foreignProfileLock` (whether the pid of a Chromium profile lock is alive in the namespace of its host name — unknown counts as alive, a lock older than the container start is dead) and `agentScanRoots()` (the profile roots per runtime location, with the instance IP; an unreadable instance sits out the round, never 127.0.0.1). | `projectbox-network-paths-browser.test.js`, `browser-profiles.test.js` |
| `devtools-ui.js` | The DevTools UI of a browser in a project container is served from B: a headless Chromium in B on a throw-away profile (`devtoolsSource`), started on demand and stopped when idle; the revision must match the one of the instance session, otherwise the proxy shows a hint. Only the WebSocket goes to the debug port of the instance. | `projectbox-network-paths-browser.test.js` |
| `instances.js` | The setter of the instance state `setInstanceState` (creates or changes, emits the instance event on every change of state, phase or error; `{ ifState }` makes it conditional in ONE update), `withProcedure` (the living procedure per instance, counted), `instancesRestartGrace` (working states without a living procedure ⇒ `error`; `relocation` is decided by the relocation), and the bookkeeping of half relocations (`relocationElsewhere`, `relocationWayOut`, `relocationResumeFailed`). After a change into a non-working state it calls the state wakeup. | `project-instances.test.js`, `instance-resolution.test.js` |
| `detection.js` | The connection of the service detection for the domain side, a leaf without imports (`projects/` imports projectbox/, never the reverse): `setServicesDetection`, `detectServices`, and the count of running detections per project. | `project-detection.test.js`, `import-direction.test.js` |
| `idle.js` | Lock and idle per project, the domain side of `runs/project-lock.js`: `projectLock(chatId, purpose, { projectId })` decides per instance state and purpose (wait, reject, error), `projectLocks(projectId, { reason })` takes the explicit lock of a relocation, recreation, deletion, freeze or layout — lock FIRST, then idle, ending the terminals of the project with a message; `wakeProject` starts what waited. Also the work lock of a single instance and the verdict "the server is shutting down". | `projectbox-idle.test.js`, `project-lock.test.js` |
| `cleanUp.js` | The root fallback when clearing a runtime folder: `removeAsRoot({ projectId, path })` for a root-owned leftover = `rm -rf` as root inside the container. Throws without the ops marker and for a path outside the runtime folder of this project. | `projectbox-rm-in-b.test.js` |
| `network-marker.js` | Reads the marker of the network separation: `networkSeparation()` → valid ONLY when the marker file written by the entry script matches the start time of the running PID 1 — one from an earlier start counts as missing. Without a valid marker no project container. | `projectbox-creation.test.js` |
| `run-instance.js` | The source of the run instance: `runInstance(projectId, instance)` = the mapped row EXACTLY when ops marker AND `converted_at` are there, otherwise `null`; a database error throws ("not readable" is not "not converted" — `null` would mean a start in B at the old path). `containerOf(inst)`: for main ALWAYS the stable name. | `instance-resolution.test.js` |
| `serverEnd.js` | The stop chain at process end, `projectboxServerEnd()`: per ready instance the snapshot `desired` (`desiredFromInspect`), then `stop -t 30`; frozen containers are thawed first. A row in the middle of a restore or in `error` keeps its old `desired`. | `projectbox-server-end.test.js` |
| `restore.js` | The restore after every start of B (`restoreRestartGrace`) and for a single instance (`restoreInstance`): marker, container, wait for the entrypoint, the desired containers in `depends_on` stages (`startStages`), native services, names — the phase of the row names the step. `runInstanceUp` is the ONE start sequence (also used by the relocation). `atReady` registers consumers for "an instance became ready". | `projectbox-restore.test.js`, `projectbox-start-up.test.js` |
| `recreate.js` | Recreating a project container when image or mount list differ from the desired ones, the container is missing or its entrypoint reports an error: `desiredActual` (PURE; without a desired value a TypeError — empty is not unknown), checked in the restart grace and at the start of a turn; a recreation that cannot run yet is earmarked and waits for the idle of the project (`recreateStatus`). | `projectbox-recreate.test.js` |
| `resumption.js` | The observer: a project or copy container that ends or starts BEHIND cbase's back (`docker stop`/`start` by hand, OOM, the daemon's restart policy) gets the restore. The source is `docker events` through `dockerStream`; `resumptionVerdict` decides per event (what cbase stopped itself is no resumption). Also the desired tick, which rewrites `desired` every minute and leaves it alone when the inside is unreadable or empty. | `projectbox-resumption.test.js`, `projectbox-stop-places.test.js` |
| `creation.js` | The creation, PURE: names (`containerName`, `networkName`, `volumeName`, per instance), fixed values (image, level 2, inner pool, block list, stop deadline), `selectSubnet`, `mountRules` (the ONE table of mounts) and `creationViolations` (what must never be in the arguments: no `--privileged`, no socket, no `-e NAME=VALUE`). What it needs from the file system it receives as a function. | `projectbox-creation.test.js` |
| `instance.js` | The creation procedure `createInstance(projectId, { state, … })`: preconditions WITHOUT docker and without touching the row, then docker, then row and phases only through `setInstanceState`; `waitForInside`/`checkInside` read the status file of the entrypoint. A precondition never changes the row — it only throws (`CreationError`). | `projectbox-creation.test.js`, `projectbox-scenario.mjs` |
| `hosts-file.js` | The block `# cbase-projects BEGIN … END` in /etc/hosts of B, pure except for the write: `withHostsBlock` replaces the block in place and leaves every other line byte-equal; a broken block is NOT repaired; `writeHostsBlock` writes with one write into the same inode (the file is a bind mount). | `hosts-file.test.js` |
| `names.js` | The names `<slug>.cbase`: assigned at creation and then FIXED in `project_instances.dns_name` (renaming a project does not change it — a name a stack already uses must not wander). `bringAlongNames()` assigns missing names and writes the block. | `projectbox-names.test.js` |
| `erase.js` | The deletion paths: `projectDelete` is the ONE way of both project delete routes — lock, idle, CLI sessions back to B, container, network, and only with `purge` volume and runtime folder; 409 during creation, relocation or recreation and for a converted project that is not idle. `deleteProjectbox` removes only what carries the label of this project. | `projectbox-delete.test.js` |
| `cli-home.js` | The CLI home per project (`<runtime>/home/.claude`, `.codex`, `.local`): `createCliHome` prefills the account fields once (no tokens, 0600), `enterCodexTrust` adds the trust entry, `copyLocal`/`localReferences` decide which `~/.local` entries belong to a project. Every writing function needs the ops marker. | `project-setup.test.js`, `session-transfer.test.js` |
| `vscode-server.js` | Clears old VS Code server versions in the `~/.vscode-server` of a project after every `ready` of main: a fixed number stays, plus the protected newest one and the one the client used last; what it did or why not is in the log. | `projectbox-vscode-server.test.js` |
| `vscode-upfront.js` | Fetches the NEWEST VS Code server version before the client pulls it (otherwise every update uploads it through the relay): restart-grace hook and a tick (`CBASE_VSCODE_UPFRONT_MS`, 0 = off), at most one cycle at a time, a tarball cache in B. Only with the ops marker. | `projectbox-vscode-upfront.test.js` |
| `projectRepo.js` | The project repo (the git repo of the project folder itself, excluding the code repos inside): search, first commit, hardening `GIT_HARDENING` for every git call on foreign trees. No route. | `projectRepo.test.js` |
| `token.js` | Address and token of an instance: `tokenFor(inst)` (random per identifier, created once per backend start, ONLY in memory — a restart invalidates every old one), `backendUrlFor(inst)` (the gateway of the project network), `mcpAccessFor(inst)`. | `fence.test.js` |
| `fence-table.js` | The fence table, PURE data without imports: per route family methods, pattern, rule (allowed · filtered · rejected), filter, body rule, reason and the MCP tools that use it. The NAME of a path parameter is its check. | `fence.test.js`, `fence-tools.test.js` |
| `fence.js` | The API fence. `fenceVerdict` (pure): a valid token ⇒ the scope of its instance, but only from the /24 of that instance; from a project network without a valid token ⇒ 401; otherwise as before. `checkScope` checks parameters, query and body against the scope; `FILTER` shortens lists to the scope and sets the header `x-cbase-fenced`. | `fence.test.js`, `fence-instance.test.js`, `fence-stacks.test.js` |
| `network-targets.js` | The network target of an instance `{ identifier, projectId, instance, ip, container }` — everything probe, port list and tunnel need: `instanceTarget`, `instanceTargets`, `networkTarget`. Same question as `runInstance`; a read error throws. | `instance-resolution.test.js`, `projectbox-network-paths.test.js` |
| `transition.js` | Port conflicts in the transition: `PORT_HINT`, `portsWithHint`, `portChange` — at a converted project no port is moved unless a listener already answers on the instance IP. | `conflict-transition.test.js` |
| `git-assignment.js` | Which instance owns a repo, and the list for the `cbase-git` wrapper: `gitInstanceForWorkspace()` → `(path) => instance \| null` (longest realpath prefix over the converted projects of ALL workspaces; the roots of a project are its folder AND its whole runtime folder), `writeGitProjects`. | `projectbox-git.test.js`, `projectbox-git-worktree.test.js` |
| `instance-actions.js` | The sub-slice `instanceProjectRoutes`: repos of an instance (branch, open files — ONE script inside the instance), switch branch, dismiss files, restart the stack; each behind the work lock of the instance. | `instance-actions.test.js` |
| `instance-action-status.js` | A leaf without imports: the running and the last action per instance (`actionBegins`, `actionEnds`, `actionStatus`). | `instance-actions.test.js` |
| `instance-stop.js` | Stopping and starting an instance: `ready → stop → stopped` and back through `restoreInstance`. `stop` is work (holds `busy`), `stopped` is rest. A start that would exceed memory waits (`WAITING_STORAGE`). | `instance-stop.test.js` |
| `instances-tree.js` | The sub-slice `instancesTreeProjectRoutes`: the tree of instances of a project — main first, then the living copies, each with state, resources, services and repos. | `instances-tree.test.js` |
| `copy-progress.js` | The progress of a copy being created, computed from the durations of earlier journals (`copyProgress`, `progressOf`). | `copy-progress.test.js` |
| `lfs-access.js` | The route `POST /api/projects/:id/lfs-access`, the git access of the agent shells: asked by the git credential helper `server/backend/cbase-lfs-access` when git-lfs or git itself asks over https. 404 without the ops marker, 403 without a fence context (only with the valid token of an instance — B itself gets nothing here); the workspace comes from the project of the instance, never from the body. | `lfs-access.test.js` |
| `services.js` | The seam of the services for `../services.js` (a leaf without the store): `servicesSeam()` (`instanceFor`, `updateDesired`, `projectServices`), `carryForwardServiceDesired` keeps `desired.services` current on every simple start and stop. | `projectbox-services.test.js` |
| `env-key.js` | Shared leaf: the `.env*` files of a project as KEYS and CLASSIFICATION, never with a value (`stageValue`, `stageEntries`, `readEnvFiles`). The parser that sees values is not exported. | `relocation-plan.test.js` |
| `compose-config.js` | Shared leaf: `composeConfig(inst)` from the Compose labels of a container (every piece checked — foreign data), the argument builders for `config --hash`, `up --no-start`, the trial run and the model, and the pure verdicts over their output. | `relocation-plan.test.js` |
| `helper.js` | The helper container: `--network none`, never `--privileged`, only `--mount`; its own labels (`cbase.helper…`), NEVER the project labels (every search for project containers would otherwise hit the helper). `helperViolations` checks before every start; `withHelper`, `executeHelper`, `removeHelper`; orphans are cleared in the restart grace. | `projectbox-helper.test.js` |
| `own-labels.js` | Leaf without imports: `OWN_LABELS`, the ONE list of label keys cbase itself sets on containers in B; `ownKey(labels, imageLabels)` — a key inherited from the image does not count. | `relocation-plan.test.js`, `projectbox-helper.test.js` |
| `heavyLoad.js` | ONE lock per B for heavy disk operations, the kind in the value, in memory (a crash releases it; afterwards the journal holds). While held it shows in `/api/runs/active` and `busy` is true. | `projectbox-heavy-load.test.js` |
| `journal.js` | The journal leaf: write BEFORE the effect, `decide` (before the turnaround backward, from it on forward), `run` (resume idempotently; an error before the turnaround takes the return path), plus the relocation location `<data>/relocations/<projectId>/<time>/` (0700, never mounted). | `projectbox-journal.test.js` |
| `exec-measurement.js` | `withExecProcesses(containers, measure)`: two /proc probes around the bundled `docker stats`, adding per container what `docker exec` started in it (wrapper, native services, terminals, runs) — because of the nested cgroup those processes are accounted to B, and `docker stats` never sees them. | `project-instances-pill.test.js` |
| `relocation/` | Relocating an existing project into its project container; own README. | `relocation-*.test.js` |
| `setup/` | Setting up a new project with its container (sources, clone, upload, code repos, project repo); own README. | `project-setup.test.js`, `project-clone.test.js` |
| `layout/` | The layout of an existing project — reading, checking, the job and its execution; own README. | `layout-*.test.js` |

## Rules that hold everywhere here

- Without the ops marker no docker call and no change; the behaviour is then exactly the one without project containers.
- Without an instance row a project is untouched by everything here.
- docker only through `docker.js` — never an own `execFile("docker", …)`; arguments as arrays; removal by id; values for
  `docker exec` as `-e NAME` in the arguments and the value through `opts.env` (the command line shows in `ps`).
- Unknown is not empty: a read that failed throws or yields `null`, never an empty list that a later step acts on.
- Labels are foreign data once they come back from docker: a cbase label counts only when it is set on the container
  itself (`own-labels.js`).
- A new stop of a container in the daemon of B goes through `docker()` and gets a row in the table of
  `projectbox-stop-places.test.js`, with the reason why its `die` event triggers no resumption.

## Frequent questions

- *Why was a project container not created?* → the error text of the instance row (`instance.js:createInstance`, the code on
  the `CreationError`). A mount is missing or one too many → `creation.js:mountRules` and `creationViolations`.
- *Why does a project-container path do nothing on a Mac?* → `ops.js:projectboxOps` — a local server has no ops marker, and
  `docker.js:docker` rejects before a child starts. That is intended.
- *How does a process of a converted project start in the container?* → `runtime/inProject.js:inProject` (not here): the
  instance comes from `run-instance.js:runInstance` through `runs/instance.js`, the child from `docker.js:dockerKind`.
- *Why does a message in a project not start?* → `idle.js:projectLock` (the instance is working, a relocation holds the
  lock, or the server is shutting down); it waits in the queue and starts with `wakeProject` on the change to `ready`.
- *What happens to the project containers when B stops?* → `serverEnd.js:projectboxServerEnd` (snapshot, then
  `stop -t 30`), triggered by `runs/server-end.js`; gateway and deploy stop B with a longer deadline.
- *Why is a project in `start` or `error` after a restart of B?* → `restore.js`: the phase names the step, `error` carries
  the reason. A single service that did not come up shows in the error field of a `ready` row.
- *Why is a project in `recreate`, or why was its container not recreated?* → `recreate.js`: the phase names the step; an
  earmarked recreation waits for the idle of the project (`recreateStatus`).
- *Why did a project come back with its whole stack after a manual `docker stop`/`start` or an OOM — or why not?* →
  `resumption.js`: the log names the verdict per event, `resumptionStatus()` keeps the last ones.
- *Why does a project chat get 401/403 or a shorter list?* → `fence.js:fenceVerdict` (401: no token or a foreign one from
  the project network), `fence-table.js` (403: no row or "rejected", the reason is in the body), `fence.js:FILTER`
  (filtered, header `x-cbase-fenced`). A new MCP tool with a new route needs a row; if the row rejects, the tool belongs
  in `../mcp/visibility.js:FENCE_LOCKED`.
- *Where does `shop.cbase` come from, and why is it still called that after renaming?* → `names.js` (fixed from creation
  on); a name missing in /etc/hosts → `hosts-file.js:writeHostsBlock` reports on stderr, and the restart grace rewrites it.
- *What happens to container, volume and runtime folder when a project is deleted?* → `erase.js`.
- *Why does a call not hang when the command in the container never ends?* → `docker.js:docker`: the cap ends the docker
  CHILD and rejects; the process in the container keeps running, as with the real docker.
- *Why does VS Code upload its server again?* → `vscode-server.js` (which versions stay) and `vscode-upfront.js` (which one
  is fetched ahead); both say in the log what they did or why not.

## What is NOT here

The local docker of the services for projects WITHOUT an instance (`../services.js`), the gateway that creates the USER
containers (`server/gateway/containers.js`, its own process with its own docker calls), the image and its entry script
(`server/backend/`), the start of processes inside a container (`runtime/inProject.js`), the instance resolution of a run
(`runs/instance.js`), the stack copies (`stacks/`), and the data layer of the rows (`store/project-instances.js`,
`store/project-relocations.js`).
