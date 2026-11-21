# `stacks/` — copies of a project's stack

A **copy** is a second instance of a relocated project (`copy-<name>` next to `main`): its own project container
`cbase-k-<pid>-<name>`, its own network, its own volume, the main instance's project folder read-only underneath as the
lower layer of overlays. This folder holds everything that concerns the copy as a WHOLE — request, queue, state, name,
location, journal, the way back (fetch, clearing away) and the moving-in of chats. How a container per instance is
created is known by `../projectbox/`.

## Terms

- **Main instance / copy.** `main` is the project as it is; a copy is created from `main` or from a ready copy of the
  same project (its **template**, `baseInstance`).
- **A copy belongs to no chat.** `chat_id` is only the creator (`createdOf`, NULL = a human created it); `inset` says
  whether this chat moves in and is woken at `ready` (only via the tool). Which chat works in which instance is in
  `chats.instance` (NULL = main), set only via `../runs/instance-switch.js`, read via `remove.js:copyOfTheChat`.
- **Queue.** A request waits (`waiting_queue`, `waiting_storage`) until its project is free, no heavy disk operation
  runs and the storage gate is open; the queue then starts the **build**.
- **Build.** freeze (volume clone, code snapshot, policy protection) → creation (overlays, container) → prepare (git in
  the copy container) → start → `ready`. A failure after the freeze is followed by the **dismantling**.
- **Fetch / clearing away.** Fetch brings the copy's commits and open work into the main instance under
  `copy/<name>/…`; clearing away fetches, backs up and then removes the copy — without loss.
- **Journal.** Every step of build and clearing away is a step of the copy's journal (column `journal`, mechanism in
  `../projectbox/journal.js`); a second call or a restart continues from it.
- **Wake call.** The system message a chat receives when its copy is ready, failed or removed. Web and iOS read its
  `<summary>` and recognise the English wording (`Copy "<name>" ready` …) — it is a contract across the clients.
- **Never a value.** Results, reasons and events carry identifiers and words only, never the value of a variable.

## Files

| File | What | Kind |
|---|---|---|
| `names.js` | Naming rule (the form itself is `COPY_NAME` in `../projectbox/creation.js`), `nameFree` (no live copy, no backup folder `copies-backup/<pid>/<name>`, no ref under `copy/<name>/` in heads, tags or notes of a repo of the main instance, and no ref named exactly `copy`), `automaticName` (`k<n>`), `spaceError` | pure leaf |
| `location.js` | The ONLY place of the literals below a copy's root (layers, object layers, work folders, open files, return-path repos, `snapshot.json`, `overlays.tsv`, `.prepared`) and of the backup folder `<data>/copies-backup/<pid>/<name>`; `copyLocation` gives both sides (in the user container and as the copy sees them) | pure leaf |
| `state.js` | THE setter: `copyRequests` (waiting only; 409 `COPY_OCCUPIED` for a live name), `setCopyState` (transition and phase checked BEFORE writing; copy event; coupling to the instance row in the same synchronous step; taken back if the instance row fails), `copyJournal`, `removeJob` | setter |
| `request.js` | `submitCopyRequest`: the execution side of creating — project, chat, template, form of `base` and `name`, the main instance's refs, the pre-check of the base, name taken; then the row and `wakeQueue()` | check |
| `routes.js` | `stackCopyProjectRoutes`, a sub-slice of `../projects/routes.js`: `POST/GET …/stack-copies`, `GET …/:name`, `GET …/:name/state`, `POST …/:name/fetch`, `DELETE …/:name` | routes |
| `queue.js` | The queue: three conditions per attempt, the start as ONE synchronous step, the handling after a restart (orphaned builds are dismantled and queued again at their old place); source "copies" of the shared arbiter `../workflows/storage-queue.js` | procedure |
| `build.js` | THE procedure the queue enters (`copyBuild`): freeze, creation, prepare, start, `ready`; on failure dismantling, then `error` with "<step>: … (<CODE>)"; at server end the copy stays in `build` | procedure |
| `freeze.js` | `freeze`: location, volume of the copy, clone helper, the phases of the volume clone around the pause of the main instance, the code snapshot in the pause, policy protection; `dismantlingClone` | step of the build |
| `code-snapshot.js` | `codeSnapshot` in the pause (refs, HEAD, stashes, config, open changes as tar per repo; the project repo first with the commit "State before copy <name>"), `templateSnapshot` for a copy from a copy, `readSnapshot` | step of the build |
| `objects.js` | The ONE place where the user container writes below a copy's layer and objects folders (before the first mount): `createCopyLocation`, `linkObjects` (hard links into a lower layer), `prepareLayer`, `createOverlays`; the removal of location and worktrees; return path and backup folders | file system |
| `creation.js` | `overlayRows` (pure) and `createCopy` (overlays.tsv, then `../projectbox/instance.js:createInstance` until `phase=prepare`) | step of the build |
| `prepare.js` | `prepareCopy` — every git in the copy container (`../runtime/git-run.js:commandRun`, perl commands `SCRIPTS`): set up, checkout (`base`), tar of the open changes, post work; from a template: foreign worktrees, checkout and tidy only with a base; last `.prepared` | step of the build |
| `start.js` | `startCopy` — wait and check the inside, desired state into the row, `../projectbox/restore.js:runInstanceUp`, restart policies back, the desired state of now | step of the build |
| `result.js` | The tool result of the creation (`collectResult`, stored in `stack_copies.result`): services, ports, names, hints — keys only, never a value | step of the build |
| `dismantling.js` | `dismantleCopy` — container and network by id with the labels of THIS instance, then what the freeze created, last the instance row; two callers: the build and the queue | way back |
| `returnPath.js` | The return-path helper (no network, project folder rw, layers read-only) and its ONE program: list the upper layer, fetch into bare repos, merge, bundles | way back |
| `fetch.js` | `copyFetch` (REST, idempotent) and the building blocks the clearing away shares: the state IN the copy, the fetch jobs (branches, detached HEADs, stashes, tags, notes, WIP), new repos as bundles | way back |
| `project-repo-copy.js` | The project repo of a copy: `commitInTheCopy` (with the pre-commit hook from its own hooks path) and `mergeProjectRepo` (one merge at a time per project folder) | way back |
| `clearAway.js` | `clearAwayCopy` → `removed` / `earmarked` / `error`, never throws: lock and idle check, then fetch, back up, project repo, layer, remove — each a journal step | way back |
| `remove.js` | THE entry of every trigger: `removeCopy` (REST DELETE, tool, deleting project or workspace, restart); the job is written to the journal BEFORE any effect; the work lock; the wake call "removed"; `copyOfTheChat` | trigger |
| `inset.js` | The chat moves in and out: `copyTransition` (called by the setter after every change) — binding, terminal of the chat bar, wake call at `ready`/`error`, child chats of graph runs; `copyHolds`, `newAttemptSet`, `neverBuilt`, `waitingStill`; repairs after a restart | transition |
| `status.js` | The delete preview `copyStatus` (per repo: branch, commits the fetch would bring, open files; the chats working in the copy), read IN the running copy | read |

