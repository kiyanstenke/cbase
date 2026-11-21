# `projectbox/setup/` — setting up a new project, and uploading into an existing one

**What is here:** in server operation a project only exists WITH a project container and a setup. The POST writes project,
instance row (`create`, with `convertedAt`) and setup row in one synchronous step before the 201; afterwards the procedure
creates the container, waits for the sources (uploads, ZIP archives, clones), places them, creates code repos and the
project repo, and the setup row falls. The same folder holds the after-the-fact upload into a project that already exists.
Without ops everything stays as it is — except `GET /api/projectCreation/rules`, which always answers and carries `mode`
(`folder` without, `container` with ops; the clients read the creation way THERE, because `/api/health` is answered by the
gateway itself in server operation).

## Map

| File | What |
|---|---|
| `routes.js` | `projectCreationRoutes` (`GET /api/projectCreation/rules`), `projectCreateInOps(body, { res, ws })` (the switch at the start of `POST /api/workspaces/:id/projects`), `createProjectFolder` (slug folder without links, suffix `-2…-999`), `setupProjectRoutes` (sub-slice of `projectRoutes`: `…/setup/sources/:seq/{begin,finished,abort,leaveOut}`, `…/setup/conflict`, `…/setup/again`, `POST …/archive` for chunks, and the dispatch of the after-the-fact routes `…/upload/**`, `…/archive/{check,unpack}`). Every route, body and code is in the file header. |
| `procedure.js` | The procedure: `container` → `sources` (unpacking per ZIP source, cloning per clone source) → `place` → `code-repos` → `project-repo` → row gone → event → service detection. `startSetup`, `resumeSetup` (consumer of `atReady` and of the end of a recreate), `setupAgain`, `conflictResponse`, `abortSource`, `setupStorageCandidates`, `reportSetup`, the seams `setSetupHint` (the bell) and `setSetupSaveGate`. |
| `upload.js` | The after-the-fact upload: `beginUpload`, `uploadFinished`, `uploadAbort`, `dismissUpload`, `checkArchive`, `startArchiveUnpack`, `archiveForRetroactive`, `uploadLock`, `targetsExisting` (in B: what exists at the target and what is in the way, lstat per path part from pinned folders), `zipTarget`, `protectStaging` (`/.cbase-*/` in `.git/info/exclude` of the root repo, in the container). Bodies and rules are in the file header. |
| `status.js` | A leaf above the data layer: `setupField` (the field `setup` on the project lists), `setupRunning`, `sourceRunning` (RUNNING per source), `leaveOutBegins`/`leaveOutRunning`, `setupOpen`, `setupAtPath` (write lock of the workspace level), `uploadView` and the marker of running after-the-fact operations (`uploadBegins`/`uploadRun`), the seams `setDetectionReader`, `setLayoutReader`/`layoutStatus`, and `layoutWriteLock`. |
| `archive.js` | The archive file of a ZIP source in the runtime folder (`runs/runtime-location.js` `archiveFile`): `archivePath`, `createArchive`, `archiveSize` (at the descriptor), `writeArchiveChunk` (the ONE write place in the runtime folder), `removeArchive` (row, then file), `removeArchiveFiles`, `cleanArchive`/`archiveRestartGrace` (restartGrace hook "project-archive"). |
| `sources.js` | `checkCreation(body)` — the check of the POST, pure, BEFORE any effect (files, folder, `zip` with its mapping, `clone` through `checkCloneDetail`). |
| `clone.js` | `checkCloneDetail` (the check of a clone address, pure), `clones` (the steps `clone` → `submodule` → `lfs` in the container), `readRemoteHints`, `sshToHttps`, `carriesAccess`, test seams `setCloneLogs`, `setSubmoduleCap`. |
| `rules.js` | The ONE version of the rules (omit lists, names, limits of the repo search, reserve) and the pure checkers `nameError`, `relPath`, `uploadPath`, `codeRepoError`, `under`; `creationMode`. |
| `operation.js` | Upload operations and stagings: `beginCreation`, `beginArchive` (ONE `archiveId` per ZIP source), `stagedSizes`, `createStaging`, `dismissOperation`, `chunkBegins`, `writeChunks` (chunks with `offset` ONLY into the staging; ENOSPC ⇒ 409 `SLOT`), `targetInOperation`, `uploadStagingName`, test seam `setChunkWriter`. |
| `provisioner.js` | The Python program `PROVISIONER`, run in the project container, values only through stdin: modes `conflicts`, `place`, `size`, `list`, `unpack`, `clone`. Every rule of naming, linking, unpacking and placing is in its header. |
| `code-repos.js` | `createCodeRepo` (init + ONE empty commit, identity from `[user]` of B's `.gitconfig`); only into a `.git` cbase verifiably created itself (`HALF_MARKER`). |
| `slot.js` | `checkSlot` — `df` IN the container against the reserve. |

Data: `store/project-setup.js` (tables `project_setup`, `project_setup_source`, `project_archive`, `project_upload`; the
view `setupView` computes a row with a foreign boot id as `error`/`INTERRUPTED`). The upload stamp is in
`runtime/upload-stamp.js`, the boot id per `startServer` in `app-state.js` (`BOOT_ID`).

## Terms

- **Source:** one entry of the POST — `files`, `folder`, `zip` or `clone` — with a number `seq` and a target below the
  project root. States: `wait-upload` → `staged`, or the server states `unpack` (ZIP) and `clone`/`submodule`/`lfs`
  (clone) → `staged`; besides `error`, `aborted`, `leftOut`.
- **Staging:** `.cbase-source-<seq>/` (creation) or `.cbase-upload-<operation>/` (after-the-fact) in the project root —
  the same disk as the target, created IN the container, excluded from the project repo (`/.cbase-*/`). A clone IS its
  staging.
- **Server step:** `container`, `place`, `code-repos`, `project-repo`, and per source the server states above. It writes
  `process` = the boot id BEFOREHAND; only a row with the OWN boot id holds `busy` and the chats. The server steps after
  `container` run under the project occupancy "setup" (`OCCUPIED` ⇒ the setup waits, the end of the other procedure wakes
  it).
- **Interrupted:** a server step or server state with a FOREIGN boot id. Computed, never stored (`INTERRUPTED`); the
  resume takes it over.
- **Resume:** after `finished`/`leaveOut`/the conflict answer, at `atReady` (every restore, so also after a recreate) and
  at the end of a recreate. There is no restartGrace hook for the setup itself: server end stops the containers, and the
  restart sets a row in `create` without a procedure to `error` — "Try again" then creates. (The hook "project-archive"
  only cleans archives.)
- **Conflict answer:** `overwrite` | `skip` (| `abort` in the creation) for files that already exist at the target.
  Without an answer the procedure places with `keep`: nothing is overwritten and nothing discarded; a target that only
  appeared after the count is counted again and asked about.
- **Item error:** one `{ kind, path }` of the provisioner — that entry fails, the pass goes on (`reference`,
  `folder-in-way`, `no-file`, `method`, `bomb`, `damaged`, `duplicate`, `reference-long`, `part`, `repo`). A whole archive
  is `denied` for `unsafe`, `encrypted`, `encoding`, `broken`.
- **The buttons:** "Try again" (`…/setup/again`: resumes every source from its state; an archive that is still there is
  unpacked anew, a clone resumes by its flags), "Take as is" (`finished` with `takeOver: true` in `error`/`aborted`: what
  lies in the staging counts, the archive falls; a clone only once `cloneFetched`), "Continue without this source"
  (`leaveOut`: the only choice that discards).
- **The `error` field** (setup and source) carries ONLY the reason — the prefix "Setup failed: …" is added by whoever
  shows it to a human (web, iOS).

## How the parts work

**Creation.** `sources.js` checks the body (400 and nothing is created). The procedure then runs the sequence in the
header of `procedure.js`. While the step is `sources`, the chats already run; uploads go as chunks into the stagings
(`operation.js`), ZIP archives as chunks into the runtime folder (`archive.js`) — B never opens an archive through a path
in the project folder, the container reads it through the mounted runtime folder. `begin` and `finished` answer
`NOT_READY` while the step is not `sources` (also in the RUNNING `container` right after the 201 — the clients wait on
that code), `RUNNING` holds per SOURCE.

**ZIP.** `finished` puts archive and source into `unpack`; `unpackSource` lists the archive against the mapping (`denied`
⇒ `UNPACK`, a mapping that does not fit ⇒ `PLAN_MATCHES_NOT`, both make the archive `error`), checks the space, empties
the staging and unpacks into it. `SLOT` and item errors leave the archive in `unpack`. Archive states: `upload` →
`unpack` → gone; there is no time cap on an archive of a source that still exists. The client contract of the mapping
(`[{ from, to }]`, `from: ""` is the archive root, `to: null` leaves out) and of the name rule is in the headers of
`routes.js` and `provisioner.js`; the name rule exists three times (`provisioner.js`, `web/src/lib/zip-directory.ts`,
`Code/ZipDirectory.swift`) — if a client deviates, `PLAN_MATCHES_NOT` is the protection.

**Clone.** `checkCloneDetail` follows the ONE rule the fixture `server/backend/test/fixtures/clone-check/cases.json`
pins for server, web and iOS (https only, no user part, no query, no fragment; codes `CLONE_CODES`). The steps run
through `runtime/git-run.js` in the container with `GIT_HARDENING`, without a time cap, with the abort signal, no value
in argv; accesses per host come from the workspace. After EACH step state and flag (`cloneFetched`, `submoduleFetched`,
`lfsFetched`) are set in ONE conditional move, the flag AFTER the effect. Before the first step the save gate is asked:
closed ⇒ `waiting: "storage"`, the storage queue wakes. Errors: `CLONE_ERROR_CODES`; for the access codes the row carries
the `host`. When placing, a clone moves LAST as a whole with ONE rename that never replaces; an occupied target is
`TARGET_OCCUPIED`, nothing moved. After the end `readRemoteHints` records remotes that carry an access in their address
(names only) and rings the bell; cbase rewrites nothing.

**After-the-fact upload.** One operation per upload (`project_upload`, purpose `retroactive`): `upload` → `place` (with
the boot id; an archive that still lies there shows as `unpack`) → the row falls. The target is the root. The pre-check
(`TARGET_BLOCKED`, `REPO_EXISTING`) runs in every route and once more right before placing. New top folders become code
repos; the detection runs with `onlySupplement`. Locked while a setup is open, while a layout job exists and while the
instance is not `ready`; `abort` and `DELETE` always work.

**Storage queue.** Two sources, one queue: "setup" (`setupStorageCandidates` — setups with `waiting: "storage"`, set only
by a clone) and "detection" (`projects/scans.js`). They stay separate: the queue orders across all sources anyway, each
source knows its own state, and a merged source would tie `projectbox/` to `projects/` (import direction). Unpacking
does not wait for storage.

## Three typical questions

1. *Why is a new project in `error`/`INTERRUPTED`?* — The process that ran the server step ended (foreign boot id,
   `store/project-setup.js` `setupView`). The restore brings the container back, `atReady` → `procedure.js`
   `resumeSetup` resumes; otherwise "Try again" (`setupAgain`).
2. *Why does an open setup not hold `busy`?* — It waits (upload, conflict, storage) or carries a foreign boot id; `busy`
   is only held by a running server step of this process (`runs/routes.js`, `store.setupsInWork`) and by an open upload
   chunk (`uploadsActive`).
3. *Where are files placed, and why never through a link?* — `provisioner.js` in the container, every path part with
   O_NOFOLLOW; a link IN THE WAY is an item error of the source (`PLACE`), the rest stays in the staging, "Continue
   without this source" clears it in the container (`routes.js`). A link INSIDE a staging is an item error only for
   folder and file sources; those of a ZIP source are placed individually (`references`).

## What is NOT here

The instance row and its states (`../instances.js`), the creation of the container (`../instance.js` `createInstance`
with `newProject`), the project repo (`../projectRepo.js`), the deletion paths (`../erase.js`), the chat lock with the
reason "setup" (`../idle.js`), the write lock `SETUP_RUNNING` on the file routes (`devtools/code-route.js`), the fence
(`../fence-table.js`, rows "project-setup", "project-archive", "project-upload": only the human sets up and uploads),
the layout of an existing project (`../layout/`), LFS and submodules in daily use (`runs/git-post-work.js`, `git.js`).

Guards: `server/backend/test/project-setup.test.js` and `project-setup-findings.test.js` (harness `setup-harness.mjs`),
`project-unpack.test.js` (the provisioner locally with python3, the archive routes, the restartGrace hook),
`project-clone.test.js` and `clone-check.test.js`, `project-upload.test.js`, `runtime-write-guard.test.js` (the write
place of the archives), `fence.test.js`, `schema-register.test.js`, `tools/check/routes.test.mjs`.
