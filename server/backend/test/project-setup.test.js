// Setting up a new project: POST /api/workspaces/:id/projects in server mode (projectbox/setup/routes.js), the procedure
// (projectbox/setup/procedure.js), the setup routes, the fields in /api/runs/active and /api/health, the deletion paths.
// Runs over the fake docker (fake-docker.mjs; an `exec` runs locally -- git, python3, node, df) and the real server in the test process.
// The harness lives in ./setup-harness.mjs (shared with project-setup-findings.test.js, project-unpack.test.js, project-upload.test.js).
//
// What holds here:
//   (1) Validation of the POST in server mode: 400 with `code` (PATH_IN_OPS, NAME_MISSING, SOURCES_MISSING, ONLY_HTTPS for a clone
//       without an address, MAPPING for a zip without a mapping, TARGET_INVALID, TARGET_DUPLICATE, CODE_REPO_LOCATION) -- and NOTHING is
//       created (no folder, no project, no row, no docker). Plus createProjectFolder without a workspace folder => FOLDER.
//       (The other clone cases: project-clone.test.js; the other zip cases: project-unpack.test.js.)
//   (2) An empty project: 201 with `setup` (container, waits for container) and `instance.converted`; the instance row carries
//       `converted_at` already in the answer; afterwards container `ready`, the project repo with marker and EXACTLY one commit
//       "Creation" (git in the container), runtime folder with worktree root and `~/.local`, the row gone, the `project/setup` events
//       (ids, states, codes only), no services detection; /api/health "container". EVERY git of the project repo runs through
//       docker exec WITH GIT_HARDENING (the commit with the commit hardening: core.hooksPath=.git/hooks, commit.gpgSign=false),
//       and `desired` stays null (see (5) below).
//   (4) A failed container (broken image): instance `error`, setup `error` with code CONTAINER, counted outwards
//   (5) in `setupError`, not in `busy`. "Try again" removes ONLY the leftover project container OF THIS project (label, by id:
//       `stop -t 30`, `rm` without -f, before the new `run`), a foreign one stays; afterwards `ready` and finished.
//   (6) A row whose server step an EARLIER process ran (foreign boot id): outwards `error`/`INTERRUPTED`, counted in `setupError`,
//       not in `projectWork`; the instance's transition to `ready` (restore) resumes it through the receiver at `atReady`, and it finishes.
//   (7) Sources and code repo: two sources (folder `x`, files into the root), `begin` creates the staging in the container, `finished`
//       places it; a `.git` FILE with an absolute gitdir is dropped; `x` becomes a code repo with EXACTLY one empty commit, the identity
//       from `[user]` of B's `.gitconfig` (here the test home), the files stay untracked; the project repo excludes `x` and carries
//       `readme.md`; the staging is gone; services detection runs once.
//   (8) On the real tree: an uploaded repo with HEAD stays as it is (no commit added), a collection folder stays a normal folder (its
//       inner repo untouched, no `.git` added); an uploaded repo at a place the repo search does not see (dot folder) =>
//       CODE_REPO_LOCATION, nothing placed. Two `.git` folders nested in ONE source are one repo with content (see
//       project-setup-findings.test.js); across two sources it stays an error.
//   (9) Without server mode: `GET /api/projectCreation/rules` 200 (reserve 5 GB), the six setup routes 404 "only in server mode",
//       /api/health "folder", the POST with `path` as before (no instance row, no setup), no `setup` field on a project with a row, the
//       four new counts 0 -- and no docker.
//  (10) `projectWork` and `busy`: during creation ONE entry (the instance in `create`, no second one for the setup); while waiting for the
//       upload none; in a server step (`place`, at the fake docker's gate) the entry `setUp` with the step as phase, `busy`, and
//       "Try again"/"Leave out" answer RUNNING.
//  (18) `begin`: BYTES, PATHS (absolute, `.git` as the first part), `x/.git/HEAD` allowed; the same operation the second time with the
//       sizes of the already staged files; OPERATION_FOREIGN; while a chunk is open (chunkBegins, the seam) UPLOAD_RUNNING for
//       begin/finished/leaveOut, `uploadsActive` 1 and `busy`; `lastChunk` in the view.
//  (15) A link at the slug's place: the folder becomes `<slug>-2`, the link's target stays empty.
//  (16) SLOT: 409 with `free` and `needed` (df in the container, reserve 5 GB); a link in the target => single error, source and
//       setup `error` (PLACE), the link's target stays empty; "Leave out" removes the staging in the container, and the setup runs on to the end.
//  (17) Conflict (P6): a file that already exists at the target => `conflict` waits (count, example; does not hold `busy`);
//       skip => the target byte-equal, overwrite => replaced, abort => TARGET_OCCUPIED, the staging stays; MODE, NO_CONFLICT, NO_SETUP.
//  (21) Deleting: DELETE /api/projects/:id and DELETE /api/workspaces/:id take all four tables with them (setup, sources, archives,
//       upload operations) -- even without an instance row -- and the upload stamp.
//  (22) The "setup" source of the storage queue is registered. Only a clone sets `waiting: storage`; a wait without a clone source
//       in a server state falls at the next kick -- the reconstructed state (files + `waiting: storage`) runs to the end with the gate
//       closed; the real waiting with waking the queue is held by project-clone.test.js.
//  (23) Integration with the detection: the field `detection` (`{ status, since }` from serviceScans) on GET /api/workspaces/:id and
//       /api/projects; `withoutInstanceRow` in /api/runs/active is the length of the SAME list that GET /api/projectbox/ops-status names.
//       The detection after the end goes through the ONE seam projectbox/detection.js (7).
//
// Turns and restarts:
//   (3) Turns: in `create` (at the creation's exec gate) and in `place` (at the placing exec gate) `queued` + `locked`, no turn;
//       afterwards they run -- EACH through `docker exec` with the CLI in the project container (never in B), the first after the `run`,
//       the last after the creation commit (code-repos and project-repo hold it too); in `wait-upload` it runs at once (P1).
//   (6) Recreate: a setup that stayed in `container` (instance `error`, foreign boot id, outwards INTERRUPTED) continues after
//       `recreateRequest` with `sources` and finishes. Two paths carry it, each alone: `atReady` (the restore INSIDE the recreate
//       reports ready) and setRecreateFinished.
//  (10)/(14)/(17)/(18) Chunks with an operation (`POST /api/projects/:id/upload`, `{ operation, files }` in the body like web and iOS --
//       or `?operation=`): only under `.cbase-source-<seq>`, never at the target;
//       `offset > 0` unequal to the size => 409 OFFSET with `size` (the file unchanged, a just-created one is removed again);
//       resume from `size`; `offset: 0` over a LARGER file => replaced; an invalid chunk (no offset, with append, paths) => 400 CHUNK for
//       the WHOLE request; address and body differ => 400 OPERATION_LOCATION; an empty, unknown or non-textual operation in the body =>
//       409 OPERATION_UNKNOWN, nothing written; at workspace level an operation in address OR body => 400 OPERATION_LOCATION, nothing
//       written; unknown in the address => 409 before the body; the stamp stands at the BEGINNING: while a chunk request's body is still
//       missing (open request, diagnostics_channel), `uploadsActive` 1, `busy`, a second tab UPLOAD_RUNNING -- also WITHOUT an operation in
//       the address (the clients' way: until the body is read, the request counts for every operation of its project, `finished` =>
//       UPLOAD_RUNNING); after `finished` the operation accepts nothing more.
//  (11) Deleting during `code-repos` (git init at the fake git's gate) => 409 OCCUPIED, project, instance and setup unchanged;
//       in `wait-upload` 200, afterwards no instance row, no setup, no project container.
//  (12) SETUP_RUNNING: in `wait-upload` 200 for write routes; during `place` (exec gate) 409 for files/write|create|rename, DELETE files,
//       upload without an operation, git at project level -- reading 200; at workspace level for paths in the project, the project
//       folder itself, the root for git (parent folder), a rename INTO the project and a link to the project -- a path next to it
//       200; afterwards 200 again. Also the language service: during the lock no language server starts -- `/lsp/rename` (project and
//       workspace level) and `/api/lsp` rename answer `supported:false` with `state: "off"`, the file stays; plus `no_project`;
//       after the end the editor route gives only `{ edit }` (the file stays) and the agent route writes.
//  (13) Copy start (`POST /api/projects/:id/stack-copies`) while a setup is open -- wait-upload AND error => 409
//       NO_COPY_DURING_SETUP, no copy row.
//  (16) Two sources, one fails (link in the target) => the setup holds, the other stays in its staging, no project repo; leave out =>
//       place, code repo and project repo "Creation". A workspace inside a repo => error IN_REPO.
//  (19) The server as a PROCESS (childProcess: true): a crash while git waits at the gate before the creation commit (`.git` without HEAD) =>
//       after the restart (restore, atReady -- WITHOUT "Try again") exactly ONE commit "Creation", the marker is there.
//
// Gaps found in review:
//   (1) `operation` in the BODY (critical): web and iOS send `{ operation, files }` without `?operation=` -- the first version rejected
//       every such chunk with 400 OPERATION_LOCATION. Now (10)/(14)/(17)/(18) go through the body.
//   (2) The language service past the write lock: see (12) (start lock of the core, lsp/).
//   (3) CODE_REPO_LOCATION without a source: (8) -- the error carries its source(s), "Continue without this source" => 202 and
//       finished; repo in repo across TWO sources => both `error`, a third stays `staged`; leaving out the inner one => the outer one
//       goes back to `staged`, is checked again on the real tree and placed.
//   (5) desired = null -- the LITERAL reading ("survives server end and restore") is wrong and is not built: from `wait-upload` on
//       chats run in the container (P1) and can start inner containers; a `desired` that STAYED null across the server end would
//       leave them off after the restart. What is checked: the setup writes no `desired`; the server end writes the current state
//       (a container started afterwards runs again after the restore, a stopped one stays off); a crash without a server end => the
//       restore with `desired = null` starts NOTHING and becomes ready (null means "nothing should run"). (2).
//       The project repo's git WITH GIT_HARDENING over docker exec: (2).
//   (6) Real restarts: in `container` with the server as a PROCESS (creation at the exec gate, crash()) => instance error (post-start
//       hook "project-instances"), row INTERRUPTED, not in projectWork, busy false; "Try again" removes the leftover container
//       (stop -> rm -> run) and continues with `sources` to the end. Before createCliHome (state reconstructed: foreign boot id,
//       instance error, without `.claude`/`.codex`) => "Try again" creates CLI home and container. In `code-repos` with `restart()` =>
//       the old row does not hold busy (setupsInWork), INTERRUPTED; the earlier server's procedure (in-process only) ends at the git
//       gate without hitting the row; a kick before atReady (like a post-start hook) sends no exec to the stopped container; the
//       restore continues to the end. NOT with `restart()` in `container`: the instance stayed `create` with a living procedure
//       (procedureAlive), held busy through projectWork, and after the gate opened the "earlier" server's procedure finished the step
//       itself -- that is no restart, only a new listener next to the same module memory; the post-start hook that really sets `error`
//       is switched off in the harness.
//  (20) An uploaded repo with a submodule (`.git` file, relative gitdir to `.git/modules/sub`) as a code repo marker: the file comes
//       along, `git submodule status` checked out at the recorded state, no init; an absolute gitdir => left out.
//
// Wait only on events: row states (`waitForTruthy` without a deadline -- a state without a living procedure that is not the expected
// one THROWS instead of hanging), gates of the fake docker, the microtick after `atReady`. No duration is a criterion.
//
// COUNTER-TESTS (one sabotage each on the worktree, only the affected tests run; each sabotage turns red WITHOUT a hang):
//   workspaces/routes.js: the switch in the POST removed                               => (1) red (`path` gave 201 instead of PATH_IN_OPS)
//   setup/routes.js: compare against the workspace path instead of its REAL one        => (2) red (PATH_REFERENCE under /var -> /private/var)
//   setup/routes.js: the POST's instance row without `convertedAt`                     => (2) red ("converted from the first row")
//   setup/routes.js: project folder `mkdirSync(..., { recursive: true })` without lstat => (15) red (409 PATH_REFERENCE instead of <slug>-2)
//   setup/procedure.js: removeRestContainer removed                                    => (4)/(5) red (CONTAINER_EXISTS: "already exists")
//   server.js: the receiver at atReady removed                                         => (6) red ("the receiver at atReady did not run")
//   code-repos.js: identity from os.homedir() instead of the setup's home              => (7) red (author of the code repo commit)
//   procedure.js stepPlace: a conflict does not wait                                   => (17) red ("waits for conflict: no procedure lives")
//   runs/routes.js: the `setUp` entry in projectWork removed                           => (10) red
//   setup/routes.js: `chunkOpen` before begin/finished removed                         => (18) red (finished 202 instead of UPLOAD_RUNNING)
//   runs/routes.js: `uploadsActive` not in busy                                        => (18) red ("an open chunk holds busy")
//   setup/routes.js: checkSlot removed                                                 => (16) red (200 instead of SLOT)
//   setup/routes.js: leave out without the way back to `setup`                         => (16) red (stays error PLACE)
//   projectbox/erase.js: setupsGone without effect                                     => (21) red (the four tables keep their rows)
//   server.js: setStorageQueueSource("setup", ...) removed                             => (22) red ("registered sources: graph, copies")
//   setup/status.js: setupField without the server-mode check                           => (9) red (field without server mode)
//   server.js: setDetectionReader not called                                           => (23) red (no field `detection`)
//   runs/routes.js: withoutInstanceRow fixed 0 instead of the list                     => (23) red (0 !== 1)
//   setup/procedure.js: detectServices(pid) after the end removed                      => (7) red ("services detection exactly once")
//   code-route.js: the stamp ends before the body (like "at the end of the request")   => (10) red ("the open chunk request counts", 0 !== 1)
//   real-path.js: offset 0 without ftruncate                                           => (14) red (stale tail instead of the new content)
//   devtools/routes.js: without chunk redirection (no redirect into the staging)       => (17) red ("never at the target")
//   devtools/routes.js: without `setupLock`                                            => (12) red (files/write 200 instead of 409)
//   status.js: `touches` in one direction only (no parent folder)                       => (12) red (git at the root 400 instead of 409)
//   status.js: without the comparison at the real place (realpath)                      => (12) red (200 over the link -- the file lay in the project)
//   projectbox/erase.js: deleteLock ignores the occupation "setup"                     => (11) red (409 WITHOUT code OCCUPIED -- the occupation in the deletion itself still held)
//   stacks/request.js: without the setupOpen check                                     => (13) red (202, a copy "k1" under construction)
//   provisioner.js: git_file_applies always False ("every .git file gone")             => (20) red (`git submodule status` "-<sha> sub")
//   procedure.js: an error of a source does not hold (continue with the next)          => (16) red (no error, the setup ran through)
//   procedure.js: `in-repo` not recognized                                             => (16) red (GIT instead of IN_REPO)
//   idle.js: the reason "setup" removed                                                => (3) red (the turn during place ran, queued false)
//   idle.js: the old rule "whole setup" (setupOf instead of setupRunning)              => (3) red (the turn waits in wait-upload, no procedure wakes it -- turnRan)
//   server.js: both receivers removed                                                  => (6) red ("no procedure lives", step container)
//   (server.js without setRecreateFinished stays GREEN for (6): atReady of the restore inside the recreate carries alone;
//    without the atReady receiver it is carried by setRecreateFinished alone.)
//   procedure.js stepProjectRepo: the three stages skipped (createProjectRepo directly) => (19) red (error GIT)
//   code-route.js: `operation` in the body not read                                    => (10)/(14)/(17)/(18) red (400 instead of 200)
//   devtools/routes.js: without "unsettled" (uploadBegins without { unsettled })       => (10)/(14)/(17)/(18) red (finished 202 instead of UPLOAD_RUNNING while the body is missing)
//   code-route.js: without the OPERATION_LOCATION row of the workspace level           => (10)/(14)/(17)/(18) red (200: the chunk lay at the target)
//   code-route.js: an empty operation in the body counts as none                       => (10)/(14)/(17)/(18) red (400 instead of 409)
//   server.js: start lock of the language service without setupRunning                 => (12) red (lsp/rename: the start hangs at the exec gate)
//   code-route.js: workspace level asks without the files                              => (12) red (rename outside the project 409)
//   procedure.js: CODE_REPO_LOCATION without assignment to the source                  => (8) both red (source staged)
//   setup/routes.js: leave out does not reset the other source                         => (8) gap 3 red (stays error CODE_REPO_LOCATION)
//   setup/routes.js: the way back only for PLACE                                       => (8) both red (stays error CODE_REPO_LOCATION)
//   procedure.js: createProjectRepo without `harden`                                   => (2) red ("git rev-parse without GIT_HARDENING")
//   serverEnd.js: no snapshot at `desired = null` (the literal reading)                => (2) red (0 snapshots instead of 1)
//   restore.js: `desired = null` means "start all inner ones"                          => (2) red (an inner container started)
//   procedure.js stepContainer: without the boot-id stamp                              => (6) container red (after the restart `setup` instead of INTERRUPTED)
//   procedure.js createContainerAt: createInstance directly (without createCliHome)    => (6) before createCliHome red (error CONTAINER: "CLI home of the project missing")
//   app-state.js: the boot id only at the first startServer (module constant)          => (6) code-repos red (the old row holds busy)
//   procedure.js serverStep: without the "instance not ready" guard                    => (6) code-repos red (exec against the stopped container before atReady)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BOOT_ID } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";
import { cliHomeFolder } from "../electron/server/projectbox/cli-home.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { recreateRequest, cleanUpRecreate, recreateStatus } from "../electron/server/projectbox/recreate.js";
import { GIT_HARDENING, carriesProjectRepoMarker } from "../electron/server/projectbox/projectRepo.js";
import { projectboxServerEnd } from "../electron/server/projectbox/serverEnd.js";
import { restoreInstance } from "../electron/server/projectbox/restore.js";
import { setupProcedureAlive, resumeSetup, setSetupSaveGate } from "../electron/server/projectbox/setup/procedure.js";
import { serviceScans } from "../electron/server/projects/scans.js";
import { createProjectFolder } from "../electron/server/projectbox/setup/routes.js";
import { chunkBegins } from "../electron/server/projectbox/setup/operation.js";
import { locationFor, worktreeRoot } from "../electron/server/runs/runtime-location.js";
import { slugify } from "../electron/server/workspaces/git-auth.js";
import { storageQueueSources, wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { HOSTS_TEST, ID } from "./projectbox-scenario.mjs";

// ── Shared: the harness lives in ./setup-harness.mjs ──────────────────────────────────────────────────────────────

import {
  ONLY_IN_OPS_TEXT, REAL_GIT, fakeGit, gitHold, gitWaiting, gitContinue, dx, git,
  read, request, active, setupRoute, gateClosed, withCreation, waitUntil, finished,
  inSources, create, staging, write, uploadedRepo, viewIn, b64, upload,
  inProject, inWorkspace, openChunkRequest, withoutAccount, CLAUDE_TURN, turns, cliEnvironment, send,
  runsNull, turnRan, kindSituation,
} from "./setup-harness.mjs";

// ── (1) Validation of the POST ────────────────────────────────────────────────────────────────────────────────────

test("(1) POST in server mode: 400 with code, and nothing is created — no folder, no project, no row, no docker", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const wsPath = path.join(ctx.root, "workspace");
    const folderPrior = fs.readdirSync(wsPath).sort();
    const projectsPrior = store.listAllProjects().length;
    const cases = [
      [{ name: "Old", path: path.join(wsPath, "old") }, "PATH_IN_OPS"],
      [{ name: "Old", path: path.join(wsPath, "old"), sources: [] }, "PATH_IN_OPS"],
      [{ name: "  ", sources: [] }, "NAME_MISSING"],
      [{ name: "No sources" }, "SOURCES_MISSING"],
      [{ name: "Zip", sources: [{ kind: "zip", target: "" }] }, "MAPPING"], // zip accepted, the mapping is mandatory
      [{ name: "Clone", sources: [{ kind: "clone", target: "k" }] }, "ONLY_HTTPS"], // clone accepted, without `clone` no address
      [{ name: "Unknown", sources: [{ kind: "svn", target: "k" }] }, "SOURCE_UNKNOWN"],
      [{ name: "Git", sources: [{ kind: "folder", target: ".git" }] }, "TARGET_INVALID"],
      [{ name: "cbase", sources: [{ kind: "folder", target: ".cbase-source-1" }] }, "TARGET_INVALID"],
      [{ name: "Absolute", sources: [{ kind: "files", target: "/etc" }] }, "TARGET_INVALID"],
      [{ name: "Folder without target", sources: [{ kind: "folder", target: "" }] }, "TARGET_INVALID"],
      [{ name: "Duplicate", sources: [{ kind: "folder", target: "a" }, { kind: "folder", target: "a" }] }, "TARGET_DUPLICATE"],
      [{ name: "Repo in repo", sources: [], codeRepos: ["a", "a/b"] }, "CODE_REPO_LOCATION"],
      [{ name: "Dot folder", sources: [], codeRepos: [".hidden/a"] }, "CODE_REPO_LOCATION"],
      [{ name: "Too deep", sources: [], codeRepos: ["a/b/c/d/e/f/g/h"] }, "CODE_REPO_LOCATION"],
    ];
    for (const [body, code] of cases) {
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body });
      assert.equal(r.status, 400, `${code}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, code, JSON.stringify(r.body));
      assert.equal(typeof r.body.error, "string");
    }
    assert.deepEqual(fs.readdirSync(wsPath).sort(), folderPrior, "no folder was created");
    assert.equal(store.listAllProjects().length, projectsPrior, "no project was created");
    assert.deepEqual(store.projectInstances(), [], "no instance row");
    assert.deepEqual(store.setups(), [], "no setup");
    assert.deepEqual(fd.calls(), [], "no docker");
    // The folder without a workspace folder: FOLDER, nothing created.
    assert.throws(() => createProjectFolder(path.join(ctx.root, "exists-not"), "x"), (e) => e.code === "FOLDER" && e.status === 400);
    assert.equal(fs.existsSync(path.join(ctx.root, "exists-not")), false);
  });
});

// ── (2) An empty project ──────────────────────────────────────────────────────────────────────────────────────────

test("(2) empty project: 201 with setup and a converted instance, container ready, project repo with ONE commit “Creation” (hardened, in the container), row gone, events; `desired` null across crash, server end and restore", async () => {
  await withCreation(async ({ ctx, fd, s, detected, reader }) => {
    // B's `~/.local`: B's `.profile`/`.bashrc` load `~/.local/bin/env` -- a new project got an empty `~/.local`, and `sh -l`
    // ended every service start. The setup copies like the relocation, without assignment.
    const bLocal = path.join(s.home, ".local");
    for (const [rel, content] of [["bin/env", "export PATH=\"$HOME/.local/bin:$PATH\"\n"], ["share/uv/python/marker", "uv\n"],
      ["state/foreign/state", "state of another project\n"], ["share/foreign/data", "project-bound\n"]]) {
      fs.mkdirSync(path.dirname(path.join(bLocal, rel)), { recursive: true });
      fs.writeFileSync(path.join(bLocal, rel), content);
    }
    const health = await request(`${ctx.base}/api/health`);
    assert.deepEqual(health.body, { ok: true, projectCreation: "container" });
    // The clients read the setup mode at the rules route (/api/health is answered by the gateway).
    assert.equal((await request(`${ctx.base}/api/projectCreation/rules`)).body.mode, "container");
    const proj = await create(ctx, { name: "Empty project", sources: [] });
    const pid = proj.id;
    assert.equal(proj.path, path.join(path.resolve(path.join(ctx.root, "workspace")), slugify("Empty project")));
    assert.equal(proj.instance?.converted, true, "the instance is converted from the first row");
    assert.deepEqual(proj.setup, { state: "setUp", step: "container", sources: [], phase: "prepare", waiting: "container" });
    assert.ok(store.projectInstance(pid, "main")?.convertedAt, "converted_at is in the row");
    const location = locationFor({ projectId: pid, converted: true });
    assert.ok(fs.statSync(worktreeRoot(location)).isDirectory(), "worktree root before the first run");
    assert.ok(fs.statSync(cliHomeFolder(pid).local).isDirectory(), "~/.local per project");

    await finished(pid);
    const inst = store.projectInstance(pid, "main");
    assert.equal(inst.state, "ready");
    assert.ok(inst.containerId);
    assert.equal(store.setupOf(pid), null, "the row is gone");
    const pLocal = cliHomeFolder(pid).local;
    assert.equal(fs.readFileSync(path.join(pLocal, "bin", "env"), "utf8"), fs.readFileSync(path.join(bLocal, "bin", "env"), "utf8"), "B's ~/.local/bin/env in the project");
    assert.ok(fs.existsSync(path.join(pLocal, "share", "uv", "python", "marker")), "share/uv is shared");
    assert.equal(fs.existsSync(path.join(pLocal, "state", "foreign")), false, "nothing from state/");
    assert.equal(fs.existsSync(path.join(pLocal, "share", "foreign")), false, "nothing project-bound from share/");
    assert.equal(carriesProjectRepoMarker(proj.path), true, "project repo with marker");
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"], "exactly one commit “Creation”");
    const execs = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").map((a) => a.args);
    assert.ok(execs.some((a) => a.includes("git") && a.includes("init")), "git init ran in the container");
    // EVERY git of the project repo ran through docker exec WITH GIT_HARDENING, the commit "Creation" with the commit hardening (the
    // own pre-commit under .git/hooks, no gpg) -- the project home's `~/.gitconfig` is written by the agent.
    const gitInContainer = execs.filter((a) => a.includes("git")).map((a) => {
      const g = a.slice(a.indexOf("git") + 1);
      let i = 0;
      while (g[i] === "-c") i += 2;
      return { before: g.slice(0, i).join(" "), command: g[i] === "--literal-pathspecs" ? g[i + 1] : g[i], g };
    });
    const commands = new Set(gitInContainer.map((x) => x.command));
    for (const b of ["init", "config", "add", "commit", "rev-parse"]) assert.ok(commands.has(b), `git ${b} ran in the container (${[...commands].join(", ")})`);
    for (const x of gitInContainer) {
      if (x.command === "commit") {
        for (const c of ["core.fsmonitor=false", "core.hooksPath=.git/hooks", "core.untrackedCache=false", "protocol.allow=never", "commit.gpgSign=false"]) {
          assert.ok(x.before.includes(`-c ${c}`), `git commit without -c ${c}: ${x.g.join(" ")}`);
        }
      } else assert.ok(x.before.includes(GIT_HARDENING.join(" ")), `git ${x.command} without GIT_HARDENING: ${x.g.join(" ")}`);
    }
    assert.ok(gitInContainer.some((x) => x.command === "commit" && x.g.includes("Creation")), "the commit “Creation” through docker exec");
    assert.deepEqual(detected, [], "an empty project: no services detection");
    const view = await viewIn(ctx, pid);
    assert.equal(view.setup, undefined, "no field after the end");
    assert.equal(view.instance.state, "ready");

    await waitForTruthy(() => reader.events.some((e) => e.type === "project/setup" && e.projectId === pid && e.state === "finished"), "event finished");
    const ev = reader.events.filter((e) => e.type === "project/setup" && e.projectId === pid);
    assert.deepEqual(ev[0], { type: "project/setup", projectId: pid, state: "setUp", step: "container" });
    assert.deepEqual(ev.at(-1), { type: "project/setup", projectId: pid, state: "finished", step: "project-repo" });
    for (const e of ev) assert.deepEqual(Object.keys(e).filter((k) => !["type", "projectId", "state", "step", "source"].includes(k)), [], "ids, states, codes only");
    const a = await active(ctx.base);
    assert.equal(a.setupOpen, 0);
    assert.equal(a.setupError, 0);
    assert.equal(a.withoutInstanceRow, 0);
    assert.equal(a.uploadsActive, 0);

    // `desired` (see the file header, "desired = null"): the setup writes none (no instance start-up in the setup).
    assert.equal(store.projectInstance(pid, "main").desired ?? null, null, "the setup wrote no desired");
    const inside = (n) => Object.fromEntries(Object.values(fd.state(n).container).map((c) => [c.name, c.status]));
    const insideStarts = (n) => fd.calls({ daemon: n }).filter((x) => x.args[0] === "start").length;
    // (i) Server end with `desired = null`: the snapshot is the state of NOW -- an inner container that a chat started since the
    // setup (P1: chats run from wait-upload on) is in it and runs again after the restore; a stopped one stays off. A `desired` that
    // STAYED null across the server end (the literal reading) would leave it off.
    const name = containerName(pid, "main");
    dx(fd, "exec", name, "docker", "run", "-d", "--name", "old", "img");
    dx(fd, "exec", name, "docker", "stop", "old");
    dx(fd, "exec", name, "docker", "run", "-d", "--name", "app", "img");
    const end = await projectboxServerEnd();
    assert.equal(end.snapshots, 1);
    assert.deepEqual(store.projectInstance(pid, "main").desired.container.map((c) => [c.name, c.state]).sort(), [["app", "running"], ["old", "exited"]]);
    assert.deepEqual(inside(name), { app: "exited", old: "exited" }, "the server end stopped the project container including the inner ones");
    await restoreInstance(pid, "main", { reason: "Test: after the server end" });
    assert.equal(store.projectInstance(pid, "main").state, "ready");
    assert.deepEqual(inside(name), { app: "running", old: "exited" }, "desired ∩ present");

    // (ii) Crash (no server end) with `desired = null`: the restore starts NOTHING and becomes ready -- null means "nothing should
    // run", not "unknown, start everything". A second empty project (since (i) the first carries a snapshot).
    const p2 = await create(ctx, { name: "Empty project 2", sources: [] });
    await finished(p2.id, "second empty project");
    assert.equal(store.projectInstance(p2.id, "main").desired ?? null, null);
    const name2 = containerName(p2.id, "main");
    dx(fd, "exec", name2, "docker", "run", "-d", "--name", "x", "img");
    dx(fd, "exec", name2, "docker", "stop", "x");
    dx(fd, "stop", name2);
    const startsPrior = insideStarts(name2);
    await restoreInstance(p2.id, "main", { reason: "Test: crash after the setup" });
    assert.equal(store.projectInstance(p2.id, "main").state, "ready");
    assert.equal(insideStarts(name2), startsPrior, "desired = null: no inner container started");
    assert.deepEqual(inside(name2), { x: "exited" });
  }, { fdOpts: { stopsInside: true } });
});

// ── (4)/(5) Container failed, "Try again" ─────────────────────────────────────────────────────────────────────────

test("(4)/(5) container failed => error CONTAINER; “Try again” removes ONLY the own leftover container (stop -t 30, rm without -f) and finishes", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "Broken", sources: [] });
    const pid = proj.id;
    const e = await waitUntil(pid, (x) => x?.state === "error", "setup fails", { errorAllowed: true });
    assert.equal(e.code, "CONTAINER", JSON.stringify(e));
    assert.equal(store.projectInstance(pid, "main").state, "error");
    const view = await viewIn(ctx, pid);
    assert.equal(view.setup.state, "error");
    assert.equal(view.setup.code, "CONTAINER");
    // `error` carries only the reason -- whoever shows it sets the prefix (web, iOS).
    assert.ok(view.setup.error, "a reason is there");
    assert.doesNotMatch(view.setup.error, /Einrichtung gescheitert|Setup failed/);
    const a = await active(ctx.base);
    assert.equal(a.setupError, 1);
    assert.equal(a.setupOpen, 0);
    assert.ok(!a.projectWork.some((x) => x.projectId === pid), "error is no work");
    assert.equal(a.busy, false);

    // A leftover container of THIS project (a creation that ended before its teardown) and a foreign one.
    const config = path.join(fd.dir, "config.json");
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(read(config)), brokenImages: [] }));
    const rest = dx(fd, "run", "-d", "--name", containerName(pid), "--label", `cbase.project=${pid}`, "--label", "cbase.instance=main", "cbase-projectbox:latest");
    const foreign = dx(fd, "run", "-d", "--name", "foreign", "--label", "cbase.project=one-other", "--label", "cbase.instance=main", "cbase-projectbox:latest");
    const mark = fd.calls().length;
    const r = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.setup.state, "setUp");
    await finished(pid);
    const afterwards = fd.calls().slice(mark).map((x) => x.args);
    const iStop = afterwards.findIndex((x) => x[0] === "stop" && x.includes(rest));
    const iRm = afterwards.findIndex((x) => x[0] === "rm" && x.includes(rest));
    const iRun = afterwards.findIndex((x) => x[0] === "run");
    assert.ok(iStop >= 0 && iRm > iStop && iRun > iRm, `stop → rm → run: ${JSON.stringify(afterwards.filter((x) => ["stop", "rm", "run"].includes(x[0])))}`);
    assert.deepEqual(afterwards[iStop], ["stop", "-t", "30", rest]);
    assert.deepEqual(afterwards[iRm], ["rm", rest], "rm by id, without -f");
    assert.ok(!afterwards.some((x) => x.includes(foreign)), "the foreign container stays untouched");
    assert.ok(fd.state().container[foreign], "the foreign container is still there");
    const inst = store.projectInstance(pid, "main");
    assert.equal(inst.state, "ready");
    assert.notEqual(inst.containerId, rest);
    const again = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "NO_SETUP");
  }, { fdOpts: { brokenImages: [ID] } });
});

// ── (6) INTERRUPTED and the continuation through atReady ──────────────────────────────────────────────────────────

test("(6) a server step of an earlier process: outwards INTERRUPTED, not in projectWork; the transition to ready continues it", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Interrupted", sources: [{ kind: "files", target: "", bytes: 4 }] });
    const pid = proj.id;
    await inSources(pid);
    const b = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 4 } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    write(path.join(staging(proj, 1), "a.txt"), "one");
    // The state an earlier process left in the middle of placing.
    store.changeSource(pid, 1, { state: "staged" });
    store.changeProjectUpload(b.body.operation, { state: "place" });
    store.changeSetup(pid, { step: "place", process: "one-previous-process" });
    assert.notEqual(BOOT_ID, "one-previous-process");

    const view = await viewIn(ctx, pid);
    assert.equal(view.setup.state, "error");
    assert.equal(view.setup.code, "INTERRUPTED");
    assert.equal(view.setup.step, "place");
    const all = (await request(`${ctx.base}/api/projects`)).body;
    assert.equal(all.find((p) => p.id === pid).setup.code, "INTERRUPTED", "/api/projects computes the same view");
    const a = await active(ctx.base);
    assert.equal(a.setupError, 1);
    assert.ok(!a.projectWork.some((x) => x.projectId === pid), "a foreign boot id never holds");

    await restoreInstance(pid, "main", { state: "start", reason: "Test" });
    await new Promise((r) => setImmediate(r)); // the microtick in which atReady calls its receivers
    assert.ok(setupProcedureAlive(pid) || !store.setupOf(pid), "the receiver at atReady did not run");
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "one");
    assert.equal(fs.existsSync(staging(proj, 1)), false);
  });
});

// ── (7) Sources and code repo ─────────────────────────────────────────────────────────────────────────────────────

test("(7) two sources and a code repo: staging in the container, .git file dropped, code repo with ONE empty commit (B's identity), project repo without x", async () => {
  await withCreation(async ({ ctx, detected }) => {
    const proj = await create(ctx, {
      name: "With sources", sources: [{ kind: "folder", target: "x", name: "x", bytes: 20 }, { kind: "files", target: "", bytes: 6 }], codeRepos: ["x"],
    });
    const pid = proj.id;
    assert.deepEqual(proj.setup.sources.map((q) => [q.seq, q.kind, q.target, q.state]), [[1, "folder", "x", "wait-upload"], [2, "files", "", "wait-upload"]]);
    await inSources(pid);
    for (const seq of [1, 2]) assert.ok(fs.statSync(staging(proj, seq)).isDirectory(), `staging ${seq} created in the container`);
    const view = await viewIn(ctx, pid);
    assert.deepEqual({ ...view.setup, sources: undefined }, { state: "setUp", step: "sources", sources: undefined });

    for (const [seq, bytes] of [[1, 20], [2, 6]]) {
      const r = await request(setupRoute(ctx.base, pid, `sources/${seq}/begin`), { method: "POST", body: { bytes } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    write(path.join(staging(proj, 1), "x", "a.txt"), "hello");
    write(path.join(staging(proj, 1), "x", "sub", "b.txt"), "world");
    write(path.join(staging(proj, 1), "x", "lib", ".git"), "gitdir: /etc\n"); // absolute => dropped
    write(path.join(staging(proj, 2), "readme.md"), "# Hi\n");
    const f1 = await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" });
    assert.equal(f1.status, 202, JSON.stringify(f1.body));
    assert.equal(f1.body.setup.sources[0].state, "staged");
    assert.equal(store.setupOf(pid).step, "sources", "source 2 is still missing");
    const f2 = await request(setupRoute(ctx.base, pid, "sources/2/finished"), { method: "POST" });
    assert.equal(f2.status, 202, JSON.stringify(f2.body));
    await finished(pid);

    const x = path.join(proj.path, "x");
    assert.equal(read(path.join(x, "a.txt")), "hello");
    assert.equal(read(path.join(x, "sub", "b.txt")), "world");
    assert.equal(fs.existsSync(path.join(x, "lib", ".git")), false, "the .git file without a valid target was dropped");
    assert.equal(read(path.join(proj.path, "readme.md")), "# Hi\n");
    assert.ok(fs.statSync(path.join(x, ".git")).isDirectory(), "x is a code repo");
    assert.deepEqual(git(x, "log", "--format=%an <%ae>|%s").split("\n"), ["Test Nutzer <test@example.invalid>|Code repo created (cbase)"]);
    assert.equal(git(x, "ls-tree", "-r", "--name-only", "HEAD"), "", "the commit is empty");
    assert.match(git(x, "status", "--porcelain"), /^\?\? /m, "the files stay untracked");
    const inProjectRepo = git(proj.path, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
    assert.deepEqual(inProjectRepo, ["readme.md"], "the project repo excludes the code repo x");
    assert.match(read(path.join(proj.path, ".git", "info", "exclude")), /^\/\.cbase-\*\/$/m, "staging excluded");
    for (const seq of [1, 2]) assert.equal(fs.existsSync(staging(proj, seq)), false, `staging ${seq} gone`);
    assert.deepEqual(store.projectUploadsOf(pid), [], "the operations of the setup are gone");
    assert.deepEqual(detected, [pid], "services detection exactly once");
  });
});

// ── (8) Code repos on the real tree ───────────────────────────────────────────────────────────────────────────────

test("(8) on the real tree: uploaded repo stays, collection folder stays a folder; a repo that the repo search does not see => CODE_REPO_LOCATION", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, {
      name: "Tree", sources: [{ kind: "folder", target: "r", bytes: 0 }, { kind: "folder", target: "sam", bytes: 0 }], codeRepos: ["r", "sam"],
    });
    const pid = proj.id;
    await inSources(pid);
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/begin`), { method: "POST", body: { bytes: 0 } })).status, 200);
    const head = uploadedRepo(path.join(staging(proj, 1), "r"));
    write(path.join(staging(proj, 1), "r", "code.js"), "1\n");
    const inside = uploadedRepo(path.join(staging(proj, 2), "sam", "inner"));
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/finished`), { method: "POST" })).status, 202);
    await finished(pid);
    assert.equal(git(path.join(proj.path, "r"), "rev-parse", "HEAD"), head, "the uploaded repo got no commit");
    assert.deepEqual(git(path.join(proj.path, "r"), "log", "--format=%s").split("\n"), ["uploaded"]);
    assert.equal(fs.existsSync(path.join(proj.path, "sam", ".git")), false, "the collection folder stays a normal folder");
    assert.equal(git(path.join(proj.path, "sam", "inner"), "rev-parse", "HEAD"), inside);
    assert.deepEqual(git(proj.path, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean), [], "both repos excluded");

    // Two `.git` folders nested in ONE source are one repo with content (the client's rule, project-setup-findings.test.js) -- the
    // error on the real tree stays for a place the repo search does not see.
    const p2 = await create(ctx, { name: "Hidden", sources: [{ kind: "folder", target: "a", bytes: 0 }] });
    await inSources(p2.id);
    assert.equal((await request(setupRoute(ctx.base, p2.id, "sources/1/begin"), { method: "POST", body: { bytes: 0 } })).status, 200);
    uploadedRepo(path.join(staging(p2, 1), "a", ".hidden", "r"));
    assert.equal((await request(setupRoute(ctx.base, p2.id, "sources/1/finished"), { method: "POST" })).status, 202);
    const e = await waitUntil(p2.id, (x) => x?.state === "error", "repo in a dot folder", { errorAllowed: true });
    assert.equal(e.code, "CODE_REPO_LOCATION", JSON.stringify(e));
    assert.equal(fs.existsSync(path.join(p2.path, "a")), false, "nothing placed");
    assert.ok(fs.existsSync(path.join(staging(p2, 1), "a", ".hidden", "r", ".git")), "the staging stays");
    // The error carries its source -- "Continue without this source" => 202, and the setup runs to the end without it.
    assert.deepEqual(e.sources.map((q) => [q.seq, q.state, q.code]), [[1, "error", "CODE_REPO_LOCATION"]]);
    assert.match(e.sources[0].error, /Repo-Suche nicht sieht/);
    assert.doesNotMatch(e.sources[0].error, /Einrichtung gescheitert|Setup failed/, "the source carries only the reason, too");
    const w = await request(setupRoute(ctx.base, p2.id, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    await finished(p2.id, "finished without source 1");
    assert.equal(fs.existsSync(path.join(p2.path, "a")), false, "the left-out source did not get into the project");
    assert.equal(fs.existsSync(staging(p2, 1)), false, "its staging was removed in the container");
    assert.deepEqual(git(p2.path, "log", "--format=%s").split("\n"), ["Creation"], "project repo");
  });
});

test("(8) repo in repo across TWO sources => both error CODE_REPO_LOCATION, a third stays staged; leaving out the inner one => the outer one is checked again and placed", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, {
      name: "Two repos", sources: [{ kind: "folder", target: "a", bytes: 0 }, { kind: "folder", target: "a/b", bytes: 0 }, { kind: "files", target: "", bytes: 1 }],
    });
    const pid = proj.id;
    await inSources(pid);
    for (const seq of [1, 2, 3]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/begin`), { method: "POST", body: { bytes: 0 } })).status, 200);
    const outside = uploadedRepo(path.join(staging(proj, 1), "a"));
    write(path.join(staging(proj, 1), "a", "x.txt"), "x");
    uploadedRepo(path.join(staging(proj, 2), "a", "b"));
    write(path.join(staging(proj, 3), "free.txt"), "f");
    for (const seq of [1, 2, 3]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/finished`), { method: "POST" })).status, 202);
    const e = await waitUntil(pid, (x) => x?.state === "error", "repo in repo across two sources", { errorAllowed: true });
    assert.equal(e.code, "CODE_REPO_LOCATION", JSON.stringify(e));
    assert.deepEqual(e.sources.map((q) => [q.seq, q.state, q.code]), [[1, "error", "CODE_REPO_LOCATION"], [2, "error", "CODE_REPO_LOCATION"], [3, "staged", ""]]);
    for (const q of e.sources.slice(0, 2)) assert.match(q.error, /a\/b liegt in a \(Repo im Repo\)/, `source ${q.seq}`);
    assert.equal(fs.existsSync(path.join(proj.path, "a")), false, "nothing placed");
    assert.equal(fs.existsSync(path.join(proj.path, "free.txt")), false);

    const w = await request(setupRoute(ctx.base, pid, "sources/2/leaveOut"), { method: "POST" });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    await finished(pid, "finished without the inner source");
    assert.equal(git(path.join(proj.path, "a"), "rev-parse", "HEAD"), outside, "the outer repo arrived as uploaded");
    assert.equal(read(path.join(proj.path, "a", "x.txt")), "x");
    assert.equal(fs.existsSync(path.join(proj.path, "a", "b")), false, "the inner one did not");
    assert.equal(read(path.join(proj.path, "free.txt")), "f");
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"], "project repo");
  });
});

// ── (9) Without server mode ───────────────────────────────────────────────────────────────────────────────────────

test("(9) without server mode: rules 200, the setup routes 404, health “folder”, the POST as before, no field, no docker", async () => {
  await withAgentsServer(async (ctx) => {
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID } });
    const prior = process.env.CBASE_DOCKER_BIN;
    try {
      process.env.CBASE_DOCKER_BIN = fd.bin;
      const rules = await request(`${ctx.base}/api/projectCreation/rules`);
      assert.equal(rules.status, 200);
      assert.equal(rules.body.reserveBytes, 5_000_000_000);
      assert.equal(rules.body.names.prefix, ".cbase-");
      assert.ok(rules.body.omit.folder.includes("node_modules"));
      assert.deepEqual(Object.keys(rules.body).sort(), ["limits", "mode", "names", "omit", "reserveBytes"]);
      assert.equal(rules.body.mode, "folder", "the setup mode at the rules route");
      assert.deepEqual((await request(`${ctx.base}/api/health`)).body, { ok: true, projectCreation: "folder" });

      const filePath = path.join(ctx.root, "workspace", "old");
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Old", path: filePath } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.setup, undefined);
      assert.equal(r.body.instance, undefined);
      assert.equal(store.projectInstance(r.body.id, "main"), null, "no instance row without server mode");
      assert.equal(store.setupOf(r.body.id), null);
      for (const rest of ["again", "conflict", "sources/1/begin", "sources/1/finished", "sources/1/abort", "sources/1/leaveOut"]) {
        const x = await request(setupRoute(ctx.base, r.body.id, rest), { method: "POST", body: {} });
        assert.equal(x.status, 404, rest);
        assert.match(x.body.error, ONLY_IN_OPS_TEXT, rest);
      }
      // A row in the store (never created without server mode) does not show without server mode.
      store.createSetup({ projectId: r.body.id, sources: [], codeRepos: [] });
      const list = (await request(`${ctx.base}/api/workspaces`)).body.find((w) => w.id === ctx.ws.id);
      assert.equal(list.projects.find((p) => p.id === r.body.id).setup, undefined);
      assert.equal((await request(`${ctx.base}/api/workspaces/${ctx.ws.id}`)).body.projects.find((p) => p.id === r.body.id).setup, undefined);
      assert.equal((await request(`${ctx.base}/api/projects`)).body.find((p) => p.id === r.body.id).setup, undefined);
      const a = await active(ctx.base);
      assert.equal(a.withoutInstanceRow, 0, "0 without server mode");
      assert.equal(a.uploadsActive, 0);
      assert.deepEqual(fd.calls(), [], "no docker without server mode");
      store.deleteSetup(r.body.id);
    } finally {
      if (prior === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = prior;
      fd.cleanUp();
    }
  });
});

// ── (10)/(18) projectWork, busy, begin ────────────────────────────────────────────────────────────────────────────

test("(10)/(18) projectWork: one entry during creation, none while waiting, `setup` in the server step; begin: sizes, operation, UPLOAD_RUNNING, uploadsActive", async () => {
  await withCreation(async ({ ctx, fd }) => {
    // (10) The creation at the gate: the status file is read through exec.
    const proj = await create(ctx, { name: "At the gate", sources: [{ kind: "files", target: "", bytes: 10 }] });
    const pid = proj.id;
    await fd.gateReached("exec");
    let a = await active(ctx.base);
    const entries = a.projectWork.filter((x) => x.projectId === pid);
    assert.equal(entries.length, 1, JSON.stringify(a.projectWork));
    assert.equal(entries[0].state, "create");
    assert.equal(a.busy, true);
    assert.equal(a.setupOpen, 1);
    fd.openGate("exec");
    await inSources(pid);
    a = await active(ctx.base);
    assert.ok(!a.projectWork.some((x) => x.projectId === pid), `no work while waiting for the upload: ${JSON.stringify(a.projectWork)}`);
    assert.equal(a.setupOpen, 1);
    assert.equal(a.busy, false);
    const againWaiting = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(againWaiting.status, 409);
    assert.equal(againWaiting.body.code, "WAITING_FOR_UPLOAD");

    // (18) begin.
    const begin = (body) => request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body });
    assert.equal((await begin({})).body.code, "BYTES");
    assert.equal((await begin({ bytes: -1 })).body.code, "BYTES");
    for (const filePath of ["/etc/passwd", ".git/config", ".cbase-source-1/a", "a/../b"]) {
      const r = await begin({ bytes: 10, paths: [{ path: filePath }] });
      assert.equal(r.status, 400, filePath);
      assert.equal(r.body.code, "PATHS", filePath);
    }
    const first = await begin({ bytes: 10, paths: [{ path: "a.txt" }, { path: "x/.git/HEAD" }] });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.existing, []);
    const v = first.body.operation;
    write(path.join(staging(proj, 1), "a.txt"), "12345");
    const second = await begin({ bytes: 10, paths: [{ path: "a.txt" }, { path: "x/.git/HEAD" }], operation: v });
    assert.equal(second.status, 200);
    assert.equal(second.body.operation, v, "the same operation");
    assert.deepEqual(second.body.existing, [{ path: "a.txt", size: 5 }]);
    const foreign = await begin({ bytes: 10, operation: "one-foreign-operation" });
    assert.equal(foreign.status, 409);
    assert.equal(foreign.body.code, "OPERATION_FOREIGN");

    const end = chunkBegins(v);
    try {
      for (const [rest, body] of [["sources/1/begin", { bytes: 10 }], ["sources/1/finished", undefined], ["sources/1/leaveOut", undefined]]) {
        const r = await request(setupRoute(ctx.base, pid, rest), { method: "POST", body });
        assert.equal(r.status, 409, rest);
        assert.equal(r.body.code, "UPLOAD_RUNNING", rest);
      }
      a = await active(ctx.base);
      assert.equal(a.uploadsActive, 1);
      assert.equal(a.busy, true, "an open chunk holds busy");
    } finally { end(); }
    const q = (await viewIn(ctx, pid)).setup.sources[0];
    assert.equal(typeof q.lastChunk, "number", "lastChunk in the view");

    // (10) The server step `place` at the gate.
    gateClosed(fd, "exec");
    const f = await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" });
    assert.equal(f.status, 202, JSON.stringify(f.body));
    await fd.gateReached("exec");
    await waitForTruthy(() => store.setupOf(pid)?.step === "place", "step place");
    a = await active(ctx.base);
    const inStep = a.projectWork.filter((x) => x.projectId === pid);
    assert.deepEqual(inStep.map((x) => [x.instance, x.state, x.phase]), [["main", "setUp", "place"]], JSON.stringify(a.projectWork));
    assert.deepEqual(Object.keys(inStep[0]).sort(), ["instance", "phase", "projectId", "since", "state"]);
    assert.equal(a.busy, true);
    const again = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(again.body.code, "RUNNING");
    const way = await request(setupRoute(ctx.base, pid, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(way.body.code, "RUNNING");
    const view = await viewIn(ctx, pid);
    assert.deepEqual([view.setup.state, view.setup.step, view.setup.code], ["setUp", "place", undefined]);
    fd.openGate("exec");
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "12345");
  }, { fdOpts: { execGate: "exec" } });
});

// ── (15) A link at the slug's place ───────────────────────────────────────────────────────────────────────────────

test("(15) a link at the slug's place: the project folder becomes <slug>-2, the link's target stays empty", async () => {
  await withCreation(async ({ ctx }) => {
    const ws = path.join(ctx.root, "workspace");
    const outside = path.join(ctx.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(ws, slugify("Reference")));
    const proj = await create(ctx, { name: "Reference", sources: [] });
    assert.equal(proj.path, path.join(ws, `${slugify("Reference")}-2`));
    await finished(proj.id);
    assert.deepEqual(fs.readdirSync(outside), [], "the link's target stays empty");
    assert.ok(fs.lstatSync(path.join(ws, slugify("Reference"))).isSymbolicLink());
  });
});

// ── (16) SLOT, link in the target, leaving out ────────────────────────────────────────────────────────────────────

test("(16) SLOT 409 with free/needed; a link in the target => error PLACE, the target stays empty; leaving out cleans up in the container and continues", async () => {
  await withCreation(async ({ ctx, setFree }) => {
    const proj = await create(ctx, { name: "Space", sources: [{ kind: "folder", target: "x", bytes: 10 }] });
    const pid = proj.id;
    await inSources(pid);
    setFree(1000);
    const tight = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 10 } });
    assert.equal(tight.status, 409, JSON.stringify(tight.body));
    assert.equal(tight.body.code, "SLOT");
    assert.equal(tight.body.free, 1000);
    assert.equal(tight.body.needed, 10 + 5_000_000_000);
    setFree(10 ** 13);
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 10 } })).status, 200);
    write(path.join(staging(proj, 1), "x", "a.txt"), "content");
    // An agent created `x` as a link to the outside.
    const outside = path.join(ctx.root, "outside-16");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(proj.path, "x"));
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    const e = await waitUntil(pid, (x) => x?.state === "error", "placing fails at the link", { errorAllowed: true });
    assert.equal(e.code, "PLACE", JSON.stringify(e));
    assert.equal(e.sources[0].state, "error");
    assert.equal(e.sources[0].code, "PLACE");
    assert.deepEqual(fs.readdirSync(outside), [], "never written through the link");
    assert.ok(fs.existsSync(path.join(staging(proj, 1), "x", "a.txt")), "the rest lies in the staging");

    const w = await request(setupRoute(ctx.base, pid, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    assert.equal(w.body.setup.sources[0].state, "leftOut");
    await finished(pid);
    assert.equal(fs.existsSync(staging(proj, 1)), false, "the staging was removed in the container");
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});

// ── (17) Conflict ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(17) conflict: `conflict` waits (does not hold busy); skip => byte-equal, overwrite => replaced, abort => TARGET_OCCUPIED with staging", async () => {
  await withCreation(async ({ ctx }) => {
    const untilConflict = async (name) => {
      const proj = await create(ctx, { name, sources: [{ kind: "files", target: "", bytes: 3 }] });
      await inSources(proj.id);
      assert.equal((await request(setupRoute(ctx.base, proj.id, "sources/1/begin"), { method: "POST", body: { bytes: 3 } })).status, 200);
      write(path.join(staging(proj, 1), "a.txt"), "fresh");
      fs.writeFileSync(path.join(proj.path, "a.txt"), "old"); // an agent wrote it while the chats were running
      assert.equal((await request(setupRoute(ctx.base, proj.id, "sources/1/finished"), { method: "POST" })).status, 202);
      await waitUntil(proj.id, (e) => e?.waiting === "conflict", "waits for a conflict answer");
      return proj;
    };
    const p1 = await untilConflict("Conflict one");
    const view = await viewIn(ctx, p1.id);
    assert.equal(view.setup.waiting, "conflict");
    assert.deepEqual(view.setup.conflict, { existing: 1, examples: ["a.txt"] });
    const a = await active(ctx.base);
    assert.ok(!a.projectWork.some((x) => x.projectId === p1.id), "a conflict waits for a human — no work");
    assert.equal((await request(setupRoute(ctx.base, p1.id, "conflict"), { method: "POST", body: { mode: "anything" } })).body.code, "MODE");
    const r1 = await request(setupRoute(ctx.base, p1.id, "conflict"), { method: "POST", body: { mode: "skip" } });
    assert.equal(r1.status, 202, JSON.stringify(r1.body));
    await finished(p1.id);
    assert.equal(read(path.join(p1.path, "a.txt")), "old", "skip: byte-equal");
    assert.equal(fs.existsSync(staging(p1, 1)), false);
    assert.equal((await request(setupRoute(ctx.base, p1.id, "conflict"), { method: "POST", body: { mode: "skip" } })).body.code, "NO_SETUP");

    const p2 = await untilConflict("Conflict two");
    assert.equal((await request(setupRoute(ctx.base, p2.id, "conflict"), { method: "POST", body: { mode: "overwrite" } })).status, 202);
    await finished(p2.id);
    assert.equal(read(path.join(p2.path, "a.txt")), "fresh", "overwrite: replaced");

    const p3 = await untilConflict("Conflict three");
    const r3 = await request(setupRoute(ctx.base, p3.id, "conflict"), { method: "POST", body: { mode: "abort" } });
    assert.equal(r3.status, 202);
    assert.equal(r3.body.setup.state, "error");
    assert.equal(r3.body.setup.code, "TARGET_OCCUPIED");
    assert.equal(read(path.join(p3.path, "a.txt")), "old");
    assert.equal(read(path.join(staging(p3, 1), "a.txt")), "fresh", "the staging stays");
    assert.equal((await request(setupRoute(ctx.base, p3.id, "conflict"), { method: "POST", body: { mode: "skip" } })).body.code, "NO_CONFLICT");
    store.deleteSetup(p3.id);
  });
});

// ── (21) Deleting ─────────────────────────────────────────────────────────────────────────────────────────────────

const rowsOf = (pid) => Object.fromEntries(["project_setup", "project_setup_source", "project_archive", "project_upload"]
  .map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).get(pid).n]));
const archiveRow = (pid) => db.prepare("INSERT INTO project_archive (archive_id, project_id, created_at) VALUES (?, ?, ?)").run(`a-${pid}`, pid, Date.now());

test("(21) deleting project and workspace takes all four tables with it — even without an instance row — and the upload stamp", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Throw away", sources: [{ kind: "files", target: "", bytes: 1 }] });
    await inSources(proj.id);
    const b = await request(setupRoute(ctx.base, proj.id, "sources/1/begin"), { method: "POST", body: { bytes: 1 } });
    assert.equal(b.status, 200);
    archiveRow(proj.id);
    chunkBegins(b.body.operation)(); // a chunk just began (the stamp holds until the upload is quiet)
    assert.deepEqual(rowsOf(proj.id), { project_setup: 1, project_setup_source: 1, project_archive: 1, project_upload: 1 });
    assert.equal((await active(ctx.base)).uploadsActive, 1);
    const d = await request(`${ctx.base}/api/projects/${proj.id}`, { method: "DELETE" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(rowsOf(proj.id), { project_setup: 0, project_setup_source: 0, project_archive: 0, project_upload: 0 });
    assert.equal((await active(ctx.base)).uploadsActive, 0, "the upload stamp went with it");

    // A workspace with a project WITHOUT an instance row (legacy) — the same deletion path.
    const wsPath = path.join(ctx.root, "ws-two");
    fs.mkdirSync(wsPath);
    const ws = (await request(`${ctx.base}/api/workspaces`, { method: "POST", body: { name: "Two", path: wsPath } })).body;
    const pid = "p-without-row";
    fs.mkdirSync(path.join(wsPath, "p"));
    store.addProject(ws.id, { id: pid, name: "Without row", path: path.join(wsPath, "p"), createdAt: Date.now() });
    store.createSetup({ projectId: pid, sources: [{ seq: 1, kind: "files", target: "" }], codeRepos: [] });
    store.createProjectUpload({ operation: "v-without-row", projectId: pid, purpose: "creation", sourceSeq: 1, kind: "files", staging: ".cbase-source-1" });
    archiveRow(pid);
    assert.deepEqual(rowsOf(pid), { project_setup: 1, project_setup_source: 1, project_archive: 1, project_upload: 1 });
    const dw = await request(`${ctx.base}/api/workspaces/${ws.id}`, { method: "DELETE" });
    assert.equal(dw.status, 200, JSON.stringify(dw.body));
    assert.deepEqual(rowsOf(pid), { project_setup: 0, project_setup_source: 0, project_archive: 0, project_upload: 0 });
  });
});

// ── (23) Integration with the detection and the ops status ───────────────────────────────────────────────────────

test("(23) field `detection` from serviceScans on workspace and /api/projects; withoutInstanceRow = the list of the ops status", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "With detection", sources: [] });
    const pid = proj.id;
    await finished(pid);
    assert.equal((await viewIn(ctx, pid)).detection, undefined, "no field without detection");
    serviceScans.set(pid, { status: "done", startedAt: 4711, count: 0 });
    try {
      assert.deepEqual((await viewIn(ctx, pid)).detection, { status: "done", since: 4711 }, "GET /api/workspaces/:id");
      const list = (await request(`${ctx.base}/api/projects`)).body;
      const row = (Array.isArray(list) ? list : list.projects || []).find((p) => p.id === pid);
      assert.deepEqual(row?.detection, { status: "done", since: 4711 }, "GET /api/projects");
    } finally { serviceScans.delete(pid); }

    assert.equal((await active(ctx.base)).withoutInstanceRow, 0);
    const prev = await ctx.projectWithoutInstance({ name: "Legacy project", path: path.join(ctx.root, "workspace", "legacy-data") });
    try {
      assert.equal((await active(ctx.base)).withoutInstanceRow, 1, "the count in /api/runs/active");
      const snapshot = await request(`${ctx.base}/api/projectbox/ops-status`);
      assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
      assert.deepEqual(snapshot.body.withoutInstanceRow, [{ projectId: prev.id, name: "Legacy project" }], "the same list names the names");
    } finally { store.deleteProject(ctx.ws.id, prev.id); }
  });
});

// ── (22) Storage queue ────────────────────────────────────────────────────────────────────────────────────────────

// Only a clone sets `waiting: "storage"`, and a wait behind which no clone source stands in a server state falls at the next kick.
// The real waiting including waking through the storage queue (source "setup") is held by project-clone.test.js; here the
// reconstructed state stands for what it is: a wait from an old state that nobody resolves any more falls, and the setup runs to the
// end with the gate CLOSED.
test("(22) storage queue, source “setup”: registered; a `waiting: storage` without a clone (reconstructed, an old state) falls at the finish report — the setup runs to the end with the gate closed, the queue wakes nothing", async () => {
  await withCreation(async ({ ctx }) => {
    assert.ok(storageQueueSources().includes("setup"), `registered sources: ${storageQueueSources().join(", ")}`);
    setSetupSaveGate(() => false);
    try {
      const proj = await create(ctx, { name: "Storage", sources: [{ kind: "files", target: "", bytes: 2 }] });
      const pid = proj.id;
      await inSources(pid);
      assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
      write(path.join(staging(proj, 1), "s.txt"), "ok");
      store.changeSetup(pid, { waiting: "storage" });
      assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
      await finished(pid, "the wait without a clone did not stay"); // finished = the row is gone; with the old state no procedure lived
      assert.equal(wakeStorageQueue(), 0, "the queue still found something to wake");
      assert.equal(read(path.join(proj.path, "s.txt")), "ok");
    } finally {
      setSetupSaveGate(null);
    }
  });
});

// ── (10)/(14)/(17)/(18) Chunks with an operation ──────────────────────────────────────────────────────────────────

test("(10)/(14)/(17)/(18) chunks with an operation: only into the staging, offset 0 replaces, > 0 only at the same size; the stamp stands at the BEGINNING of the request", async () => {
  const quiet = process.env.CBASE_UPLOAD_QUIET_MS;
  process.env.CBASE_UPLOAD_QUIET_MS = "0"; // only OPEN requests count (upload-stamp.js) — measured through the gate, never through the clock
  try {
    await withCreation(async ({ ctx }) => {
      const proj = await create(ctx, { name: "Chunks", sources: [{ kind: "files", target: "", bytes: 100 }] });
      const pid = proj.id;
      await inSources(pid);
      const b = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 100 } });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      const v = b.body.operation;
      const ready = path.join(staging(proj, 1), "sub", "a.txt");

      // (17) A chunk lands ONLY under the staging.
      let r = await upload(ctx, pid, { files: [{ path: "sub/a.txt", dataB64: b64("hello"), offset: 0 }] }, v);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(fs.existsSync(path.join(proj.path, "sub")), false, "never at the target");
      assert.equal(read(ready), "hello");
      assert.deepEqual(r.body, { written: 1 });

      // (14) offset > 0 that does not match the size => 409 OFFSET with size, the file unchanged; on a missing file
      // => size 0, nothing stays created.
      r = await upload(ctx, pid, { files: [{ path: "sub/a.txt", dataB64: b64("X"), offset: 3 }] }, v);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.code, "OFFSET");
      assert.equal(r.body.size, 5);
      assert.equal(r.body.written, 0);
      assert.equal(read(ready), "hello");
      r = await upload(ctx, pid, { files: [{ path: "fresh.txt", dataB64: b64("X"), offset: 1 }] }, v);
      assert.equal(r.body.code, "OFFSET");
      assert.equal(r.body.size, 0);
      assert.equal(fs.existsSync(path.join(staging(proj, 1), "fresh.txt")), false, "a just-created one is removed again");
      // (18) Resume from `size`.
      r = await upload(ctx, pid, { files: [{ path: "sub/a.txt", dataB64: b64(" world"), offset: 5 }] }, v);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(read(ready), "hello world");
      // (14) offset 0 over a LARGER staged file => replaced.
      r = await upload(ctx, pid, { files: [{ path: "sub/a.txt", dataB64: b64("fresh"), offset: 0 }] }, v);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(read(ready), "fresh", "offset 0 replaces (truncated at the descriptor)");

      // An invalid chunk rejects the WHOLE request before anything is written.
      r = await upload(ctx, pid, { files: [{ path: "b.txt", dataB64: b64("b"), offset: 0 }, { path: "c.txt", dataB64: b64("c") }] }, v);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "CHUNK");
      assert.equal(fs.existsSync(path.join(staging(proj, 1), "b.txt")), false);
      r = await upload(ctx, pid, { files: [{ path: "b.txt", dataB64: b64("b"), append: true, offset: 0 }] }, v);
      assert.equal(r.body.code, "CHUNK", "append only applies without an operation");
      for (const filePath of ["../out.txt", "/abs.txt", ".git/config", ".cbase-source-2/x"]) {
        r = await upload(ctx, pid, { files: [{ path: filePath, dataB64: b64("x"), offset: 0 }] }, v);
        assert.equal(r.status, 400, filePath);
        assert.equal(r.body.code, "CHUNK", filePath);
      }
      // The operation is in the BODY (the clients, all chunks above) OR in the address. In the address => likewise into the staging;
      // equal in both => likewise; different => 400 OPERATION_LOCATION, nothing written. An empty or unknown operation in the body =>
      // 409 OPERATION_UNKNOWN, NEVER to the target (the key alone decides, not its value).
      r = await upload(ctx, pid, { files: [{ path: "address.txt", dataB64: b64("a"), offset: 0 }] }, v, { location: "address" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(read(path.join(staging(proj, 1), "address.txt")), "a");
      r = await request(`${ctx.base}/api/projects/${pid}/upload?operation=${encodeURIComponent(v)}`, { method: "POST", body: { operation: v, files: [{ path: "both.txt", dataB64: b64("b"), offset: 0 }] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(read(path.join(staging(proj, 1), "both.txt")), "b");
      r = await request(`${ctx.base}/api/projects/${pid}/upload?operation=${encodeURIComponent(v)}`, { method: "POST", body: { operation: "one-other", files: [{ path: "two.txt", dataB64: b64("z"), offset: 0 }] } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "OPERATION_LOCATION");
      for (const wrong of ["", "exists-not", null, 7]) {
        r = await request(`${ctx.base}/api/projects/${pid}/upload`, { method: "POST", body: { operation: wrong, files: [{ path: "body.txt", dataB64: b64("x"), offset: 0 }] } });
        assert.equal(r.status, 409, `${JSON.stringify(wrong)}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, "OPERATION_UNKNOWN", JSON.stringify(wrong));
      }
      for (const n of ["two.txt", "body.txt"]) {
        assert.equal(fs.existsSync(path.join(proj.path, n)), false, `${n} never at the target`);
        assert.equal(fs.existsSync(path.join(staging(proj, 1), n)), false, `${n} not staged`);
      }
      // The workspace level knows no operation: in the address AND in the body 400 OPERATION_LOCATION, nothing written (without that
      // row the route would write the chunk at its path).
      const slug = path.basename(proj.path);
      r = await inWorkspace(ctx, "/upload", { method: "POST", body: { operation: v, files: [{ path: `${slug}/ws-body.txt`, dataB64: b64("w"), offset: 0 }] } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "OPERATION_LOCATION");
      r = await inWorkspace(ctx, "/upload", { method: "POST", query: `operation=${encodeURIComponent(v)}`, body: { files: [{ path: `${slug}/ws-address.txt`, dataB64: b64("w"), offset: 0 }] } });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.code, "OPERATION_LOCATION");
      for (const n of ["ws-body.txt", "ws-address.txt"]) assert.equal(fs.existsSync(path.join(proj.path, n)), false, `${n} never written`);
      // An unknown operation in the address => 409 before the body is read.
      r = await upload(ctx, pid, { files: [] }, "exists-not", { location: "address" });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, "OPERATION_UNKNOWN");

      // (10)/(18) The stamp at the BEGINNING: while the chunk request is open (its body is still missing), it counts in uploadsActive
      // and busy, and a second tab gets UPLOAD_RUNNING.
      const open = await openChunkRequest(ctx, pid, v);
      let end = null;
      try {
        const a = await active(ctx.base);
        assert.equal(a.uploadsActive, 1, "the open chunk request counts");
        assert.equal(a.busy, true);
        const second = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 100 } });
        assert.equal(second.status, 409);
        assert.equal(second.body.code, "UPLOAD_RUNNING", "the second tab");
      } finally {
        end = await open.end({ files: [{ path: "gate.txt", dataB64: b64("gate"), offset: 0 }] });
      }
      assert.equal(end.status, 200, JSON.stringify(end.body));
      assert.equal(read(path.join(staging(proj, 1), "gate.txt")), "gate");
      assert.equal((await active(ctx.base)).uploadsActive, 0, "after the end of the request");

      // The same open request on the CLIENTS' route — the address carries no operation, it comes only with the body. Until then it is
      // "unsettled" and counts for every operation of its project: `finished` AND `begin` => UPLOAD_RUNNING, uploadsActive 1.
      store.changeProjectUpload(v, { lastChunk: 0 });
      const openBody = await openChunkRequest(ctx, pid, null);
      let endBody = null;
      try {
        const a = await active(ctx.base);
        assert.equal(a.uploadsActive, 1, "the open chunk request without an operation in the address counts");
        assert.equal(a.busy, true);
        const tooEarly = await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" });
        assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));
        assert.equal(tooEarly.body.code, "UPLOAD_RUNNING", "finished waits for the open chunk");
        const second = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 100 } });
        assert.equal(second.body.code, "UPLOAD_RUNNING", "the second tab");
      } finally {
        endBody = await openBody.end({ operation: v, files: [{ path: "gate2.txt", dataB64: b64("gate2"), offset: 0 }] });
      }
      assert.equal(endBody.status, 200, JSON.stringify(endBody.body));
      assert.equal(read(path.join(staging(proj, 1), "gate2.txt")), "gate2");
      assert.equal(fs.existsSync(path.join(proj.path, "gate2.txt")), false, "never at the target");
      assert.equal((await active(ctx.base)).uploadsActive, 0, "after the end of the request (body)");
      assert.ok(store.projectUpload(v).lastChunk > 0, "the chunk from the body stamps the operation");

      // Reported finished: the operation accepts no chunk afterwards; at the end everything lies at the target.
      assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
      r = await upload(ctx, pid, { files: [{ path: "late.txt", dataB64: b64("x"), offset: 0 }] }, v);
      assert.equal(r.status, 409);
      assert.ok(["OPERATION_CLOSED", "OPERATION_UNKNOWN"].includes(r.body.code), JSON.stringify(r.body));
      await finished(pid);
      assert.equal(read(path.join(proj.path, "sub", "a.txt")), "fresh");
      assert.equal(read(path.join(proj.path, "gate.txt")), "gate");
      assert.equal(read(path.join(proj.path, "gate2.txt")), "gate2");
      assert.equal(read(path.join(proj.path, "address.txt")), "a");
      assert.equal(fs.existsSync(path.join(proj.path, "late.txt")), false);
    });
  } finally {
    if (quiet === undefined) delete process.env.CBASE_UPLOAD_QUIET_MS; else process.env.CBASE_UPLOAD_QUIET_MS = quiet;
  }
});

