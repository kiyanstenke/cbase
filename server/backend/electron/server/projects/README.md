# `projects/` — projects

**What lives here:**
- `context.js`: the knowledge per project — categories (`PROJECT_CATEGORIES`), OKF validation (`validateOkf`), links
  (`resolveContextLinks`), the marker "maintained itself" (`markContextWrite`), the curator after the run (`curateAfterRun`,
  off by default; the consumer `curateHook` of `afterRun`, registered in `server.js`) and the autonomous drop
  (`dumpIntoProject`, classifies and merges against `DUP_BLOCK`).
- `context-form.js`: the FORM of a context entry on writing (`checkContextForm`, patterns ONCE in `CONTEXT_FORM_PATTERN`:
  long body, a branch as place of origin, a commit hash in a commit context, an issue/MR number in the title, a status
  section or checkbox outside `open-points`; no unbounded quantifier except `[^\n]*` before `$`, at most 20,000 characters
  checked per field). Hints come as `formHints` in the response of `POST`/`PUT /api/projects/:id/context`, of
  `dumpIntoProject` and of the workspace context routes; the length hint is always there. Rejected (400, text via `T()`,
  `formRejectionText`) ONLY with the marker `ofAgent` in the body, which only the MCP tools set: a body over 6,000
  characters, on change only if it grows compared to the stored one — web and iOS write through the same routes and only
  get hints. WITHOUT a check: applying a curator suggestion, the import from PROJECT_INFORMATION and the updates of the
  layout. Guard `server/backend/test/context-form.test.js`.
- `scans.js`: the service scan (`serviceScans`, `runServicesScan`).
- `coding-jobs.js`: jobs the server creates as an ordinary coding chat (`kind = 'normal'`, `bypassPermissions`, titled) —
  `startServiceChat` ("start service with an agent": project chat, job as the first message, turn via `startRun`),
  `createImportChat` (files into the dumpster: chat in the chosen project or workspace, response `{ chatId, job }` — the
  client uploads and sends the job) and `serviceCwd`. Old chats of the removed kinds (`context`, `ingest`, `service`,
  `workflow`, `conflict`) remain in user DBs, appear in no list and start no turn (`../runs/only-readable.js`).
- `instance-fields.js`: the instances of a project in the responses of the services pill (`serviceWithInstances`,
  `resourcesWithInstances`).

**Routes (`routes.js`):** in `ROUTES` (`server.js`): `projectListRoutes` (`/api/project-context/schema`,
`/api/context-suggestions/pending`, `/api/context-index[/reindex]`, `/api/projects`), `serviceGlobalRoutes`
(`/api/project-services[/:id[/command-history]]`, `/api/project-resources`), the **owner `projectRoutes`** of the family
`/api/projects/:pid(/sub)`, `servicePortRoutes` (`POST /api/project-services`, `/api/ports`, `/api/ports/conflicts` — per
project `{ items }`), `serviceEventRoutes` (`/api/services/events`, `/api/services/check`) and `portRoutes`
(`/api/ports/running`, `/api/ports/free`).

The owner: preamble (regex, `store.getProject`, 404), then `fctx = { ...ctx, pid, sub, proj }` through the table of
sub-slices in order — among them `itemProjectRoutes` (base GET/PATCH/DELETE, `/agents`, `/mcp-servers`,
`/services[/scan]`, `/vars`, `/workspace-vars`, `/skills`, `/workspace-skills`, `/workflows`, `/workspace-workflows`),
`devtools/routes.js:codeProjectRoutes` (`/git/*`, `/files/*`, `/upload`, `/lsp/*`, `/terminal`, `/debug/launch` via
`devtools/code-route.js:codeRoute`), `serviceProjectRoutes` (`/services/:id/*`), `contextProjectRoutes` (`/context`,
`/context/import-folders`, `/context/adopt`, `/context/dump`, `/context/categories`, `/context/:id`,
`/context-suggestions`). The first result ≠ `NEXT` answers; an unknown sub-path falls through to the dispatcher's 404.
`GET /api/projects` appends the field `instance` to converted or relocating projects
(`../projectbox/names.js:projectInstanceField`), and `DELETE /api/projects/:id` deletes via
`../projectbox/erase.js:projectDelete` (stop and remove the container, volume and runtime folder only with `purge=1`, 409
during creation/relocation/re-creation and in the turn of a converted project).

**Ports per namespace:** the parameter `instance` is three-valued (identifier `<projectId>/<instance>` = only this instance,
empty = only B, missing = B and all instances; unknown 404, without the ops marker with `ONLY_IN_OPS`) — `portClean`
computes the spaces from `projectbox/network-targets.js`, probing happens on the instance's IP, processes IN the container
are resolved by `ports.js:listenersInInstance`, the spaces run in PARALLEL, and an instance whose container is unreadable is
not probed at all — also in light mode; it is listed in `unreachable` (only then), and `findingsComplete` is false. Every
entry, reservation and finding carries `instance` (null = B), and the claims of a converted project apply in its instance
(`claimsPerSpace`, `findingsInSpace`). `/api/ports/free?instance=K` searches with the claims of ITS project on its IP
(`ports.js:freePort`; in an instance 7718 is never free); for an instance whose container is not running it answers 409
instead of calling every port "free" at a silent address. Without an instance row B is the only space. Light mode
(`?registered=1`) only asks an instance whether it is alive and which ports listen there (`ports.js:portsInInstance`, ONE
`docker exec`); process resolution runs only in full mode. Guards `server/backend/test/projectbox-network-paths.test.js`,
`server/backend/test/ports-findings.test.js`.