The table is in `../store/stack-copies.js`: ONE partial UNIQUE index over the live rows (`state != 'removed'`):
`(project_id, name)`.

## States and the instance row

| `stack_copies` | Phases | Instance row `copy-<name>` in `project_instances` | `busy` |
|---|---|---|---|
| `waiting_queue`, `waiting_storage` | — | none (a working one from an aborted build becomes `error`) | no |
| `build` | `clone1`, `freeze`, `clone2`, `creation`, `prepare`, `start` | created on the transition in `create` with the same phase, `chat_id`, `copy_name`; the phase moves along | yes |
| `ready` | — | `ready` with `converted_at` | no |
| `clearAway` | `earmarked` | untouched — `earmarked` exists only here | no |
| `clearAway` | `fetch`, `save`, `projectRepo`, `layer`, `remove` | `clearAway` with the same phase | yes |
| `error` | — | a working one (`create`, `clearAway`) becomes `error` with the reason | no |
| `removed` | — | must no longer exist — otherwise the setter throws (the clear-away path removes it first) | no |

Transitions (`TRANSITIONS`): waiting_queue → waiting_storage · build · error · removed; waiting_storage →
waiting_queue · build · error · removed; build → ready · error · waiting_queue (a restart in the middle of the build);
ready → clearAway · error; clearAway → removed · error; error → clearAway · removed · waiting_queue; removed is the end.
The same state with another phase is always allowed; every state except `error` clears the error.

## Direction of dependencies

`stacks/` imports only `../projectbox/`, `../workflows/storage-gate.js`, `../runs/`, the store and the cross-cutting
leaves `../runtime/`, `../app-state.js` and `../i18n.js`. `projectbox/`, `runs/` and `workflows/` NEVER import
`stacks/` — they learn about copies only via setters from `server.js`. Likewise the other way: what `stacks/` needs
from `../services.js` comes via wiring (`freeze.js:setNativeServicesStatus`, `clearAway.js:setServicesStopper`).
Guard: `server/backend/test/import-direction.test.js`.

## Guards