// ── (12) The setup's write lock ───────────────────────────────────────────────────────────────────────────────────

test("(12) SETUP_RUNNING: during a server step 409 for every write route at project and workspace level (paths in the project), reading works; in wait-upload 200", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "Locked", sources: [{ kind: "files", target: "", bytes: 5 }] });
    const pid = proj.id;
    const slug = path.basename(proj.path);
    fd.openGate("exec");
    await inSources(pid);

    // In wait-upload the routes are open (P1) — as for the chats.
    let r = await inProject(ctx, pid, "/files/write", { method: "PUT", body: { path: "w.txt", content: "w" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await inProject(ctx, pid, "/upload", { method: "POST", body: { dir: "", files: [{ path: "u.txt", dataB64: b64("u") }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `${slug}/ws.txt`, content: "ws" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(read(path.join(proj.path, "ws.txt")), "ws");
    // Two TypeScript files for the language service — one in the project, one in the workspace outside it.
    const TS = "export const old = 1;\nexport const again = old + 1;\n";
    const tsPos = { line: 0, character: TS.indexOf("old") };
    const agentRename = (file) => request(`${ctx.base}/api/lsp`, { method: "POST", body: { file, action: "rename", line: 1, column: tsPos.character + 1, newName: "fresh" } });
    write(path.join(proj.path, "r.ts"), TS);
    write(path.join(ctx.root, "workspace", "outside.ts"), TS);

    const b = await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 5 } });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    write(path.join(staging(proj, 1), "a.txt"), "one");
    gateClosed(fd, "exec");
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    await fd.gateReached("exec");
    await waitForTruthy(() => store.setupOf(pid)?.step === "place", "step place");

    const locked = (x, what) => {
      assert.equal(x.status, 409, `${what}: ${JSON.stringify(x.body)}`);
      assert.equal(x.body.code, "SETUP_RUNNING", what);
      assert.equal(x.body.projectId, pid, what);
      assert.equal(typeof x.body.error, "string", what);
    };
    // Project level: every write route, before any effect (git does not even call the container — the exec gate is closed).
    locked(await inProject(ctx, pid, "/files/write", { method: "PUT", body: { path: "w.txt", content: "fresh" } }), "files/write");
    locked(await inProject(ctx, pid, "/files/create", { method: "POST", body: { path: "c.txt", type: "file" } }), "files/create");
    locked(await inProject(ctx, pid, "/files/rename", { method: "POST", body: { from: "w.txt", to: "w2.txt" } }), "files/rename");
    // Copying is a write route like renaming (the request's paths name `from` AND `to`).
    locked(await inProject(ctx, pid, "/files/copy", { method: "POST", body: { from: "w.txt", to: "w3.txt" } }), "files/copy");
    locked(await inProject(ctx, pid, "/files", { method: "DELETE", query: "path=w.txt" }), "DELETE files");
    locked(await inProject(ctx, pid, "/upload", { method: "POST", body: { dir: "", files: [{ path: "u2.txt", dataB64: b64("u") }] } }), "upload without an operation");
    locked(await inProject(ctx, pid, "/git/commit", { method: "POST", body: { repo: "", message: "x" } }), "git/commit");
    // The language service (lsp/). During the lock no language server starts (the core's start lock in server.js — the exec gate is
    // closed, a start would hang here): editor and agent route answer `supported:false` with `state: "off"`, the file stays. The editor
    // route never writes anyway; the agent route additionally asks the setup lock before writing (`beforeWrite`, lsp-core.test.js).
    for (const [x, what] of [
      [await inProject(ctx, pid, "/lsp/rename", { method: "POST", body: { file: "r.ts", position: tsPos, newName: "fresh" } }), "lsp/rename"],
      [await inWorkspace(ctx, "/lsp/rename", { method: "POST", body: { file: `${slug}/r.ts`, position: tsPos, newName: "fresh" } }), "ws lsp/rename in the project"],
      [await agentRename(path.join(proj.path, "r.ts")), "api/lsp rename"],
    ]) {
      assert.equal(x.status, 200, `${what}: ${JSON.stringify(x.body)}`);
      assert.equal(x.body.supported, false, `${what}: ${JSON.stringify(x.body)}`);
      assert.equal(x.body.state, "off", `${what}: ${JSON.stringify(x.body)}`);
    }
    assert.equal(read(path.join(proj.path, "r.ts")), TS, "the language service wrote nothing");
    // Next to it: no project under the file => `no_project` — there is no workspace language server.
    r = await inWorkspace(ctx, "/lsp/rename", { method: "POST", body: { file: "outside.ts", position: tsPos, newName: "fresh" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.supported, r.body.reason], [false, "no_project"], JSON.stringify(r.body));
    assert.equal(read(path.join(ctx.root, "workspace", "outside.ts")), TS);
    assert.equal(read(path.join(proj.path, "w.txt")), "w", "nothing written");
    assert.equal(fs.existsSync(path.join(proj.path, "c.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "w2.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "w3.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "u2.txt")), false);
    // Reading works.
    const read2 = await inProject(ctx, pid, "/files/read", { query: "path=w.txt" });
    assert.equal(read2.status, 200, JSON.stringify(read2.body));
    assert.equal(read2.body.content, "w");
    // A chunk WITH an operation: the operation accepts nothing more during placing.
    r = await upload(ctx, pid, { files: [{ path: "z.txt", dataB64: b64("z"), offset: 0 }] }, b.body.operation);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.ok(["OPERATION_CLOSED", "SETUP_RUNNING"].includes(r.body.code), JSON.stringify(r.body));
    // Workspace level: only paths in the project — or a parent folder of the project (the workspace root for git).
    locked(await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `${slug}/ws2.txt`, content: "x" } }), "ws files/write");
    locked(await inWorkspace(ctx, "/files", { method: "DELETE", query: `path=${encodeURIComponent(slug)}` }), "ws DELETE project folder");
    locked(await inWorkspace(ctx, "/upload", { method: "POST", body: { dir: "", files: [{ path: `${slug}/u3.txt`, dataB64: b64("u") }] } }), "ws upload");
    locked(await inWorkspace(ctx, "/git/commit", { method: "POST", body: { repo: "", message: "x" } }), "ws git at the root");
    r = await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: "outside.txt", content: "d" } });
    assert.equal(r.status, 200, `open outside the project: ${JSON.stringify(r.body)}`);
    locked(await inWorkspace(ctx, "/files/rename", { method: "POST", body: { from: "outside.txt", to: `${slug}/into.txt` } }), "ws rename into the project");
    locked(await inWorkspace(ctx, "/files/copy", { method: "POST", body: { from: "outside.txt", to: `${slug}/copy-into.txt` } }), "ws copy into the project");
    // … and a copy entirely outside the project stays open: the lock knows `from`/`to` (without them the root counted — locked).
    r = await inWorkspace(ctx, "/files/copy", { method: "POST", body: { from: "outside.txt", to: "outside-copy.txt" } });
    assert.equal(r.status, 201, `copying outside the project open: ${JSON.stringify(r.body)}`);
    r = await inWorkspace(ctx, "/upload", { method: "POST", body: { dir: "", files: [{ path: "free.txt", dataB64: b64("f") }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    fs.symlinkSync(proj.path, path.join(ctx.root, "workspace", "reference"));
    locked(await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: "reference/v.txt", content: "v" } }), "ws through a link to the project");
    assert.equal(fs.existsSync(path.join(proj.path, "ws2.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "u3.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "into.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "copy-into.txt")), false);
    assert.equal(fs.existsSync(path.join(proj.path, "v.txt")), false);
    assert.equal(read(path.join(ctx.root, "workspace", "outside.txt")), "d");
    assert.equal(read(path.join(ctx.root, "workspace", "free.txt")), "f");

    fd.openGate("exec");
    await finished(pid);
    assert.equal(read(path.join(proj.path, "a.txt")), "one");
    r = await inWorkspace(ctx, "/files/write", { method: "PUT", body: { path: `${slug}/ws2.txt`, content: "x" } });
    assert.equal(r.status, 200, `open after the end: ${JSON.stringify(r.body)}`);
    r = await inProject(ctx, pid, "/files/write", { method: "PUT", body: { path: "w.txt", content: "fresh" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // After the end: the language server starts (in the project container, test/fake-lsp.mjs); the editor gets the change as
    // `{ edit }` and writes itself — the file stays; the agent writes.
    r = await inProject(ctx, pid, "/lsp/rename", { method: "POST", body: { file: "r.ts", position: tsPos, newName: "fresh" } });
    assert.equal(r.status, 200, `lsp/rename after the end: ${JSON.stringify(r.body)}`);
    assert.deepEqual((r.body.edit?.changes || []).map((c) => c.file), ["r.ts"], JSON.stringify(r.body));
    assert.equal(read(path.join(proj.path, "r.ts")), TS, "the editor route never writes");
    r = await agentRename(path.join(proj.path, "r.ts"));
    assert.equal(r.status, 200, `api/lsp rename open after the end: ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body.changed, [path.join(proj.path, "r.ts")], JSON.stringify(r.body));
    assert.equal(read(path.join(proj.path, "r.ts")), TS.replaceAll("old", "fresh"));
  }, { fdOpts: { execGate: "exec" }, environment: () => ({ CBASE_LSP_FAKE: JSON.stringify([process.execPath, new URL("./fake-lsp.mjs", import.meta.url).pathname]) }) });
});

// ── (11) Deleting ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(11) deleting during `code-repos` (git init at the gate) => 409 OCCUPIED, nothing deleted; in wait-upload it works — afterwards no row", async () => {
  await withCreation(async ({ ctx, gitGates, fd }) => {
    const a = await create(ctx, { name: "At the repo", sources: [{ kind: "folder", target: "x", bytes: 2 }], codeRepos: ["x"] });
    await inSources(a.id);
    assert.equal((await request(setupRoute(ctx.base, a.id, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
    write(path.join(staging(a, 1), "x", "a.txt"), "ok");
    gitHold(gitGates, "init");
    assert.equal((await request(setupRoute(ctx.base, a.id, "sources/1/finished"), { method: "POST" })).status, 202);
    await gitWaiting(gitGates, "init");
    assert.equal(store.setupOf(a.id).step, "code-repos");
    const d = await request(`${ctx.base}/api/projects/${a.id}`, { method: "DELETE" });
    assert.equal(d.status, 409, JSON.stringify(d.body));
    assert.equal(d.body.code, "OCCUPIED");
    assert.match(d.body.error, /Einrichtung/);
    assert.ok(store.getProject(a.id), "the project still stands");
    assert.equal(store.projectInstance(a.id, "main")?.state, "ready");
    assert.equal(store.setupOf(a.id)?.step, "code-repos", "the setup stands unchanged");
    assert.ok(fs.existsSync(path.join(a.path, "x", "a.txt")));
    gitContinue(gitGates, "init");
    await finished(a.id);
    assert.ok(fs.statSync(path.join(a.path, "x", ".git")).isDirectory(), "code-repos ran to the end after the gate");

    const b = await create(ctx, { name: "Waiting", sources: [{ kind: "files", target: "", bytes: 1 }] });
    await inSources(b.id);
    const name = containerName(b.id);
    assert.ok(Object.values(fd.state().container).some((c) => c.name === name), "the project container is running");
    const way = await request(`${ctx.base}/api/projects/${b.id}`, { method: "DELETE" });
    assert.equal(way.status, 200, JSON.stringify(way.body));
    assert.ok(!store.getProject(b.id), "the project is gone");
    assert.deepEqual(store.projectInstancesOf(b.id), [], "no instance row");
    assert.equal(store.setupOf(b.id), null);
    assert.ok(!Object.values(fd.state().container).some((c) => c.name === name), "the project container is gone");
  });
});

// ── (13) Copy lock ────────────────────────────────────────────────────────────────────────────────────────────────

test("(13) copy start while a setup is open => 409 NO_COPY_DURING_SETUP — in wait-upload and in error, no copy row", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Without copy", sources: [{ kind: "files", target: "", bytes: 1 }] });
    await inSources(proj.id);
    const c = await request(`${ctx.base}/api/chats`, { method: "POST", body: { workspaceId: ctx.ws.id, projectId: proj.id } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const copy = () => request(`${ctx.base}/api/projects/${proj.id}/stack-copies`, { method: "POST", body: { chatId: c.body.id } });
    let r = await copy();
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "NO_COPY_DURING_SETUP", "in wait-upload");
    store.changeSetup(proj.id, { state: "error", code: "PLACE", error: "Test" });
    r = await copy();
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "NO_COPY_DURING_SETUP", "in error");
    assert.deepEqual(store.liveStackCopies(proj.id), [], "no copy row");
  });
});

// ── (20) .git file ────────────────────────────────────────────────────────────────────────────────────────────────

test("(20) .git file: relative gitdir to .git/modules/… comes along (submodule, no init); an absolute target => left out", async () => {
  await withCreation(async ({ ctx }) => {
    // An uploaded repo with a submodule: `repo/sub/.git` is a FILE with `gitdir: ../.git/modules/sub`.
    const source = path.join(ctx.root, "submodule-source");
    uploadedRepo(path.join(source, "sub-src"));
    const repo = path.join(source, "repo");
    uploadedRepo(repo);
    execFileSync("git", ["-C", repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", path.join(source, "sub-src"), "sub"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "sub"]);
    assert.match(read(path.join(repo, "sub", ".git")), /^gitdir: \.\.\/\.git\/modules\/sub/);
    const subHead = git(path.join(repo, "sub"), "rev-parse", "HEAD");

    const proj = await create(ctx, {
      name: "Submodule", sources: [{ kind: "folder", target: "repo", bytes: 10 }, { kind: "folder", target: "foreign", bytes: 1 }], codeRepos: ["repo/sub"],
    });
    const pid = proj.id;
    await inSources(pid);
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/begin`), { method: "POST", body: { bytes: 1 } })).status, 200);
    fs.cpSync(repo, path.join(staging(proj, 1), "repo"), { recursive: true });
    // A worktree of another machine: absolute gitdir — never arrived.
    write(path.join(staging(proj, 2), "foreign", ".git"), "gitdir: /elsewhere/repo/.git/worktrees/foreign\n");
    write(path.join(staging(proj, 2), "foreign", "f.txt"), "f");
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/finished`), { method: "POST" })).status, 202);
    await finished(pid);

    const inProj = path.join(proj.path, "repo");
    const status = execFileSync("git", ["-C", inProj, "submodule", "status"], { encoding: "utf8" });
    assert.match(status, new RegExp(`^ ${subHead} sub`), status); // leading space: checked out, at the recorded state
    const gitFile = path.join(inProj, "sub", ".git");
    assert.ok(fs.existsSync(gitFile) && fs.lstatSync(gitFile).isFile(), "the .git file came along");
    assert.equal(git(path.join(inProj, "sub"), "rev-parse", "HEAD"), subHead);
    assert.deepEqual(git(path.join(inProj, "sub"), "log", "--format=%s").split("\n"), ["uploaded"], "no init, no commit in the submodule");
    assert.equal(fs.existsSync(path.join(proj.path, "foreign", ".git")), false, "absolute target => left out");
    assert.equal(read(path.join(proj.path, "foreign", "f.txt")), "f");
  });
});

// ── (20b) File modes of an uploaded repo ──────────────────────────────────────────────────────────────────────────

test("(20b) uploaded repo: the browser transmits no modes — a script executable in the index gets its x bit back, a 100644 file stays without", async () => {
  await withCreation(async ({ ctx }) => {
    const repo = path.join(ctx.root, "permissions-source", "repo");
    uploadedRepo(repo);
    write(path.join(repo, "scripts", "run.sh"), "#!/bin/sh\necho run\n");
    fs.chmodSync(path.join(repo, "scripts", "run.sh"), 0o755);
    write(path.join(repo, "readme.txt"), "text\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=U", "-c", "user.email=u@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "scripts"]);
    assert.match(execFileSync("git", ["-C", repo, "ls-files", "-s", "scripts/run.sh"], { encoding: "utf8" }), /^100755 /);

    const proj = await create(ctx, { name: "Modes", sources: [{ kind: "folder", target: "repo", bytes: 10 }], codeRepos: ["repo"] });
    const pid = proj.id;
    await inSources(pid);
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 1 } })).status, 200);
    const target = path.join(staging(proj, 1), "repo");
    fs.cpSync(repo, target, { recursive: true });
    fs.chmodSync(path.join(target, "scripts", "run.sh"), 0o644); // as from the browser: every file 0644
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    await finished(pid);

    const inProj = path.join(proj.path, "repo");
    assert.equal(fs.statSync(path.join(inProj, "scripts", "run.sh")).mode & 0o100, 0o100, "x bit restored from the index");
    assert.equal(fs.statSync(path.join(inProj, "readme.txt")).mode & 0o111, 0, "a 100644 file stays without an x bit");
    assert.equal(execFileSync("git", ["-C", inProj, "status", "--porcelain"], { encoding: "utf8" }), "", "no mode change in the repo");
    assert.deepEqual(git(inProj, "log", "--format=%s").split("\n"), ["scripts", "uploaded"], "no commit by cbase in the uploaded repo");
  });
});

// ── (16) Two sources, one fails; IN_REPO ─────────────────────────────────────────────────────────────────────────

test("(16) two sources: one error, the other staged => the setup holds; leaving out => placing, code repo and project repo run; IN_REPO for a workspace inside a repo", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Two sources", sources: [{ kind: "folder", target: "x", bytes: 1 }, { kind: "folder", target: "y", bytes: 1 }], codeRepos: ["y"] });
    const pid = proj.id;
    await inSources(pid);
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/begin`), { method: "POST", body: { bytes: 1 } })).status, 200);
    write(path.join(staging(proj, 1), "x", "a.txt"), "x");
    write(path.join(staging(proj, 2), "y", "b.txt"), "y");
    const outside = path.join(ctx.root, "outside-16-two");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(proj.path, "x")); // source 1 fails at the link in the target
    for (const seq of [1, 2]) assert.equal((await request(setupRoute(ctx.base, pid, `sources/${seq}/finished`), { method: "POST" })).status, 202);
    const e = await waitUntil(pid, (x) => x?.state === "error", "source 1 fails", { errorAllowed: true });
    assert.equal(e.code, "PLACE", JSON.stringify(e));
    assert.deepEqual(e.sources.map((q) => [q.seq, q.state]), [[1, "error"], [2, "staged"]]);
    assert.equal(fs.existsSync(path.join(proj.path, "y")), false, "the setup holds: y waits in its staging");
    assert.equal(read(path.join(staging(proj, 2), "y", "b.txt")), "y");
    assert.equal(fs.existsSync(path.join(proj.path, ".git")), false, "no project repo while it holds");

    const w = await request(setupRoute(ctx.base, pid, "sources/1/leaveOut"), { method: "POST" });
    assert.equal(w.status, 202, JSON.stringify(w.body));
    await finished(pid);
    assert.equal(read(path.join(proj.path, "y", "b.txt")), "y");
    assert.deepEqual(git(path.join(proj.path, "y"), "log", "--format=%s").split("\n"), ["Code repo created (cbase)"], "Code-Repo y");
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"], "Projekt-Repo");
    assert.deepEqual(fs.readdirSync(outside), [], "never written through the link");

    // IN_REPO: someone put a .git over the workspace.
    execFileSync("git", ["init", "-q", path.join(ctx.root, "workspace")]);
    const p2 = await create(ctx, { name: "In repo", sources: [] });
    const e2 = await waitUntil(p2.id, (x) => x?.state === "error", "IN_REPO", { errorAllowed: true });
    assert.equal(e2.code, "IN_REPO", JSON.stringify(e2));
    assert.equal(fs.existsSync(path.join(p2.path, ".git")), false, "no project repo in the foreign repo");
  });
});

