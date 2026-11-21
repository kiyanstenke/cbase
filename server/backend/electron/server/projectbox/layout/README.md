# projectbox/layout/ — the layout of an existing project (read, check, job, execution, old containers)

The **check** shows the tree of a converted project level by level and says, for a set of steps (the same shape as in project
creation), what it would do — repos with unsaved work, Docker objects with sizes, Compose names after renaming, references between
stacks, virtual environments, citations. It moves, deletes, stops and writes NOTHING. The **job** waits for quiet, locks and hands
over to the **execution** (`procedure.js`), which is the ONLY part that moves, deletes and stops inside the project. Everything that
reads or writes in the project runs INSIDE the project container (`commandRun`/`gitRun` from `runtime/git-run.js` with
`GIT_HARDENING`, docker through `projectbox/docker.js`, removal by id); B touches no path name in the mounted folder. Without ops
every route answers 404 "only in server operation".

## Map

| File | What |
|---|---|
| `routes.js` | `layoutProjectRoutes`, a sub-slice of `projectRoutes`: `GET …/layout?path=`, `POST …/layout/check`, `GET …/layout/check/:id`, the job routes (`takeOver`, `job`, `job/again`) and `GET …/superseded`, `POST …/superseded/remove`. From a project network the fence rejects everything under `/layout/**` and `/superseded/**` (`fence-table.js`, families "project-layout", "project-superseded"). |
| `read.js` | `layoutSituation` (`rootIsRepo`, `copyOpen`, locked — why it is only looked at), `layoutLevel` (one level), `normalizeSteps`, the check (tree → plan → files → Docker → leave out → move/rename → citations) and the operation (`startCheck`, `layoutCheck`, `checkView`, `forgetChecks` for tests). Knobs `CBASE_LAYOUT_CHECK_MS` (default 30 min, 0 = expired at once), `CBASE_LAYOUT_TREE_CAP` (default 500,000 nodes). |
| `plan.js` | The ONE computation, 1:1 from `web/src/lib/project-layout.ts`: `computePlan`, `targetOf`, `nameError`, `repoLocationVisible`, …; plus `mappingFromEnd` (the existing end state as a mapping for `targetOf`). Bound by the fixture set `server/backend/test/fixtures/layout-plan/`. |
| `program.js` | The Node program that runs INSIDE the container (`node -e PROGRAM -- <op> <json>`, one JSON row out): `level`, `tree`, `details` (sizes, venv, alternates). Follows no reference (lstat, `O_NOFOLLOW`, check at the descriptor); `layoutCore(fs, path, op, o)` is the same function for tests. |
| `docker-read.js` | The Docker inventory of the inner daemon (`ps`/`inspect`/`system df -v`, `capMs: 0`), `affectedContainer`, `deleteSet`, `composeNameWithoutP` (`docker compose … config` in the container WITHOUT `-p`), `modelReferences` (build.context, env_file, binds from the model). |
| `citations.js` | `collectCitations`: start commands, start instructions, MCP, workflows, dynamic workflows, agents, skills, credentials, knowledge — only listed, a secret only with its key. |
| `job.js` | The JOB: `takeOver` (creates `project_layout` in `waiting`, earmarks the lock "layout", checks quiet), `quietSync`/`quietAsync`/`layoutQuiet` (holders and hints), `checkQuiet`, `stopHolder`, `revert`, `again`, `layoutRestartGrace` (hook "project-layout", synchronous, registered FIRST), the observer entries `layoutAfterChat`/`checkBackLayout`/`layoutAtReady`, the reader `layoutReader` (for `setup/status.js`), the hooks `setLayoutExecution` and `setDynWorkflowAccess` (server.js). Knob `CBASE_LAYOUT_CHECK_BACK_MS` (default 30 s). |
| `proc-program.js` | The /proc search INSIDE the project container (`node -e PROC_SEARCH -- <mode>`, input on stdin): `foreground`, `processes` (cwd/exe/fd under a path, same mount namespace only), `terminate` (SIGTERM/SIGKILL only to pids the search STILL hits); `procCore` is the same computation in B (`procInB`). Test seam `setProcSearchSeam` (no real signal ever goes out). |
| `processes-in-b.js` | The ONE computation "who works in B under the affected paths", for the quiet and step 5 of the execution: every process except B, its ancestors and the terminals — from a chat's main CLI ⇒ holder `turn` (stoppable), else `process` (not stoppable); two looks (knob `CBASE_LAYOUT_B_QUIET_MS`, default 2 s). |
| `procedure.js` | The EXECUTION: `layoutProcedure(pid, { resume })` (wired in server.js through `setLayoutExecution`; never throws) — ONE journal (`projectbox/journal.js`) with the 21 steps and the return path (turnaround `docker-away`), under the project occupation "layout"; `parkPlan`/`locationAfterParking` (parking places `.cbase-layout/<n>`), `layoutProcedureAlive`; test seam `setLayoutServices`, `forgetProcedures`; knob `CBASE_LAYOUT_TERM_MS` (default 5 s, SIGTERM → SIGKILL in step 5). |
| `rebuild-program.js` | The WRITING container program (pattern of `program.js`, a file of its own because `program.js` only reads): `away` (as root through `rm -rf --one-file-system`), `moves` (rename, parent folder as root with the root's owner), `empty`, `exists`, `alternates`, `links`; no reference in a path part before the last. `rebuildCore(fs, path, cp, op, o)` is the same function for tests. |
| `docker-rebuild.js` | Docker in the inner daemon, without cap, by id: `priorDocker` (step 1), `stopContainer`, `rulesBack` (return path), `removeAway` (step 9), `supersede` (renamed stacks → `project_superseded`, `docker rename` for a fixed `container_name`, repeatable), `composeNew` (step 18, `up --no-start` with dry runs before and after), `recheckDocker` (step 20). |
| `bringAlong.js` | The paths in database and data folder (steps 15, 17), each function REPEATABLE: `projections`, `servicesPlan`/`writeServices`, `knowledgePlan`/`writeKnowledge`, `graphPlan`/`writeGraph`, `subagentsPlan`/`writeSubagents`, `bringAlongPostWork`. |
| `label-files.js` | A leaf: `missingLabelFiles` (`projectbox/` never imports `stacks/`; `stacks/result.js` imports it from here). |
| `superseded.js` | "Remove old containers": `supersededView` (GET — the inventory of the `project_superseded` rows in main), `supersededStatus` (`?status=1`, without docker), `startSuperseded` (POST — refusals 400/409 synchronously, then the procedure under the occupation "superseded"), `computeSet` (the ONE pure computation: ownership rule, "only by name", earmarking), `supersededInWork`. Event `project/superseded` with names and `since`, no values. |

Tests: `layout-plan.test.js`, `layout-check.test.js`, `layout-quiet.test.js`, `layout-procedure.test.js`, `superseded-remove.test.js`
(all under `server/backend/test/`), plus `service-probe.test.js`, the deploy tool's capabilities test (rollback lock) and `fence.test.js`.

## Terms

- **Level:** the entries of ONE folder (kind file · folder · code-repo · worktree, `isRepo` = a `.git` folder, `worktreeOf` = the repo
  of a linked worktree, `gitFile` = another `.git` file, `reference` = a reference as a leaf). Hidden: `.git` and `.cbase-*` of the
  root. No way leads inside a block (409 `IN_CODE_REPO` with `block`).
- **Block:** a folder with ANY `.git` entry (like `git.js` `findRepos`) — moved or left out as a whole.
- **Check:** an operation in this process's memory (id, state `running` · `finished` · `error` · `aborted`); at most five per
  project, a new one aborts the running one of the same project; it expires on read. Event `project/layout` (`kind: "check"`, only ids
  and state). What a check does NOT check is in `notChecked` (holders, VS Code window).
- **`before`:** a rule error that exists even WITHOUT steps (the existing tree violates a rule, e.g. a repo at depth 5) — it carries
  `before: true` and does not come from the steps.
- **`confirmable`:** the Docker objects an adoption may remove (the execution compares against it); `null` if docker could not be read
  and something is affected — never "nothing".
- **Job states** (`store/project-layout.js`): `waiting` → `running` → `finished` | `error` (`turned` says whether the turnaround is
  crossed). OPEN (lock, copy 409 `REBUILD_OPEN`, upload 409 `LAYOUT_WAITING`/`LAYOUT_RUNNING`, a second job 409 `JOB_OPEN`) are
  `waiting`, `running` and `error` AFTER the turnaround.

## Invariants

- **Only in `waiting` does anything pass the lock, and only a follow-up step of running work** (`parentSince < since`: a subagent's
  core, a dynamic workflow run, a graph workflow run); every other start waits — in `running` every one. A oneshot in B always runs,
  one in the project container waits. A re-check happens only after an event (turn end, empty background work, terminal end, upload
  report, stop, `ready`) and in the look-again tick.
- **The turnaround is `docker-away` (step 9).** Before it nothing in the tree is changed: an error runs the return path (old restart
  rules, the current desired state, the native services, the marker gone) and ends in `error` before the turnaround (lock drops,
  revert works) — after a restart or because of a workspace chat in an affected folder, however, back in `waiting`. After it only
  forward: an error ⇒ `error` with `turned`, the lock STAYS (write paths 409 `LAYOUT_RUNNING`, `layoutsOpen` blocks the rollback),
  "retry" resumes at the step. The server ending ⇒ no further step and no return path; the row stays `running`, and the restart grace
  sets `backwards` (before the turnaround), lock and marker, and it only continues at `ready`.
- **`before` only on an empty column, and the counter-check before the turnaround:** no second run rewrites the inventory of step 1;
  step 8 recomputes the plan on the current tree and throws `LAYOUT_CHANGED` if it differs.
- **Old containers of a renamed stack** are in `project_superseded` (`matchContainers` and the desired-state snapshot leave them out);
  linked worktrees are repaired by `worktree repair` from the main repo (never `prune`). A code repo that carries only an empty commit
  gets no graph/subagent worktree.
- **Removing old containers: only what is confirmed AND still belongs to the old stack NOW.** The procedure reads the inventory anew
  and removes the intersection of `confirmed` and the new delete list — new things that arrived after the question stay and appear in
  the report. A container that runs now but was not in `confirmed.running` stays ("running since the question") with everything it
  uses. A running container gets `stop -t 30`, then `rm <id>`; volumes, networks (read fresh before every `network rm`), images
  afterwards, never `-f`. A volume mounted by a superseded container (or earmarked) counts only if anonymous or named by Compose's
  default `<stackPrior>_<key>` with labels; likewise a network; an image only if each of its names is a build name of the old stack.
  What belongs only by label or `_default` name ALWAYS stays ("assigned by name only" — the name may live again). What a container
  OUTSIDE the superseded set uses stays with a reason. Before each `rm` the confirmed volumes and networks it uses are earmarked in
  `project_superseded.earmarked`, so a crash leaves them findable. A row drops only on a "No such container" naming EXACTLY its id and
  with its earmark done; a silent daemon (409 `NOT_READY` in GET, never an empty list) proves nothing. The field `superseded` on the project
  (number of rows, absent at 0, `setup/status.js`) carries the UI button; a client that missed the event reads the outcome through
  `GET …/superseded?status=1` (`{ running, last }`).

## Three typical questions

1. *Why does the check not warn when a stack folder is renamed?* — `read.js`, check step 5: it warns only if the Compose name WITHOUT
   `-p` (`docker-read.js` `composeNameWithoutP`) follows the folder name today AND the folder name itself changes; `name:` in the file
   or `COMPOSE_PROJECT_NAME` in the `.env` pin the name. A pure move does not ask at all.
2. *Why is a volume not in the delete list although it carries the label of the left-out stack?* — `docker-read.js` `deleteSet`: a
   container OUTSIDE the folder uses it — it is listed as staying, with `for`. For the old containers stricter: `superseded.js`
   `computeSet` takes only what a superseded container mounts (or what is earmarked) AND what belongs to the old stack by the ownership
   rule — the label alone is "assigned by name only".
3. *A worktree shows up as code-repo with `gitFile`?* — `program.js` `block`: its `gitdir:` does not point to
   `<repo>/.git/worktrees/<n>` of a repo UNDER the root (compared with the root and its real path), or that repo has no `.git` folder.

## Not here

- The rollback lock (`server/backend/capabilities.json` "layout", the deploy tool's capabilities.mjs, `--rollback-without-layout`),
  the routes' write lock (`projectbox/setup/status.js` `layoutWriteLock`) and the rebuild marker of the monitor (`services.js`
  `setRebuildMarker`). The tables are in `store/project-layout.js`, the lock in `projectbox/idle.js` (`earmarkProject`), the pass
  `parentSince` at the start paths (`runs/project-lock.js`, `runs/agents.js`, `dynworkflows/run.js`, `workflows/driver.js`).
- The UI (web `web/src/components/projects/`, iOS `mobile/CbaseMobile/Code/ProjectLayout*.swift`) and its computation
  (`web/src/lib/project-layout.ts`, `Code/ProjectLayout.swift`) — bound through the same fixture set.
- The rules themselves (`projectbox/setup/rules.js` `rulesResponse`), the idle lock (`projectbox/idle.js`), starting in the container
  (`runtime/git-run.js`, `runtime/inProject.js`).