**Conflicts with converted projects:** ONE conflict computation — `store.portConflicts(converted, claims?)` /
`store.projectPortConflicts(converted)` (`store/projects.js`); the set of converted projects is REQUIRED
(`../projectbox/network-targets.js:convertedProjects`). It is asked by `/api/ports/conflicts`, the findings "conflict" of
`/api/ports/running` (space B) and the service scan. `/api/ports/free` without `instance` does not count their ports as
taken in B; `GET /api/ports` appends a hint to their claims (`../projectbox/transition.js`); `PATCH
/api/project-services/:id` does not move a port on a service of a converted project (409) unless something already
listens on the new one in the container (`portChange`). Guards `server/backend/test/conflict-transition.test.js`,
`web/test/apps-conflicts.test.mjs`.

**Starting services:** `POST /api/projects/:id/services/:sid/start` with `mode: "simple"` starts a converted project's
service in the project container (`services.js:startSimple` via `inProject`; the response carries no `pid` there). The
checks before it ask the instance: `serviceStatus` and `portOccupied`. The route rejects while the project relocates (409
`code: "RELOCATION"`), while the layout rebuilds the folder (409 `LAYOUT_RUNNING`), and for BOTH modes asks the start guard
(`services.js:checkStartFree`, 409 `code: "SERVICE_RUNNING"`). The status carries the same verdict as `holdsStart`; web and
iOS offer "Stop" on `running || holdsStart`. Guards `server/backend/test/projectbox-services.test.js`,
`web/test/service-stoppable.test.mjs`.

**Services per instance:** start, stop and log read `?instance=<projectId>/<instance>` (`serviceInstance`): missing or empty
= main (unlike the tunnel, where empty means B), `<id>/main` = main, a copy only with the ops marker and a row. No
identifier or one of ANOTHER project ⇒ 400 `code: "INSTANCE_INVALID"`, unknown copy ⇒ 404 `code: "UNKNOWN_INSTANCE"`
(never a fallback to main), each with the named `identifier`; unreadable row ⇒ 500 without `code`. There is no agent start
in a copy (409 `code: "COPY_AGENT"`), and a start in a copy that is not `ready` is 409 `code: "COPY_NOT_READY"` with
`identifier` and `state`; stopping stays allowed. From a project network the fence pins `instance` to its own identifier
(`projectbox/fence-table.js`). From two instances on every row of `/api/project-services` also carries `instances:
[{ identifier, running, holdsStart }]` (`instance-fields.js`); `/api/project-resources` carries `host`, `quota` (the limits
of the user container) and per instance the contract's fields — an instance whose row is gone drops out. Guard
`server/backend/test/project-instances-pill.test.js`.

**OKF of a converted project:** the git calls of verification and freshness run in the project container (`../okf.js`,
`instanceForProject(pid)`). If it is stopped, `POST /api/projects/:id/context/:cid/verify` answers 409 with the situation of
the git view (`../devtools/code-route.js:gitStandsSituation`) and freshness is "not ratable" (`null`). The auto anchor on
creating a knowledge entry wakes a stopped project container the same way: the entry is created unanchored, 201 with
`containerStands` and `hint` from the SAME situation (`anchorHint`). Guard `server/backend/test/projectbox-git.test.js`.

**The re-scan reconciles:** "scan again" does not replace the stored services (`scans.js` →
`../store/projects.js:reconcileScan`). Every find looks for its service — name, then port, container, start command in the
folder —; a matched one keeps id and name. What the scan no longer names is decided by the row's origin: one created by
the scan drops — unless it runs or is in the desired state of an instance (`scans.js` notToRemove; during a relocation
nothing drops) —, a manually registered one stays. What stays is in `scan.notFound`, what dropped in `scan.removed` — each
with a notice.

**Detection in the project container:** `scans.js` resolves the project's instance (`../runs/instance.js`) and passes it
via `../claude.js:scanServices` and `runOnce` to `runOnceClaude`, which then starts in the container via
`../runtime/inProject.js`; without an instance in B. With an instance only Claude. Fields with a token pattern are dropped
with a notice that never names the value. The status `serviceScans.get(pid)` also knows waiting: `{ status: "running",
waiting, waitText }` with `waiting` = "project" (the project's lock), "storage" (`../workflows/storage-gate.js`) or "cap"
(`CBASE_DETECTION_CAP`, default 2). A call while it waits merges into it; while it computes, EXACTLY ONE after-run follows.
`onlySupplement` reconciles without removing. Guard `server/backend/test/project-detection.test.js`.

**Outer loop:** `outerLoopProjectRoutes` (`../outerloop/routes.js`) is in the table of `projectRoutes`
(`/api/projects/:pid/workspace-outer-loop…`). Deleting a project aborts the open runs of its project agents before
`store.deleteProject` (`../outerloop/abort.js:abortOuterLoop`).

**What does NOT live here:** the model calls themselves (`../claude.js`), dedup and search (`../dedup.js`,
`../retrieval.js`), persistence (`store/projects.js`, `store/context.js`).

**Terms → file:** project context/knowledge, category, OKF, curator, drop (dump) → `context.js` · form of an entry →
`context-form.js` · service scan → `scans.js` · service chat, sorting files in → `coding-jobs.js` · instances in the
services pill → `instance-fields.js`.

**The three most frequent questions:**
- What happens to a text that falls into the dumpster — create new or merge into an entry? → `context.js:dumpIntoProject`
  (strict threshold `DUP_BLOCK`, without asking).
- Why does the curator not run after a run? → `context.js:curateAfterRun` (`CURATOR_ENABLED` off, or `markContextWrite` set
  since the run began).
- How does the agent that brings a service up start? → `coding-jobs.js:startServiceChat` (a coding chat in the project).
  Port conflicts are only displayed (`GET /api/ports/conflicts`, warning icon).