`server/backend/test/stacks-*.test.js` (schema and path guard, queue, busy, freeze, code, creation, result, fetch,
return-path program, clearing away, lossless, remove, inset, new attempt, routes, stand), `copy-tools.test.js`,
`copy-from-copy.test.js`, `copy-worktrees.test.js`, `copy-progress.test.js`, `memory-copy.test.js`,
`channel-copy.test.js`, `fence-stacks.test.js`. The path guard in `stacks-schema.test.js` counts every literal of a
copy's folders outside `location.js`.

## Typical questions

- **Why does a requested copy not hold a deploy?** While waiting there is no instance row, and `busy` only reads
  `project_instances`. Only `build` creates it — in the same synchronous step (`state.js:coupleInstance`), so already
  in `clone1`.
- **Where is it decided which name is free?** `names.js:nameFree` — the caller hands in the names of the live copies,
  the names of the folders under `location.js:projectCopiesLocation(…).backup` (MANDATORY — without them the rule
  throws) and the refs of the repos of the main instance; the store itself only locks via the index. The caller via
  REST is `request.js:submitCopyRequest`.
- **Why is there no value in the result although `compose config` reads values?** `result.js` classifies them in
  memory (`../projectbox/env-key.js`) and keeps only key names; a failing call only passes on its code.
- **Where is the work of a cleared-away copy?** Commits and open work under `refs/heads/copy/<name>/…` in the repos of
  the main instance (branches, WIP, stashes, detached tips, fallback refs `-<n>`), tags under
  `refs/tags/copy/<name>/…`, notes under `refs/notes/copy/<name>/…`, new repos as `n<j>.bundle` and, on an automatic
  clearing away, the ignored files as `ignored.tar` under `<data>/copies-backup/<pid>/<name>/`; the report is in
  `stack_copies.result`.
- **Why can a project with a copy not be deleted at once?** The copy step in `../projectbox/erase.js` kicks off the
  clearing away of every live copy and answers 409; after `removed` deleting works as usual.
- **Why is a copy not cleared away although `DELETE` said 202?** It is `clearAway`/`earmarked` until `instanceIdle`
  reports it empty — a turn, subagent or monitor in it holds it; the wake-up asks at the end of a turn and on the
  check tick. The job is in the journal (`trigger`) and survives a restart.
- **Why does `POST …/stack-copies` answer 409 COPY_BASE although the form of `base` is right?** `request.js:baseInMain`
  asks every repo the copy carries, IN the main instance, whether it knows the ref as a commit — if none does, the
  refusal comes at once instead of after clone, pause and creation. An exit other than 0/1 is 409 REFS_UNREADABLE,
  never "unknown". The late check in `prepare.js` stays (the state only counts at the freeze), and where only the copy
  COULD know the ref — relative in the project repo with marker, `HEAD`/`main` of a project folder without `.git` —
  only it decides. Reflog selectors (`main@{1}`, `@{-1}`, also `@{0}`), stash and pseudo refs are already rejected by
  the form (400 BASE_INVALID); `@{u}`, `@{upstream}` and `@{push}` pass. From a template, `baseInTheTemplate` asks the
  same question IN the template, without that reservation.
- **What does `dismissed` mean in the answer of `DELETE …/stack-copies/:name`?** The request was still waiting
  (`inset.js:waitingStill`): it is `removed` with the call, never built, there is nothing to fetch, and NO wake call
  comes, only a silent notice to its chat. `neverBuilt` stays false there.
- **What protects the work while a copy is cleared away?** From step 0 the instance row is in `clearAway`: every file
  and git route of the copy except the reading ones answers 409, a new terminal or debugger is locked, the terminals of
  its chats end (`earmarked` does not lock). The writers of the copy (native services, stack containers) are stopped
  before step 1. At the end of step 4 a post-check computes in the copy once more what steps 1–3 backed up — if it
  differs, steps 1–4 run once more, then `error` (`COPY_POST_CHECK`) with nothing removed (`clearAway.js`).

## What is NOT here

Names, labels, network, mount rules and the creation of a container per instance (`../projectbox/creation.js`,
`instance.js`); the occupancy per project and instance (`../projectbox/instance.js`); the journal mechanism
(`../projectbox/journal.js`); the table (`../store/stack-copies.js`); the entrypoint of the copy
(`server/backend/projectbox-entry.sh`); the shared arbiter of the storage wait for graph starts and copies
(`../workflows/storage-queue.js`); the start sequence of an instance (`../projectbox/restore.js:runInstanceUp`); the
tools `cbase_copy_stack*` (`../../mcp/tools/stacks.js`), their visibility (`../../mcp/visibility.js`) and the fence
rows (`../projectbox/fence-table.js`) — they call these routes; a call through the fence is the trigger
"tool"/"agent" of the clearing away.