// ── (3) Turns during the setup ───────────────────────────────────────────────────────────────────────────────────

test("(3) turns: in `create` and in `place` it waits (locked) and then runs in the project container — never in B; in wait-upload it runs at once (P1)", async () => {
  await withoutAccount(() => withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "With turns", sources: [{ kind: "files", target: "", bytes: 3 }] });
    const pid = proj.id;
    await fd.gateReached("exec"); // the creation reads the status file through exec
    assert.equal(store.projectInstance(pid, "main").state, "create");
    const p = await request(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: { projectId: pid } });
    assert.equal(p.status, 200, JSON.stringify(p.body));

    // In `create`: waits.
    let r = await send(ctx, "IN-CREATE");
    assert.equal(r.body.queued, true, JSON.stringify(r.body));
    assert.equal(r.body.locked, true, JSON.stringify(r.body));
    assert.equal((await active(ctx.base)).runs, 0, "no turn during the creation");
    fd.openGate("exec");
    await turnRan(ctx, "IN-CREATE", "the turn after the creation");
    await runsNull(ctx);
    await inSources(pid);

    // In wait-upload: runs at once (P1).
    r = await send(ctx, "IM-WAIT");
    assert.equal(r.body.queued, false, `chats run while waiting for the upload: ${JSON.stringify(r.body)}`);
    await turnRan(ctx, "IM-WAIT", "the turn while waiting");
    await runsNull(ctx);

    // In `place` (at the gate): waits.
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 3 } })).status, 200);
    write(path.join(staging(proj, 1), "t.txt"), "abc");
    gateClosed(fd, "exec");
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    await fd.gateReached("exec");
    await waitForTruthy(() => store.setupOf(pid)?.step === "place", "step place");
    const prior = turns(ctx.root).length;
    r = await send(ctx, "IM-PLACE");
    assert.equal(r.body.queued, true, `a turn ran during placing: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.locked, true, JSON.stringify(r.body));
    assert.equal((await active(ctx.base)).runs, 0, "no turn during placing");
    assert.equal(turns(ctx.root).length, prior);
    fd.openGate("exec");
    await finished(pid);
    await turnRan(ctx, "IM-PLACE", "the turn after placing");
    await runsNull(ctx);

    // In the fake docker's log: EVERY turn ran through exec in the project container (never in B), the first after the container's
    // `run`, the last after the creation commit (the server steps after placing held it too).
    const all = fd.calls();
    const cli = all.map((a, i) => (a.daemon === "host" && a.args[0] === "exec" && a.args.includes(process.env.CLAUDE_BIN) ? i : -1)).filter((i) => i >= 0);
    assert.equal(cli.length, turns(ctx.root).length, `every turn through exec: ${cli.length} exec, ${turns(ctx.root).length} turns`);
    assert.equal(turns(ctx.root).length, 3);
    const run = all.findIndex((a) => a.daemon === "host" && a.args[0] === "run");
    const commit = all.map((a, i) => (a.daemon === "host" && a.args[0] === "exec" && a.args.includes("commit") ? i : -1)).filter((i) => i >= 0);
    assert.ok(run >= 0 && cli[0] > run, `the first turn before the container (CLI ${cli[0]}, run ${run})`);
    assert.ok(commit.length && cli.at(-1) > commit.at(-1), `the last turn before the creation commit (CLI ${cli.at(-1)}, commit ${commit.at(-1)})`);
  }, { claude: CLAUDE_TURN, environment: cliEnvironment, fdOpts: { execGate: "exec" } }));
});

// ── (6) Recreate continues a setup that stayed standing ──────────────────────────────────────────────────────────

test("(6) recreate: a setup that stayed in `container` (instance error, foreign boot id) continues after the recreate with `sources` (atReady of the restore inside the recreate and setRecreateFinished — each carries alone)", async () => {
  await withCreation(async ({ ctx }) => {
    const proj = await create(ctx, { name: "Recreated", sources: [{ kind: "files", target: "", bytes: 2 }] });
    const pid = proj.id;
    await inSources(pid);
    const oldId = store.projectInstance(pid, "main").containerId;
    // The state after a restart in the middle of `container`: the "project-instances" hook set the row to error, the step
    // carries the earlier process's boot id.
    setInstanceState(pid, "main", "error", { error: "Restart during the creation (test)" });
    store.changeSetup(pid, { step: "container", process: "one-previous-process" });
    const view = await viewIn(ctx, pid);
    assert.equal(view.instance.state, "error");
    assert.deepEqual([view.setup.state, view.setup.code, view.setup.step], ["error", "INTERRUPTED", "container"]);
    try {
      assert.equal(recreateRequest({ projectId: pid, reason: "Test (6)" }), true, "earmarked");
      await waitForTruthy(() => {
        const st = recreateStatus(pid);
        if (st.last && st.last.ok === false && !st.earmarked) throw new Error(`recreate rejected: ${JSON.stringify(st.last)}`);
        return !st.active && !st.earmarked && store.projectInstance(pid, "main")?.state === "ready";
      }, "recreate finished");
      await new Promise((r) => setImmediate(r)); // the finish report calls the hook in the next tick
      const e = await waitUntil(pid, (x) => x?.step === "sources", "the setup continues with sources");
      assert.notEqual(e.process, "one-previous-process");
      assert.notEqual(store.projectInstance(pid, "main").containerId, oldId, "a new container");
      assert.equal((await viewIn(ctx, pid)).setup.state, "setUp");
      assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
      write(path.join(staging(proj, 1), "n.txt"), "ok");
      assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
      await finished(pid);
      assert.equal(read(path.join(proj.path, "n.txt")), "ok");
    } finally {
      cleanUpRecreate();
    }
  });
});

// ── (6) Real restarts: in `container` (server as a process), before createCliHome, in `code-repos` ─────────────────
// In-process (`restart()`) ONLY for `code-repos`: there the server step is a row with a boot id, and the old procedure in module
// memory can be ended at the git gate. In `container`, `restart()` would keep the creation's procedure (createInstance) alive in
// memory, the post-start hook is switched off — the old procedure would finish the step itself; there the restart is the server
// as a process (`childProcess: true`, crash()).

test("(6) restart in `container` (server as a process, creation at the exec gate): instance error, row INTERRUPTED, does not hold busy; “Try again” removes the leftover container and continues with `sources`", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-setup-kind6-"));
  const situation = kindSituation(root);
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin);
  const dfFile = path.join(root, "df-free");
  fs.writeFileSync(dfFile, String(10 ** 13));
  fs.writeFileSync(path.join(bin, "df"), `#!/bin/sh\necho "    Avail"\n/bin/cat '${dfFile}'\n`, { mode: 0o755 });
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: situation.programs, execGate: "exec" });
  const environment = {
    CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECTBOX_TICK_MS: "10",
    CBASE_PROJECTBOX_CREATION_MS: "3600000", CBASE_HOSTS_FILE: HOSTS_TEST, CBASE_PROJECT_STAGE_MS: "3600000",
    CBASE_NETWORK_ROOT: situation.creation.root, HOME: situation.home, PATH: `${bin}:${process.env.PATH}`,
    CBASE_TEST_CREATION_OPTIONS: JSON.stringify(situation.creation),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(environment)) process.env[k] = v;
    await withAgentsServer(async (ctx) => {
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Restart in the container", sources: [{ kind: "files", target: "", bytes: 2 }] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const proj = r.body;
      await fd.gateReached("exec"); // the creation stands in the step `container` at its first exec into the new container
      assert.equal((await viewIn(ctx, proj.id)).setup.step, "container");
      const rest = Object.values(fd.state().container).find((c) => c.name === containerName(proj.id));
      assert.ok(rest, "the container of the crashed process is created");

      await ctx.crash(); // SIGKILL including the group, then a new server process
      const p = await waitForTruthy(async () => {
        const x = await viewIn(ctx, proj.id);
        return x?.instance?.state === "error" ? x : false;
      }, "the post-start hook sets the instance of the aborted creation to error");
      assert.deepEqual([p.setup.state, p.setup.code, p.setup.step], ["error", "INTERRUPTED", "container"], JSON.stringify(p.setup));
      const a = await active(ctx.base);
      assert.ok(!a.projectWork.some((x) => x.projectId === proj.id), `a foreign boot id never holds: ${JSON.stringify(a.projectWork)}`);
      assert.equal(a.setupError, 1);
      assert.equal(a.busy, false);

      fd.openGate("exec");
      const mark = fd.calls().length;
      const e = await request(setupRoute(ctx.base, proj.id, "again"), { method: "POST" });
      assert.equal(e.status, 202, JSON.stringify(e.body));
      await waitForTruthy(async () => {
        const x = await viewIn(ctx, proj.id);
        if (x?.setup?.state === "error" && x.setup.code !== "INTERRUPTED") throw new Error(`setup error: ${JSON.stringify(x.setup)}`);
        return x?.setup?.step === "sources" && x.instance?.state === "ready";
      }, "the setup continues with sources");
      const afterwards = fd.calls().slice(mark).map((x) => x.args);
      const iStop = afterwards.findIndex((x) => x[0] === "stop" && x.includes(rest.id));
      const iRm = afterwards.findIndex((x) => x[0] === "rm" && x.includes(rest.id));
      const iRun = afterwards.findIndex((x) => x[0] === "run");
      assert.ok(iStop >= 0 && iRm > iStop && iRun > iRm, `stop → rm → run: ${JSON.stringify(afterwards.filter((x) => ["stop", "rm", "run"].includes(x[0])))}`);

      assert.equal((await request(setupRoute(ctx.base, proj.id, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
      write(path.join(staging(proj, 1), "n.txt"), "ok");
      assert.equal((await request(setupRoute(ctx.base, proj.id, "sources/1/finished"), { method: "POST" })).status, 202);
      await waitForTruthy(async () => {
        const x = await viewIn(ctx, proj.id);
        if (x?.setup?.state === "error") throw new Error(`setup error: ${JSON.stringify(x.setup)}`);
        return x && !x.setup && x.instance?.state === "ready";
      }, "setup finished");
      assert.equal(read(path.join(proj.path, "n.txt")), "ok");
      assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"]);
    }, { childProcess: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(6) restart BEFORE createCliHome (row in `container` with a foreign boot id, instance error, no CLI home): “Try again” creates CLI home AND container", async () => {
  await withCreation(async ({ ctx, fd }) => {
    const proj = await create(ctx, { name: "Without CLI home", sources: [] });
    const pid = proj.id;
    const e = await waitUntil(pid, (x) => x?.state === "error", "the container fails at the image", { errorAllowed: true });
    assert.equal(e.code, "CONTAINER", JSON.stringify(e));
    // The state of a process that died after the POST and BEFORE createCliHome: the row in `container` with its boot id, the
    // instance (from the post-start hook) at error, in the CLI home only `~/.local` (the POST creates it) — `.claude` and `.codex` are missing.
    const o = cliHomeFolder(pid);
    for (const d of [o.claude, o.codex]) fs.rmSync(d, { recursive: true, force: true });
    assert.ok(fs.statSync(o.local).isDirectory());
    store.changeSetup(pid, { state: "setUp", code: "", error: "", process: "one-previous-process" });
    assert.equal(store.projectInstance(pid, "main").state, "error");
    const view = await viewIn(ctx, pid);
    assert.deepEqual([view.setup.state, view.setup.code, view.setup.step], ["error", "INTERRUPTED", "container"]);

    const config = path.join(fd.dir, "config.json");
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(read(config)), brokenImages: [] }));
    const r = await request(setupRoute(ctx.base, pid, "again"), { method: "POST" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await finished(pid, "finished after “Try again”");
    for (const d of [o.claude, o.codex, o.local]) assert.ok(fs.statSync(d).isDirectory(), `${path.basename(d)} in the CLI home`);
    assert.equal(store.projectInstance(pid, "main").state, "ready");
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"]);
  }, { fdOpts: { brokenImages: [ID] } });
});

test("(6) restart in `code-repos` (restart(), git init at the gate): the old row does not hold busy and stays INTERRUPTED; a kick before atReady does not touch the stopped container; the restore continues", async () => {
  await withCreation(async ({ ctx, gitGates, fd }) => {
    const proj = await create(ctx, { name: "Restart in the repo", sources: [{ kind: "folder", target: "x", bytes: 2 }], codeRepos: ["x"] });
    const pid = proj.id;
    await inSources(pid);
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/begin"), { method: "POST", body: { bytes: 2 } })).status, 200);
    write(path.join(staging(proj, 1), "x", "a.txt"), "ok");
    gitHold(gitGates, "init");
    assert.equal((await request(setupRoute(ctx.base, pid, "sources/1/finished"), { method: "POST" })).status, 202);
    await gitWaiting(gitGates, "init");
    const oldBoot = BOOT_ID;
    assert.deepEqual([store.setupOf(pid).step, store.setupOf(pid).process], ["code-repos", oldBoot]);
    assert.ok(store.setupsInWork(BOOT_ID).some((x) => x.projectId === pid), "before the restart the step holds busy");

    await ctx.restart({ withBackground: true });
    // The earlier process's row does NOT hold busy (else deploy gate and idle reaper would hang on something that never runs again)
    // and is outwards INTERRUPTED — because startServer sets a NEW boot id (app-state.js, no module constant).
    assert.equal(store.setupsInWork(BOOT_ID).some((x) => x.projectId === pid), false, "the old row does not hold busy");
    const a = await active(ctx.base);
    assert.ok(!a.projectWork.some((x) => x.projectId === pid && x.state === "setUp"), JSON.stringify(a.projectWork));
    assert.deepEqual([(await viewIn(ctx, pid)).setup.state, (await viewIn(ctx, pid)).setup.code], ["error", "INTERRUPTED"]);
    assert.notEqual(BOOT_ID, oldBoot);
    assert.equal(store.projectInstance(pid, "main").state, "start", "startServer marks the instance for the restore");

    // The earlier server's procedure lives on in module memory (in-process only): its git ends without writing, and its error
    // setter does not hit the row (it matches on `process` = the NEW boot id).
    fs.writeFileSync(path.join(gitGates, "abort-init"), "");
    gitContinue(gitGates, "init");
    await waitForTruthy(() => !setupProcedureAlive(pid), "the old procedure ends");
    fs.rmSync(path.join(gitGates, "abort-init"));
    const e1 = store.setupOf(pid);
    assert.deepEqual([e1.step, e1.state, e1.process, e1.code], ["code-repos", "setUp", oldBoot, ""], JSON.stringify(e1));
    assert.equal(fs.existsSync(path.join(proj.path, "x", ".git")), false);

    // As after a real server end the project container is stopped. A kick BEFORE atReady (like a post-start hook): no exec against
    // the stopped container, the row stays as it is.
    dx(fd, "stop", containerName(pid));
    const mark = fd.calls().length;
    resumeSetup(pid);
    await waitForTruthy(() => !setupProcedureAlive(pid), "the premature kick ends");
    assert.deepEqual(fd.calls().slice(mark).filter((x) => x.args[0] === "exec").map((x) => x.args), [], "no exec before atReady");
    const e2 = store.setupOf(pid);
    assert.deepEqual([e2.step, e2.state, e2.process, e2.code], ["code-repos", "setUp", oldBoot, ""], JSON.stringify(e2));

    // The restore (the post-start hook) brings the container back; atReady continues.
    await restoreInstance(pid, "main", { reason: "Test: post-start" });
    await new Promise((r) => setImmediate(r)); // the tick in which atReady calls its receivers
    assert.ok(setupProcedureAlive(pid) || !store.setupOf(pid), "the receiver at atReady did not run");
    await finished(pid, "finished after atReady");
    assert.deepEqual(git(path.join(proj.path, "x"), "log", "--format=%s").split("\n"), ["Code repo created (cbase)"]);
    assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"]);
  });
});

// ── (19) Crash between git init and the creation commit, server as a process ─────────────────────────────────────

test("(19) crash between `git init` and the creation commit (server as a process, git at the gate): after the restart exactly ONE commit “Creation” with the marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-setup-kind-"));
  const situation = kindSituation(root);
  const bin = path.join(root, "fake-bin");
  fs.mkdirSync(bin);
  const gates = path.join(root, "git-gates");
  fakeGit(bin, gates);
  const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: situation.programs });
  const environment = {
    CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_PROJECTBOX_TICK_MS: "10",
    CBASE_PROJECTBOX_CREATION_MS: "3600000", CBASE_HOSTS_FILE: HOSTS_TEST, CBASE_PROJECT_STAGE_MS: "3600000",
    CBASE_NETWORK_ROOT: situation.creation.root, HOME: situation.home, PATH: `${bin}:${process.env.PATH}`,
    CBASE_TEST_CREATION_OPTIONS: JSON.stringify(situation.creation),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(environment)) process.env[k] = v;
    await withAgentsServer(async (ctx) => {
      gitHold(gates, "commit");
      const r = await request(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: { name: "Crash", sources: [] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const proj = r.body;
      await gitWaiting(gates, "commit");
      assert.ok(fs.statSync(path.join(proj.path, ".git")).isDirectory(), "git init ran");
      assert.throws(() => execFileSync(REAL_GIT, ["-C", proj.path, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: "ignore" }), "no commit yet");

      await ctx.crash(); // SIGKILL, then a new server process
      // A git that survived the crash ends without writing.
      fs.writeFileSync(path.join(gates, "abort-commit"), "");
      gitContinue(gates, "commit");
      // Without “Try again”: the restore brings the container back, `atReady` continues the setup.
      await waitForTruthy(async () => {
        const p = (await request(`${ctx.base}/api/workspaces/${ctx.ws.id}`)).body.projects?.find((x) => x.id === proj.id);
        if (!p) return false;
        if (p.instance?.state === "error") throw new Error(`instance error: ${JSON.stringify(p.instance)}`);
        const e = p.setup;
        if (e?.state === "error" && e.code !== "INTERRUPTED") throw new Error(`setup error: ${JSON.stringify(e)}`);
        return !e && p.instance?.state === "ready";
      }, "setup finished after the restart");
      assert.deepEqual(git(proj.path, "log", "--format=%s").split("\n"), ["Creation"], "exactly one commit “Creation”");
      assert.equal(carriesProjectRepoMarker(proj.path), true, "the marker is there");
    }, { childProcess: true });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fd.cleanUp();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
