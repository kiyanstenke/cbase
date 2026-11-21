// Clearing a copy away without loss (stacks/clearAway.js clearAwayCopy — the seam to stacks/remove.js) with real repos and the
// copy view of the fake docker (harness server/backend/test/stacks-copy-harness.mjs). Anchors on error sentences ("Backup
// pending", "Clear-away incomplete", …) match the German T() output (uiLang de).
//
// What holds here:
//   (1) Without loss: every commit of the copy under `copy/k1/…`; the open work as a WIP commit — WITH the deletion of a
//       versioned file that exists only on top (`add -u`) and without the hook the agent put into the copy (it rejects); a
//       branch `wip` of the copy occupies the WIP target ⇒ the backup lies on `wip-1`; a worktree of the copy ⇒ `wip-wt1`; a
//       new repo with an open file ⇒ the bundle clones to both; the project repo is merged. Step 4: only what the list names is
//       fetched back, deletions of the copy (whiteouts) stand in the report and are NOT executed in the main. Afterwards nothing
//       of the copy is left, the row `removed` with a report.
//   (2) Abort after step 3 (cap of the tar) ⇒ `error` "Backup pending", the copy still stands; a second call continues
//       at the journal ⇒ same refs as after the first (no second backup), the tar lies in the backup, the copy is gone.
//   (3) Step 0: a chat works in the copy ⇒ `earmarked`, the instance row stays `ready`; afterwards ⇒ `removed`. A waiting row
//       goes straight to `removed` without a copy.
//   (4) The path through the trigger: stacks/remove.js removeCopy sets a ready copy to `clearAway`/`earmarked` and THEN calls
//       the real clearing — the commit of the copy is in the main, the copy is gone, `automatic` comes from the order
//       (`from: cbase`). The trigger guards (stacks-remove.test.js) check the seam only with a stand-in; here it runs for real.
//   (5) If fetching back fails at a path (unreadable folder of the layer, main folder without write permission), the copy stands
//       `error` "Backup pending: Retrieving …" (COPY_RETRIEVE), in the main lies neither a half folder nor a leftover, the
//       layer stays, the journal stands on `clear-layer`; after fixing, the second call fetches both paths and reaches `removed`.
//   (6) A layer name that is not UTF-8 (Linux — on macOS demonstrated through the prelude of the harness) and one with a
//       newline do not block the clearing: the ignored one stands in `ignored.paths` (check-ignore got its BYTES), the open one
//       lies in the backup (`copy/k1/wip`).
//   (7) The worktree folder of the copy (copy-worktrees/<name>) falls with it, B never deletes it recursively itself, and a link
//       in its place is never followed.
//   (8) A worktree of the copy under copy-worktrees/ with a newline in the path ⇒ `error` "Backup pending", its open work
//       still stands; renamed ⇒ `removed`, the work under `copy/k1/wip-<id>`.
//   (9) If the search for repos in node_modules of the copy broke off at its own cap ⇒ `error` "Backup pending"
//       (COPY_CAP, knob CBASE_COPY_DEP_SEARCH_CAP), the copy stands; without the small knob ⇒ `removed`.
//   Through the test seam setClearAwayObserverForTest (before each of the steps 1–4, after its phase):
//   (10) In the phases fetch, save, projectRepo and layer, PUT /files/write, a new terminal and git commit of the copy answer 409
//        (COPY_NOT_READY or LOCKED) — none of it stands in the copy or its backup, and the post-check repeats nothing.
//   (11) What a process INSIDE the copy (past the routes) commits after the fetch, writes open after the backup and creates after
//        the project repo stands in the main after `removed` — the post-check repeated steps 1–4 once.
//   (12) If it keeps writing even after the repetition ⇒ `error` "Backup pending: post-check …" (COPY_POST_CHECK),
//        nothing removed; without the writer the next call fetches the last state and removes.
//   (13) The report names `backup` only if the folder exists afterwards — in (1) and (2) yes (bundle or tar), in (3) and (9) (no
//        new repo, nothing automatic; or abort before any backup) no.
//   (14) A running stack container of the copy (`web` in the inner dockerd, cloned from the main) writes continuously to a
//        versioned path (project repo) and its last state when stopped ⇒ the clearing stops it before step 1 (no writing in
//        steps 1–4), `removed` without repetition, the last state in the main, `halted.container` names it.
//   (14b) If stopping fails (`docker stop` in the copy) ⇒ `error` COPY_POST_CHECK, the sentence names the container under "Nicht
//        angehalten"; when it works again the next call stops it and reaches `removed` with the last state.
//   Step 5 fails (a link as in (7b)): the copy stands `error` with the journal on `clear-remove`, the cause is fixed:
//   (15) No way brings it back up: the chat lock after the period of the new attempt ⇒ `error` with the sentence "This chat's copy
//        “k1” is not removed (…)" (no attempt, no procedure), restoreInstance ⇒ 409 COPY_CLEAR_AWAY, an earmarked
//        recreate falls; the instance row stays equal, the container stays down. The next clearing ⇒ `removed` without a false
//        alarm (`revived` absent), afterwards the chat is free.
//   (15b) The net: an old release had revived it (container started, row `ready`), a commit inside, then the row fell to `error`
//        without a mark ⇒ the clearing recognises from the container start after "clear-layer done" that it ran again, fetches and
//        backs up once more (`revived` "container … started after the backup") — the commit stands in the main.
//   (15c) The start of B: earmarkRestore sets the revived row (`ready`) to `error`/`revived` instead of `start`; a row a crash
//        left in `start` is rejected by the restart (same mark), one in `recreate` the continuation of the recreate; the
//        clearing then fetches once more (`revived` "instance row with the marker …"), the commit stands in the main.
//   (15d) If the container of the copy is missing (`docker rm -f`), the clearing creates it anew itself (clearAway.js
//        copyRunning → copyNewCreate, createInstance in `clearAway`) — `removed`, `copyCreated` in the report, the commit from
//        before in the main, and the instance row never leaves `clearAway` (global stream).
//   (15e) A copy from `error` whose new attempt wasAliveAgain triggered (criterion 3) finds step 0 not empty ⇒ it stands `error`
//        again with its reason (never `earmarked`), the lock of its chat ends after the period with the same sentence, no new
//        attempt, the restore 409; empty ⇒ `removed`, the commit in the main.
//   (15f) wasAliveAgain criterion 2 alone: step 5 failed at `docker stop` (the container ran on, no new start), the instance row
//        stands `ready` afterwards ⇒ the clearing fetches once more, the commit stands in the main.
//
// COUNTER-PROOFS (each shown red by a short sabotage):
//   fetch.js WIP without `add -u` (path list only from the layer)                        ⇒ (1) red (only-top.txt in the backup)
//   clearAway.js removing before fetching                                                ⇒ (1) red (copy/k1/main missing)
//   clearAway.js stepFetch without saveNewRepos (rm -rf before the bundle)               ⇒ (1) red (no bundle, the repo is gone)
//   clearAway.js without the journal continuation, fresh date                            ⇒ (2) red (second backup on wip-1)
//   clearAway.js stepNull without the idle verdict                                       ⇒ (3) red (removed instead of earmarked)
//   remove.js performAction with `automatic: false` instead of from the order            ⇒ (4) red (call without automatic)
//   returnPath.js, clearAway.js, fetch.js, project-repo-copy.js on the old state         ⇒ (5) red (no error — on to the dismantling),
//       (6) red (error COPY_LAYER "unexpected entry" at the name with \n)
//   clearAway.js stepLayer without the throw on `error`                                  ⇒ (5) red (on to the dismantling of the layer)
//   clearAway.js ignoredOf: stdin as a string (`${p}\0` concatenated)                    ⇒ (6) red (the name arrives as U+FFFD, not ignored)
//   objects.js removeCopyWorktrees: `fs.rmSync(root, …)` ⇒ `void 0`                      ⇒ (7) red; without the link and real-path check ⇒ (7b) red
//   objects.js removeCopyWorktrees deleting recursively in B before the main way         ⇒ (7) and (7c) red, plus projectbox-rm-in-b.test.js
//   clearAway.js without withoutWorktreeFinding                                          ⇒ (8) red (`removed` instead of `error` — the open work of the worktree is gone)
//   returnPath.js, fetch.js, clearAway.js on the state before the knob                   ⇒ (9) red (`removed` at the first call — the knob had no effect)
//   clearAway.js without `await check();` in the step `layer`                            ⇒ (11) red (no ref at all, silently `removed`), (12) red
//   devtools `writeLock: writeLockCopy,` removed                                         ⇒ (10) red (the copy accepted writing and commit; the post-check caught it)
//   clearAway.js `backup` again without a condition (success and error)                  ⇒ (3), (9) red (the report names a location that does not exist)
//   clearAway.js with only the native services stopped, and only in the post-check       ⇒ (14) red (`error` COPY_POST_CHECK instead of `removed`), (14b) red
//   clearAway.js without the stopping before step 1 (only in the post-check)             ⇒ (14) red (the stack still ran in steps 1–4)
//   clearAway.js without `${not}` in the sentence of the post-check                      ⇒ (14b) red (the sentence does not name the container)
//   restore.js only extended by the export REVIVED (no guard)                            ⇒ (15), (15b), (15c) red
//   clearAway.js wasAliveAgain removed                                                   ⇒ (15b), (15c) red (the commit is missing in the main)
//   restore.js restoreInstance without the rejection COPY_CLEAR_AWAY                     ⇒ (15), (15c) red
//   idle.js projectLock without the sentence of the copy                                 ⇒ (15) red
//   recreate.js recreateErrorAttempt / attemptsRecreate / resumeRecreate without the check ⇒ (15), (15c) red
//   restore.js earmarkRestore / restoreRestartGrace without the check or the mark        ⇒ (15c) red
//   clearAway.js stepNull with the branch "from error" off                               ⇒ (15e) red
//   clearAway.js wasAliveAgain without criterion 2                                       ⇒ (15f) red (the commit is missing in the main)
//   clearAway.js copyRunning without copyNewCreate (the old throw)                       ⇒ (15d) red (`error` instead of `removed`)
//   clearAway.js copyNewCreate with state "recreate"                                     ⇒ (15d) red (the instance row left clearAway)
//
// No clock: waiting is on states (waitForTruthy without a deadline). macOS: TMPDIR real (the harness sets it).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { MAIN, copyInstance } from "../electron/server/projectbox/creation.js";
import { procedureAlive, setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLock, setInstanceForChat } from "../electron/server/projectbox/idle.js";
import { cleanUpRecreate, recreateErrorAttempt, resumeRecreate, recreateStatus, earmarkRecreate } from "../electron/server/projectbox/recreate.js";
import { restoreInstance, REVIVED, restoreRestartGrace, earmarkRestore } from "../electron/server/projectbox/restore.js";
import { locationFor, worktreeRoot } from "../electron/server/runs/runtime-location.js";
import { codeProjectRoutes } from "../electron/server/devtools/routes.js";
import { clearAwayCopy, setClearAwayObserverForTest } from "../electron/server/stacks/clearAway.js";
import { readSnapshot } from "../electron/server/stacks/build.js";
import { removeCopy, setCopyClearerForTest } from "../electron/server/stacks/remove.js";
import { removeCopyWorktrees } from "../electron/server/stacks/objects.js";
import { copyRequests } from "../electron/server/stacks/state.js";
import { killTerminal } from "../electron/server/terminal.js";
import { runningVerdicts } from "../electron/server/workflows/driver.js";
import {
  buildCopy, treeOf, dx, git, gitCopy, inCopy, situationDefault, withCopy, withEnvironment, nothingLeftOver, refs, writeInCopy,
} from "./stacks-copy-harness.mjs";
import { json, waitForTruthy } from "./agent-harness.mjs";
import { GLOBAL } from "./quiet.mjs";

const paths = (tree) => tree.map((z) => z.split(" ").slice(1).join(" "));

function clonesCheck(bundle, check) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bundle-"));
  try {
    const r = path.join(d, "r");
    execFileSync("git", ["clone", "-q", bundle, r]);
    git(r, "fetch", "-q", bundle, "refs/cbase/*:refs/cbase/*");
    check(r);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) without loss: commits, WIP including the deletion, hook of the copy ineffective, wip-1 next to branch wip, worktree, bundle, project repo, layer, nothing left", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const p = b.s.path;
    const statusPrior = git(app, "status", "--porcelain");

    writeInCopy(b, path.join(app, "only-top.txt"), "only on top\n");
    gitCopy(b, app, "add", "only-top.txt");
    gitCopy(b, app, "commit", "-q", "-m", "m1");
    const m1 = gitCopy(b, app, "rev-parse", "HEAD");
    gitCopy(b, app, "branch", "wip");
    inCopy(b, app, "rm", "only-top.txt", "c.txt", "old.log");
    writeInCopy(b, path.join(app, "a.txt"), "a.txt\nchanged\n");
    writeInCopy(b, path.join(app, "open-new.txt"), "open\n");
    writeInCopy(b, path.join(app, "noise.log"), "ignored\n");
    gitCopy(b, app, "worktree", "add", "-q", "-b", "wt-b", path.join(p, "wt1"));
    writeInCopy(b, path.join(p, "wt1", "wtfile.txt"), "in the worktree\n");
    inCopy(b, app, "mkdir", "-p", ".git/hooks");
    writeInCopy(b, path.join(app, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho rejected >&2\nexit 1\n");
    inCopy(b, app, "chmod", "0755", ".git/hooks/pre-commit");
    inCopy(b, p, "mkdir", "fresh");
    const fresh = path.join(p, "fresh");
    gitCopy(b, fresh, "init", "-q", "-b", "main");
    writeInCopy(b, path.join(fresh, "x.txt"), "x\n");
    gitCopy(b, fresh, "add", "x.txt");
    gitCopy(b, fresh, "commit", "-q", "-m", "x");
    const x = gitCopy(b, fresh, "rev-parse", "HEAD");
    writeInCopy(b, path.join(fresh, "open.txt"), "open\n");
    writeInCopy(b, path.join(p, "note-copy.md"), "from the copy\n");

    const out = await clearAwayCopy(k.id, { reason: "test", retrieve: ["app/noise.log", "../malicious", "app/.git/config", "app/b.txt"], ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    const report = out.report;

    // Commits and backups in the main.
    const r = refs(app);
    assert.equal(r["refs/heads/copy/k1/main"], m1, "the commit of the copy is missing in the main");
    assert.equal(r["refs/heads/copy/k1/wip"], m1, "the branch `wip` of the copy");
    assert.equal(r["refs/heads/copy/k1/wt-b"], m1);
    const wip = r["refs/heads/copy/k1/wip-1"];
    assert.ok(wip, `no backup on wip-1: ${JSON.stringify(r)}`);
    assert.equal(git(app, "rev-parse", `${wip}^`), m1);
    const wipTree = paths(treeOf(app, wip));
    assert.ok(!wipTree.includes("only-top.txt"), "the deletion of a versioned file that exists only on top is missing in the backup (add -u?)");
    assert.ok(!wipTree.includes("c.txt"), "the deletion of c.txt is missing in the backup");
    assert.ok(wipTree.includes("open-new.txt") && !wipTree.includes("noise.log"), wipTree.join(","));
    assert.equal(git(app, "show", `${wip}:a.txt`), "a.txt\nchanged");
    assert.match(git(app, "log", "-1", "--format=%an", wip), /^cbase$/);
    const wt = r["refs/heads/copy/k1/wip-wt1"];
    assert.ok(wt, `no backup of the worktree: ${JSON.stringify(r)}`);
    assert.equal(git(app, "show", `${wt}:wtfile.txt`), "in the worktree");

    // The new repo: bundle with commit and backup of the open file.
    const seq = report.fetch.newRepos.find((n) => n.rel === "fresh");
    assert.ok(seq?.bundle && fs.existsSync(seq.bundle), JSON.stringify(report.fetch.newRepos));
    // (13) the backup folder exists (the bundle lies in it) — the report names it.
    assert.equal(report.backup, b.location.backup);
    assert.ok(seq.bundle.startsWith(`${report.backup}/`), seq.bundle);
    // Nothing wrote after the backup — the post-check repeated nothing.
    assert.equal(report.postCheck, undefined, JSON.stringify(report.postCheck));
    clonesCheck(seq.bundle, (kl) => {
      assert.equal(git(kl, "rev-parse", "HEAD"), x);
      assert.equal(git(kl, "show", "refs/cbase/wip/clone:open.txt"), "open");
    });

    // Project repo merged.
    assert.equal(git(p, "show", "HEAD:note-copy.md"), "from the copy");

    // Step 4: only what is named goes back, deletions are never executed in the main.
    assert.deepEqual(report.layer.back, [{ rel: "app/noise.log", kind: "file" }]);
    assert.equal(fs.readFileSync(path.join(app, "noise.log"), "utf8"), "ignored\n");
    assert.deepEqual(report.layer.denied.map((a) => a.rel).sort(), ["../malicious", "app/.git/config", "app/b.txt"]);
    assert.ok(report.layer.ignored.paths.includes("app/noise.log"), JSON.stringify(report.layer.ignored));
    for (const g of ["app/old.log", "app/c.txt"]) assert.ok(report.layer.deleted.paths.includes(g), `${g} missing under deleted: ${JSON.stringify(report.layer.deleted)}`);
    assert.equal(fs.readFileSync(path.join(app, "c.txt"), "utf8"), "c.txt\n", "a deletion of the copy was executed in the main");
    assert.equal(fs.readFileSync(path.join(app, "old.log"), "utf8"), "alt\n", "a deletion of the copy was executed in the main");
    assert.equal(fs.existsSync(path.join(p, "fresh")), false, "fetched back although not named");

    // The main: HEAD and working tree unchanged (noise.log is ignored).
    assert.equal(git(app, "rev-parse", "HEAD"), b.start.main);
    assert.equal(git(app, "status", "--porcelain"), statusPrior);

    // Nothing left, the row removed with a report.
    nothingLeftOver(b, "(1)");
    const z = store.stackCopy(k.id);
    assert.equal(z.state, "removed");
    assert.equal(z.result?.reason, "test");
    // Idempotent: a second call after `removed` changes nothing.
    assert.equal((await clearAwayCopy(k.id, b.opts)).state, "removed");
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) abort after step 3 (cap of the tar) ⇒ error \"Backup pending\"; the second call continues ⇒ same refs, tar in the backup, nothing left", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    writeInCopy(b, path.join(app, "m1.txt"), "m1\n");
    gitCopy(b, app, "add", "m1.txt");
    gitCopy(b, app, "commit", "-q", "-m", "m1");
    const m1 = gitCopy(b, app, "rev-parse", "HEAD");
    writeInCopy(b, path.join(app, "a.txt"), "a.txt\nopen\n");
    writeInCopy(b, path.join(app, "noise.log"), "ignored\n");

    const one = await withEnvironment({ CBASE_COPY_IGNORED_CAP: "1" }, () => clearAwayCopy(k.id, { reason: "auto", automatic: true, ...b.opts }));
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 800));
    assert.match(one.report.error, /^Sicherung ausstehend: .*COPY_CAP.* — die Schicht bleibt: /);
    const row = store.stackCopy(k.id);
    assert.equal(row.state, "error");
    assert.equal(row.journal.step, "clear-layer", "aborted in step 4");
    assert.ok(fs.existsSync(b.location.root.base), "the layer is gone");
    const r1 = refs(app);
    assert.equal(r1["refs/heads/copy/k1/main"], m1);
    assert.ok(r1["refs/heads/copy/k1/wip"], JSON.stringify(r1));

    const two = await clearAwayCopy(k.id, { reason: "auto", automatic: true, ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 800));
    assert.deepEqual(refs(app), r1, "the second call backed up again");
    const tar = two.report.layer.tar;
    assert.equal(tar?.count, 1, JSON.stringify(two.report.layer));
    assert.ok(fs.existsSync(tar.file));
    assert.deepEqual(execFileSync("tar", ["-tf", tar.file], { encoding: "utf8" }).split("\n").filter(Boolean), ["app/noise.log"]);
    assert.equal(fs.existsSync(path.join(app, "noise.log")), false, "the tar was replayed into the main");
    assert.equal(two.report.backup, b.location.backup, "(13): the tar lies in the backup, the report names it");
    nothingLeftOver(b, "(2)");
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) step 0: a chat works in the copy ⇒ earmarked, instance row stays ready; afterwards removed. A waiting row ⇒ straight removed", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const k = await buildCopy(b);
    const inst = copyInstance("k1");
    const t = Date.now();
    const chat = store.createChat({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: b.s.projectId, createdAt: t, updatedAt: t });
    setInstanceForChat((c) => (c === chat.id ? inst : null));
    runningVerdicts.set(chat.id, 1);
    try {
      const one = await clearAwayCopy(k.id, b.opts);
      assert.equal(one.state, "earmarked", JSON.stringify(one.report).slice(0, 600));
      assert.deepEqual(one.report.open.map((o) => [o.chatId, o.reason]), [[chat.id, "verdict"]]);
      const z = store.stackCopy(k.id);
      assert.deepEqual([z.state, z.phase], ["clearAway", "earmarked"]);
      assert.equal(store.projectInstance(b.s.projectId, inst)?.state, "ready");
      assert.equal(copyInstance("k1"), inst);

      runningVerdicts.delete(chat.id);
      const two = await clearAwayCopy(k.id, b.opts);
      assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 600));
      // (13) no new repo, nothing automatic — there is no backup folder, so the report names none.
      assert.equal(fs.existsSync(b.location.backup), false);
      assert.equal("backup" in two.report, false, `the report names a location that does not exist: ${two.report.backup}`);
      assert.equal("backup" in store.stackCopy(k.id).result, false);
      nothingLeftOver(b, "(3)");
    } finally {
      runningVerdicts.delete(chat.id);
      setInstanceForChat(null);
    }

    // A waiting row has no copy — straight to `removed`.
    const w = copyRequests({ projectId: b.s.projectId, name: "k2", chatId: chat.id });
    const out = await clearAwayCopy(w.id, { reason: "chat deleted" });
    assert.deepEqual([out.state, out.report.dismissed], ["removed", true]);
    assert.equal(store.stackCopy(w.id).state, "removed");
  });
});

// ── (4) ────────────────────────────────────────────────────────────────────────

test("(4) the path through the trigger: removeCopy (earmarked) calls the REAL clearing — commit in the main, copy gone, automatic from the order", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    writeInCopy(b, path.join(app, "trigger.txt"), "from the trigger\n");
    gitCopy(b, app, "add", "trigger.txt");
    gitCopy(b, app, "commit", "-q", "-m", "a1");
    const a1 = gitCopy(b, app, "rev-parse", "HEAD");
    const calls = [];
    // Only the test seams of the harness (home, system) are added — reason, retrieve, automatic come from remove.js.
    setCopyClearerForTest((id, o) => { calls.push({ state: store.stackCopy(id)?.state, phase: store.stackCopy(id)?.phase, ...o }); return clearAwayCopy(id, { ...o, ...b.opts }); });
    let r;
    // The automatic trigger "from cbase": a copy belongs to no chat any more ("chat-deleted" is none) — deleting the project is
    // the same way (automatic, without a wake call).
    try { r = await removeCopy(k.id, { reason: "project-deleted", from: "cbase" }); } finally { setCopyClearerForTest(null); }
    assert.equal(r.state, "removed", String(r.report).slice(0, 1500));
    assert.deepEqual(calls.map((a) => [a.state, a.phase, a.reason, a.automatic]), [["clearAway", "earmarked", "project-deleted", true]]);
    assert.equal(refs(app)["refs/heads/copy/k1/main"], a1, "the commit of the copy is missing in the main");
    nothingLeftOver(b, "(4)");
    assert.equal(store.stackCopy(k.id).state, "removed");
  });
});

// ── (5) fetching back fails ───────────────────────────────────────────────────────────────────────────────────────────

const partOf = (b, rel) => readSnapshot(b.location).repos.find((r) => r.rel === rel).part;
const leftovers = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(".cbase-")) : []);

test("(5) a read or write error while fetching back ⇒ error \"Backup pending\", in the main neither a half folder nor a file, the layer stays; after fixing, the second call fetches everything", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const module = [["a/i.js", "a\n"], ["b/j.js", "b\n"], ["c/k.js", "c\n"]];
    for (const [rel, text] of module) {
      inCopy(b, app, "mkdir", "-p", path.dirname(path.join("node_modules", rel)));
      writeInCopy(b, path.join(app, "node_modules", rel), text);
    }
    inCopy(b, app, "mkdir", "-p", "logs");
    writeInCopy(b, path.join(app, "logs", "x.log"), "log\n");
    // The main: `logs/` arises after the start of the copy and is not writable (write error); on top `node_modules/b` is
    // unreadable (read error in the middle of the folder — the old body left `a/` and an empty `b/` in the main).
    const logs = path.join(app, "logs");
    fs.mkdirSync(logs);
    const unreadable = path.join(b.location.root.layer(partOf(b, "app")), "node_modules", "b");
    assert.ok(fs.statSync(unreadable).isDirectory(), "precondition: node_modules/b lies on top");
    fs.chmodSync(logs, 0o555);
    fs.chmodSync(unreadable, 0o000);
    let one;
    try {
      one = await clearAwayCopy(k.id, { reason: "test", retrieve: ["app/node_modules", "app/logs/x.log"], ...b.opts });
    } finally { fs.chmodSync(unreadable, 0o755); fs.chmodSync(logs, 0o755); }
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Sicherung ausstehend: Rückholen: 2 Pfad\(e\) nicht zurückgeholt .*\(COPY_RETRIEVE\) — die Schicht bleibt: /);
    assert.equal(fs.existsSync(path.join(app, "node_modules")), false, "a half folder lies in the main");
    assert.equal(fs.existsSync(path.join(logs, "x.log")), false, "a file lies in the main although its writing failed");
    assert.deepEqual([...leftovers(app), ...leftovers(logs)], [], "a leftover stayed in the main");
    assert.ok(fs.existsSync(b.location.root.base), "the layer is gone — the only complete version");
    const row = store.stackCopy(k.id);
    assert.deepEqual([row.state, row.journal.step], ["error", "clear-layer"]);

    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    assert.deepEqual(two.report.layer.back.map((z) => z.rel).sort(), ["app/logs/x.log", "app/node_modules"]);
    for (const [rel, text] of module) assert.equal(fs.readFileSync(path.join(app, "node_modules", rel), "utf8"), text);
    assert.equal(fs.readFileSync(path.join(logs, "x.log"), "utf8"), "log\n");
    nothingLeftOver(b, "(5)");
  });
});

// ── (6) names that are not plain text ────────────────────────────────────────────────────────────────────────────────────

test("(6) a layer name that is not UTF-8 and one with a newline do not block the clearing — the ignored one stands in the report (check-ignore with its BYTES), the open one in the backup", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    writeInCopy(b, path.join(app, "line\nbreak.txt"), "open\n");
    // The pattern hits ONLY the byte 0xE9 — if the name reached git as text (U+FFFD) it would not be ignored.
    inCopy(b, app, "/bin/sh", "-c", "printf '*.log\\nnode_modules/\\ncaf\\351.dat\\n' > .gitignore");
    const w = b.location.root.layer(partOf(b, "app"));
    // macOS (APFS) creates no name that is not UTF-8 — Linux does: `list` sees it through the prelude.
    b.clone.prelude([
      "import os as _o, sys as _y",
      "if _y.argv[1:2] == ['list']:",
      `    _W = _o.fsencode(${JSON.stringify(w)}); _N = b"caf\\xe9.dat"`,
      "    _ld = _o.listdir; _ls = _o.lstat",
      "    def _listdir(p=b'.'):",
      "        r = list(_ld(p))",
      "        if p == _W: r.append(_N)",
      "        return r",
      "    def _lstat(p, *a, **kw):",
      "        if p == _o.path.join(_W, _N): return _ls(_o.path.join(_W, b'.gitignore'))",
      "        return _ls(p, *a, **kw)",
      "    _o.listdir = _listdir; _o.lstat = _lstat",
    ].join("\n"));
    let out;
    try { out = await clearAwayCopy(k.id, { reason: "test", ...b.opts }); } finally { b.clone.prelude(null); }
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.ok(out.report.layer.ignored.paths.includes("app/caf\udce9.dat"), JSON.stringify(out.report.layer.ignored));
    const wip = refs(app)["refs/heads/copy/k1/wip"];
    assert.ok(wip, JSON.stringify(refs(app)));
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", wip], { cwd: app, encoding: "utf8" }).split("\0");
    assert.ok(tree.includes("line\nbreak.txt"), `the open file with a newline is missing in the backup: ${JSON.stringify(tree)}`);
    nothingLeftOver(b, "(6)");
  });
});

// ── (7) the worktree folder of the copy falls with it ────────────────────────────────────────────────────────────────────
// `<runtime>/copy-worktrees/<name>/` (subagent and graph worktrees of the copy, runs/runtime-location.js worktreeRoot) is
// cleared only by the clearing of the copy (step 5). A link in its place is never followed: the copy stays `error` "Clear-away
// incomplete", the target of the link is untouched.
const worktreeFolder = (b) => worktreeRoot(locationFor({ projectId: b.s.projectId, converted: true }), copyInstance("k1"));

// B NEVER deletes recursively itself under `copy-worktrees/` — the runtime folder is mounted rw at the same path in the running
// main, and `fs.rmSync(…, { recursive })` is a rimraf over path names (a subfolder swapped for a link in the middle of the
// deletion would make B delete its target inside B). The trace: every recursive `fs.rmSync` of the process under `under` —
// objects.js calls `fs.rmSync` on the default object of node:fs, i.e. on THIS one. The fake runs a `docker exec` as its own
// process, where nothing counts.
async function recursiveInB(under, fn) {
  const real = fs.rmSync;
  const lane = [];
  fs.rmSync = function (p, o) {
    const rel = path.relative(under, String(p));
    if (o?.recursive && !rel.startsWith("..") && !path.isAbsolute(rel)) lane.push(String(p));
    return real.apply(this, arguments);
  };
  try { await fn(); } finally { fs.rmSync = real; }
  return lane;
}
const execRm = (b, target) => b.fd.calls({ daemon: "host" }).map((a) => a.args).filter((a) => a[0] === "exec" && a.slice(-1)[0] === target && a.includes("rm"));

test("(7) after `removed` copy-worktrees/<name> is gone with its contents; the folder of another copy stays — deleted in the main container as root, never recursively in B", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const wt = worktreeFolder(b);
    const foreign = path.join(path.dirname(wt), "k2");
    fs.mkdirSync(path.join(wt, "agent-x", "src"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(wt, "agent-x", "src", "file.txt"), "in the worktree\n");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "stays.txt"), "k2\n");
    let out;
    const inB = await recursiveInB(path.dirname(wt), async () => { out = await clearAwayCopy(k.id, { reason: "test", ...b.opts }); });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.equal(fs.existsSync(wt), false, "the worktree folder of the copy stayed");
    assert.deepEqual(inB, [], "B deleted recursively under copy-worktrees/ itself — the main container mounts the folder rw");
    const rm = execRm(b, wt);
    assert.equal(rm.length, 1, `no rm in the main container: ${JSON.stringify(b.fd.calls({ daemon: "host" }).map((a) => a.args.slice(0, 5)))}`);
    assert.deepEqual(rm[0].slice(0, 4), ["exec", "-u", "root", b.cid], "the rm did not run as root in the main container");
    assert.equal(fs.readFileSync(path.join(foreign, "stays.txt"), "utf8"), "k2\n", "the folder of another copy was touched");
    nothingLeftOver(b, "(7)");
    fs.rmSync(foreign, { recursive: true, force: true });
  });
});

test("(7c) if the main stands, the root helper deletes (bind of the runtime folder, `rm -rf --`) — never B; without any way the folder stays", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const runLocation = locationFor({ projectId: b.s.projectId, converted: true });
    const wt = worktreeFolder(b);
    fs.mkdirSync(path.join(wt, "agent-x", "src"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(wt, "agent-x", "src", "file.txt"), "in the worktree\n");
    dx(b.fd, "stop", b.main); // idle: the main stands, an exec there fails
    let r;
    const inB = await recursiveInB(path.dirname(wt), async () => {
      r = await removeCopyWorktrees({ runLocation, root: wt, projectId: b.s.projectId, instance: copyInstance("k1") });
    });
    assert.deepEqual(r, { removed: true, overHelper: true });
    assert.equal(fs.existsSync(wt), false);
    assert.deepEqual(inB, [], "B deleted recursively itself instead of using the helper");
    const host = b.fd.calls({ daemon: "host" }).map((a) => a.args);
    const run = host.find((a) => a[0] === "run" && a.includes("cbase.helper=clearAway"));
    assert.ok(run, "no helper started");
    assert.ok(run.includes(`type=bind,src=${runLocation.root},dst=${runLocation.root}`), `the helper does not mount the runtime folder (the mount point in the main): ${run.join(" ")}`);
    assert.ok(host.some((a) => a[0] === "exec" && a.slice(-4).join(" ") === `rm -rf -- ${wt}`), "no `rm -rf --` in the helper");

    // Without an operating mark (no container, no helper): nothing deleted, not in B either.
    fs.mkdirSync(path.join(wt, "agent-y"), { recursive: true });
    const without = await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, () => recursiveInB(path.dirname(wt), async () => {
      await assert.rejects(removeCopyWorktrees({ runLocation, root: wt, projectId: b.s.projectId, instance: copyInstance("k1") }));
    }));
    assert.deepEqual(without, []);
    assert.ok(fs.existsSync(path.join(wt, "agent-y")), "deleted anyway without a way");
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

test("(7b) if copy-worktrees/<name> is a link it is not followed — error \"Clear-away incomplete\", the target stays intact", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const wt = worktreeFolder(b);
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wt-target-"));
    try {
      fs.writeFileSync(path.join(target, "important.txt"), "foreign\n");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      fs.symlinkSync(target, wt);
      const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
      assert.equal(out.state, "error", JSON.stringify(out.report).slice(0, 1500));
      assert.match(out.report.error, /^Abräumen unvollständig: Worktrees der Kopie: .*COPY_LOCATION_REFERENCE/);
      assert.equal(fs.readFileSync(path.join(target, "important.txt"), "utf8"), "foreign\n", "the target of the link was touched");
      assert.ok(fs.lstatSync(wt).isSymbolicLink(), "the link was removed without the error naming it");
    } finally { fs.rmSync(wt, { force: true }); fs.rmSync(target, { recursive: true, force: true }); }
  });
});

// ── (8) a worktree of the copy outside the project folder ────────────────────────────────────────────────────────────────
// A worktree of the copy OUTSIDE the project folder (copy-worktrees/<name>/ — subagents and graph runs put theirs there) is not
// in the overlay: only step 2 backs up its open work, and step 5 deletes the folder. If its path carries a newline it stands in
// the state only as a finding — formerly the clearing then went to `removed` and the work was gone.

test("(8) a worktree of the copy with a newline in the path ⇒ error \"Backup pending\", its open work still stands; renamed ⇒ removed, the work under copy/k1/wip-<id>", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const folder = worktreeFolder(b);
    fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
    const wt = path.join(folder, "wt\ntwo");
    gitCopy(b, app, "worktree", "add", "-q", "-b", "wt-n", wt);
    fs.writeFileSync(path.join(wt, "only-in-worktree.txt"), "open\n");

    const one = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Sicherung ausstehend: fetch: 1 Worktree\(s\) der Kopie .*Zeilenumbruch.*\(COPY_BACKUP\) — die Schicht bleibt: /);
    assert.equal(store.stackCopy(k.id).state, "error");
    assert.equal(fs.readFileSync(path.join(wt, "only-in-worktree.txt"), "utf8"), "open\n", "the open work of the worktree is gone");

    // Renamed ⇒ the second clearing continues and backs it up.
    gitCopy(b, app, "worktree", "move", wt, path.join(folder, "wt-two"));
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    const r = refs(app);
    const wip = Object.keys(r).filter((n) => /^refs\/heads\/copy\/k1\/wip-/.test(n));
    assert.equal(wip.length, 1, JSON.stringify(r));
    assert.ok(paths(treeOf(app, r[wip[0]])).includes("only-in-worktree.txt"), JSON.stringify(treeOf(app, r[wip[0]])));
    assert.equal(fs.existsSync(folder), false);
    nothingLeftOver(b, "(8)");
  });
});

// ── (9) the search for repos in the dependencies ─────────────────────────────────────────────────────────────────────────

test("(9) if the search for repos in node_modules of the copy broke off at the cap ⇒ error \"Backup pending\" (COPY_CAP), the copy stands; without the knob ⇒ removed", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    inCopy(b, b.app, "/bin/sh", "-c", 'mkdir -p node_modules/package && cd node_modules/package && i=0; while [ $i -lt 40 ]; do : > "d$i.js"; i=$((i+1)); done');
    const one = await withEnvironment({ CBASE_COPY_DEP_SEARCH_CAP: "5" }, () => clearAwayCopy(k.id, { reason: "test", ...b.opts }));
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Sicherung ausstehend: fetch: die Suche nach Repos in app\/node_modules brach ab \(mehr als 5 Einträge .*CBASE_COPY_DEP_SEARCH_CAP.*\(COPY_CAP\) — die Schicht bleibt: /);
    assert.equal(store.stackCopy(k.id).state, "error");
    // (13) aborted before any backup — the error report too names no folder that does not exist.
    assert.equal(fs.existsSync(b.location.backup), false);
    assert.equal("backup" in one.report, false, `the error report names ${one.report.backup}`);
    assert.equal(one.report.layer, b.location.root.base);
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    nothingLeftOver(b, "(9)");
  });
});

// ── (10)–(12) the copy accepts nothing while it is cleared ───────────────────────────────────────────────────────────────

function stubResponse() {
  const r = { status: 0, parts: [], writeHead(c) { r.status = c; }, write(d) { r.parts.push(Buffer.from(d)); return true; }, end(d) { if (d) r.parts.push(Buffer.from(d)); } };
  Object.defineProperty(r, "json", { get: () => { try { return JSON.parse(Buffer.concat(r.parts).toString("utf8")); } catch { return null; } } });
  return r;
}
async function route(pid, { method, sub, query = "", body = {} }) {
  const req = new PassThrough();
  req.method = method;
  req.headers = { "content-type": "application/json" };
  req.end(JSON.stringify(body));
  const res = stubResponse();
  const url = new URL(`http://x/api/projects/${pid}${sub}${query}`);
  await codeProjectRoutes({ req, res, url, p: url.pathname, m: method, pid, sub, proj: store.getProject(pid) });
  return res;
}
// The content of a file in every backup of the open work of the clone (`copy/k1/wip`, `wip-1`, …) that carries it.
const inWip = (app, file) => Object.entries(refs(app)).filter(([n]) => /^refs\/heads\/copy\/k1\/wip(-\d+)?$/.test(n))
  .filter(([, o]) => paths(treeOf(app, o)).includes(file)).map(([, o]) => git(app, "show", `${o}:${file}`));

test("(10) in the phases fetch, save, projectRepo and layer, writing, a new terminal and git commit of the copy answer 409 — none of it stands in the copy or its backup", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const pid = b.s.projectId;
    const query = `?instance=${encodeURIComponent(`${pid}/${copyInstance("k1")}`)}`;
    const responses = [];
    const terminals = [];
    setClearAwayObserverForTest(async ({ step }) => {
      const phase = store.stackCopy(k.id).phase;
      const inst = store.projectInstance(pid, copyInstance("k1"))?.state;
      for (const [method, sub, body] of [["PUT", "/files/write", { path: "app/late.txt", content: `${step}\n` }], ["POST", "/terminal", { cols: 80, rows: 24 }], ["POST", "/git/commit", { repo: "app", message: "late", amend: false }]]) {
        const r = await route(pid, { method, sub, query, body });
        if (r.json?.id) terminals.push(r.json.id);
        responses.push({ phase, inst, way: `${method} ${sub}`, status: r.status, code: r.json?.code, reason: r.json?.reason });
      }
    });
    let out;
    try { out = await withEnvironment({ SHELL: "/bin/sh" }, () => clearAwayCopy(k.id, { reason: "test", ...b.opts })); }
    finally { setClearAwayObserverForTest(null); for (const id of terminals) killTerminal(id); }
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.deepEqual([...new Set(responses.map((a) => a.phase))], ["fetch", "save", "projectRepo", "layer"]);
    for (const a of responses) {
      assert.equal(a.inst, "clearAway", JSON.stringify(a));
      assert.equal(a.status, 409, `${a.way} in phase ${a.phase}: ${a.status} ${a.code || ""} — the copy accepted during the clearing`);
      assert.deepEqual([a.code, a.reason], a.way === "POST /terminal" ? ["LOCKED", "clearAway"] : ["COPY_NOT_READY", undefined], JSON.stringify(a));
    }
    assert.equal(responses.length, 12, "steps 1–4 ran more than once — something arrived after the backup");
    assert.equal(out.report.postCheck, undefined, JSON.stringify(out.report.postCheck));
    for (const [n, o] of Object.entries(refs(b.app))) assert.ok(!paths(treeOf(b.app, o)).includes("late.txt"), `${n} carries a file that was written during the clearing`);
    nothingLeftOver(b, "(10)");
  });
});

test("(11) what a process INSIDE the copy commits after the fetch, writes open after the backup and creates after the project repo stands in the main after `removed` — the post-check repeated steps 1–4 once", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const p = b.s.path;
    let c2 = null;
    // Past the routes (like a stack container, a VS Code window or cbase-project): docker exec into the copy, only in the first pass.
    setClearAwayObserverForTest(async ({ step, repeated }) => {
      if (repeated) return;
      if (step === "clear-save") {
        writeInCopy(b, path.join(app, "after-fetch.txt"), "c2\n");
        gitCopy(b, app, "add", "after-fetch.txt");
        gitCopy(b, app, "commit", "-q", "-m", "after the fetch");
        c2 = gitCopy(b, app, "rev-parse", "HEAD");
      }
      if (step === "clear-projectRepo") writeInCopy(b, path.join(app, "after-save.txt"), "open after the backup\n");
      if (step === "clear-layer") writeInCopy(b, path.join(p, "after-project-repo.md"), "after the project repo\n");
    });
    let out;
    try { out = await clearAwayCopy(k.id, { reason: "test", ...b.opts }); } finally { setClearAwayObserverForTest(null); }
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    const r = refs(app);
    assert.ok(c2 && Object.values(r).includes(c2), `the commit after the fetch is missing in the main: ${JSON.stringify(r)}`);
    assert.deepEqual(inWip(app, "after-save.txt"), ["open after the backup"], `the open work after the backup is missing in the backup: ${JSON.stringify(r)}`);
    assert.equal(git(p, "show", "HEAD:after-project-repo.md"), "after the project repo", "the file after the project repo is missing in the main");
    const nk = out.report.postCheck;
    assert.ok(Array.isArray(nk?.repeated), JSON.stringify(nk));
    for (const pattern of [/^app: 1 Ref\(s\) neu oder bewegt \(refs\/heads\/main\)$/, /^app: offene Arbeit geändert$/, /^Projekt-Repo: offene Arbeit nach dem Commit$/]) {
      assert.ok(nk.repeated.some((x) => pattern.test(x)), `${pattern} missing: ${JSON.stringify(nk.repeated)}`);
    }
    nothingLeftOver(b, "(11)");
  });
});

test("(12) if something in the copy keeps writing even after the repetition ⇒ error \"Backup pending\" (COPY_POST_CHECK), nothing removed; without the writer the next call fetches the last state", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    let n = 0;
    setClearAwayObserverForTest(async () => { n += 1; writeInCopy(b, path.join(app, "duration.txt"), `state ${n}\n`); });
    let one;
    try { one = await clearAwayCopy(k.id, { reason: "test", ...b.opts }); } finally { setClearAwayObserverForTest(null); }
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Sicherung ausstehend: Nachkontrolle: in der Kopie wird nach dem Sichern weiter \w+ \(app: offene Arbeit geändert\) — nichts entfernt\. .*\(COPY_POST_CHECK\) — die Schicht bleibt: /);
    assert.equal(n, 8, "steps 1–4 did not run exactly twice");
    const z = store.stackCopy(k.id);
    assert.deepEqual([z.state, z.journal.step], ["error", "clear-layer"]);
    assert.ok(fs.existsSync(b.location.root.base), "the layer is gone");
    assert.notEqual(store.projectInstance(b.s.projectId, copyInstance("k1")), null, "the instance row is gone");
    assert.equal(inCopy(b, app, "cat", "duration.txt"), "state 8", "the copy no longer stands");
    assert.ok(one.report.postCheck?.repeated?.length, JSON.stringify(one.report.postCheck));

    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    assert.ok(inWip(app, "duration.txt").includes("state 8"), `the last state is missing in the backup: ${JSON.stringify(inWip(app, "duration.txt"))}`);
    nothingLeftOver(b, "(12)");
  });
});

// ── (14) the stack of the copy writes ────────────────────────────────────────────────────────────────────────────────────
// The container `web` of the main (restart always) runs in the inner dockerd of the copy after the clone. It plays a stack
// container that writes to a versioned path (a bind in the project folder): while it RUNS it writes before each of the steps
// 1–4 (test seam setClearAwayObserverForTest, no clock), and when stopped it writes its last state (flush) — a docker wrapper
// writes the file before every `docker stop` IN the copy (`exec … <copy> docker stop …`), then the call passes on to the fake
// docker.
const stackFile = "stack-data.txt";
function stackWebOf(b) {
  const c = Object.values(b.fd.state(b.copy).container).find((x) => x.name === "web");
  return { short: String(c?.id || "").slice(0, 12), running: c?.status === "running" };
}
async function withFlushWrapper(b, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-flush-"));
  const bin = path.join(dir, "docker");
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = exec ] && [ "$5" = docker ] && [ "$6" = stop ]; then
  ${q(b.fd.bin)} exec -w ${q(b.s.path)} "$4" /bin/sh -c 'printf "%s" "on stop" > ${stackFile}' >/dev/null 2>&1 || exit 97
fi
exec ${q(b.fd.bin)} "$@"
`, { mode: 0o755 });
  try { return await withEnvironment({ CBASE_DOCKER_BIN: bin }, fn); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("(14) a running stack container of the copy writes continuously to a versioned path ⇒ the clearing stops it before step 1, its last state (flush) stands in the project repo of the main, `removed` without repetition", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const web = stackWebOf(b);
    assert.ok(web.running, "the stack of the copy is not running — the situation does not carry the finding");
    writeInCopy(b, path.join(b.s.path, stackFile), "state 0");
    let n = 0;
    setClearAwayObserverForTest(async () => { if (stackWebOf(b).running) { n += 1; writeInCopy(b, path.join(b.s.path, stackFile), `state ${n}`); } });
    let out;
    try { out = await withFlushWrapper(b, () => clearAwayCopy(k.id, { reason: "test", ...b.opts })); } finally { setClearAwayObserverForTest(null); }
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.equal(n, 0, `the stack still ran in steps 1–4 (${n} writes) — stopped only afterwards`);
    assert.deepEqual(out.report.halted?.container, [web.short], JSON.stringify(out.report.halted));
    assert.equal(out.report.halted?.open, undefined, JSON.stringify(out.report.halted));
    assert.equal(out.report.postCheck, undefined, `the post-check repeated: ${JSON.stringify(out.report.postCheck)}`);
    assert.equal(git(b.s.path, "show", `HEAD:${stackFile}`), "on stop", "the last state of the stack is missing in the project repo of the main");
    nothingLeftOver(b, "(14)");
  });
});

test("(14b) if the stack cannot be stopped (docker stop fails) the clearing ends in `error` COPY_POST_CHECK and the sentence names the container; when it works again the next call fetches the last state and removes", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const web = stackWebOf(b);
    assert.ok(web.running, "the stack of the copy is not running — the situation does not carry the finding");
    let n = 0;
    setClearAwayObserverForTest(async () => { if (stackWebOf(b).running) { n += 1; writeInCopy(b, path.join(b.s.path, stackFile), `state ${n}`); } });
    let one;
    try {
      b.fd.errorAt([{ daemon: b.copy, pattern: "^stop " }]);
      one = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    } finally { b.fd.errorAt([]); setClearAwayObserverForTest(null); }
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Sicherung ausstehend: Nachkontrolle: in der Kopie wird nach dem Sichern weiter \w+ \(Projekt-Repo: offene Arbeit nach dem Commit\) — nichts entfernt\. Dienste und Stack-Container der Kopie hält das Abräumen selbst an\. Nicht angehalten: Container [0-9a-f]{12}: .*injected error.* \(COPY_POST_CHECK\) — die Schicht bleibt: /);
    assert.ok(one.report.error.includes(`Container ${web.short}:`), one.report.error);
    assert.equal(n, 8, "steps 1–4 did not run exactly twice");
    assert.ok(stackWebOf(b).running, "the stack stands — the injected error did not take");
    assert.equal(one.report.halted?.container, undefined, JSON.stringify(one.report.halted));

    const two = await withFlushWrapper(b, () => clearAwayCopy(k.id, { reason: "test", ...b.opts }));
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    assert.deepEqual(two.report.halted?.container, [web.short], JSON.stringify(two.report.halted));
    assert.equal(git(b.s.path, "show", `HEAD:${stackFile}`), "on stop", "the last state of the stack is missing in the project repo of the main");
    nothingLeftOver(b, "(14b)");
  });
});

// ── (15) a copy in clearing away does not come back up ───────────────────────────────────────────────────────────────────
// If the clearing fails in step 5 (here as in (7b): a link in the place of copy-worktrees/k1 — the dismantling does not run to
// the end, the instance row stays `error`, the journal stands on `clear-remove`), the next clearing continues there: WITHOUT fetch,
// backup and idle. Formerly the new attempt from `error` (at the lock of every turn after the period), the restart, git wake
// timer, restart and an earmarked recreate brought the copy back up — what arose in it afterwards was taken along by step 5
// unfetched, and the wake call reported success (projectbox/restore.js header, stacks/clearAway.js wasAliveAgain).
const copyContainer = (b) => Object.values(b.fd.state().container).find((c) => c.name === b.copy) || null;

async function step5Fails(b, k) {
  const wt = worktreeFolder(b);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-wt-target-"));
  try {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    fs.symlinkSync(target, wt);
    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "error", JSON.stringify(out.report).slice(0, 1500));
    assert.match(out.report.error, /^Abräumen unvollständig: /);
  } finally { fs.rmSync(wt, { force: true }); fs.rmSync(target, { recursive: true, force: true }); } // the cause is fixed
  const z = store.stackCopy(k.id);
  assert.deepEqual([z.state, z.journal.step], ["error", "clear-remove"], "precondition: failed in step 5");
  assert.equal(store.projectInstance(b.s.projectId, copyInstance("k1"))?.state, "error", "precondition: the instance row of the copy stands error");
  assert.notEqual(copyContainer(b)?.status, "running", "precondition: step 5 stopped the copy");
  return z;
}

// What a release before the fix did (the new attempt from `error`, the restart — projectbox/restore.js restoreInstance): start the
// container of the copy, the instance row `ready`. Afterwards something works in it and commits.
function reviveAsBeforeC1(b) {
  dx(b.fd, "start", b.copy);
  setInstanceState(b.s.projectId, copyInstance("k1"), "ready", { phase: "" });
}
function commitInCopy(b, file) {
  writeInCopy(b, path.join(b.app, file), "after the revival\n");
  gitCopy(b, b.app, "add", file);
  gitCopy(b, b.app, "commit", "-q", "-m", `after the revival: ${file}`);
  return gitCopy(b, b.app, "rev-parse", "HEAD");
}
function commitInMain(b, c, file) {
  const r = refs(b.app);
  assert.ok(Object.values(r).includes(c), `the commit after the revival is missing in the main (lost): ${JSON.stringify(r)}`);
  assert.equal(git(b.app, "show", `${c}:${file}`), "after the revival");
}

test("(15) if the clearing failed in step 5, no way brings the copy back up — the chat lock ends after the period of the new attempt with the sentence, the restore rejects, a recreate falls; fixed ⇒ the next clearing removes it without a false alarm, the chat is free", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    const k = await buildCopy(b, { chatId: ctx.chat.id });
    await step5Fails(b, k);
    // Longer than the period of the new attempt from `error` (two hours — the opposite direction, no clock criterion): the lock
    // would trigger it (projectbox/recreate.js recreateErrorAttempt).
    const old = Date.now() - 2 * 3_600_000;
    store.changeProjectInstance(pid, inst, { state: "start", now: old });
    store.changeProjectInstance(pid, inst, { state: "error", now: old });
    const prior = JSON.stringify(store.projectInstance(pid, inst));
    try {
      await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root }, async () => {
        // (a) The lock of every turn of the chat: no new attempt — the chat holds on to its copy, the sentence says how to go on.
        const s = projectLock(ctx.chat.id, "turn");
        assert.equal(s?.kind, "error", `the lock revives the copy: ${JSON.stringify(s)}`);
        assert.match(s.text, /^Die Kopie „k1“ dieses Chats ist nicht abgeräumt \(Abräumen unvollständig: .*\) — nichts gestartet, auch nicht im Haupt\. Das Abräumen erneut anstoßen /, s.text);
        assert.equal(recreateErrorAttempt(pid, store.projectInstance(pid, inst)), false, "a new attempt from error");
        assert.equal(procedureAlive(pid, inst), false, "a procedure brings the copy up");
        // (b) Every way through the restore (restart, git wake timer, restart, new attempt): rejected, the row stays.
        await assert.rejects(restoreInstance(pid, inst, { reason: "Test" }),
          (e) => e.code === "COPY_CLEAR_AWAY" && e.status === 409 && /does not come back up: its removal failed: Abräumen unvollständig: /.test(e.message));
        // (c) An earmarked recreate does not create its container anew — the earmark falls.
        assert.equal(earmarkRecreate(pid, { instance: inst, reason: "Test" }), true);
        const st = await waitForTruthy(() => recreateStatus(pid, inst).last, "the attempt of the recreate");
        assert.equal(st.reason, "copy in clearing away (error) — no recreation", JSON.stringify(st));
        assert.equal(recreateStatus(pid, inst).earmarked, null, "the earmark stayed");
      });
    } finally { cleanUpRecreate(); }
    assert.equal(JSON.stringify(store.projectInstance(pid, inst)), prior, "the instance row of the copy was touched");
    assert.notEqual(copyContainer(b)?.status, "running", "the container of the copy runs again");

    // Fixed (the link is gone): the next clearing continues in step 5 — the copy did not run since the backup, no false alarm.
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    assert.equal(two.report.revived, undefined, `false alarm: ${two.report.revived}`);
    nothingLeftOver(b, "(15)");
    assert.equal(await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root }, () => projectLock(ctx.chat.id, "turn")), null, "the chat is not free after the clearing");
  });
});

test("(15b) net: if the copy ran again after the backup — a release before the fix revived it, then its row fell to error without a mark — the clearing fetches and backs up once more before step 5: the commit afterwards stands in the main", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    await step5Fails(b, k);
    reviveAsBeforeC1(b);
    const c = commitInCopy(b, "after-revival.txt");
    // … and fell back to `error` (a failure afterwards) — only the start time of its container remains.
    setInstanceState(b.s.projectId, copyInstance("k1"), "error", { error: "failed again afterwards" });
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    commitInMain(b, c, "after-revival.txt");
    assert.match(String(two.report.revived || ""), /^Container [0-9a-f]{12} nach der Sicherung gestartet$/, JSON.stringify(two.report.revived));
    nothingLeftOver(b, "(15b)");
  });
});

test("(15c) the start of B does not revive a copy in clearing away — a row a release before the fix had revived becomes error with the mark REVIVED, likewise one a crash left in start or recreate; the clearing then fetches once more", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    const k = await buildCopy(b);
    await step5Fails(b, k);
    reviveAsBeforeC1(b);
    const c = commitInCopy(b, "before-the-restart.txt");
    const marker = () => { const z = store.projectInstance(pid, inst); return [z?.state, z?.phase]; };
    const main = store.projectInstance(pid, MAIN);
    assert.equal(main.state, "ready");
    try {
      await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root }, async () => {
        // (a) Earmarking at the start (earmarkRestore): `ready` ⇒ error/revived; the main ⇒ start as at every start.
        earmarkRestore();
        assert.deepEqual(marker(), ["error", REVIVED], "the start of B sets the revived copy to start");
        assert.match(store.projectInstance(pid, inst).error, /^copy brought up again after its removal had begun — its removal failed: Abräumen unvollständig: /);
        assert.equal(store.projectInstance(pid, MAIN).state, "start");
        // The main is not the subject here (its restart checks the labels of the harness container and created it anew): back as it
        // was — the restart takes only the copy.
        store.changeProjectInstance(pid, MAIN, { state: main.state, phase: main.phase });
        // (b) A crash in the middle of a restore left it in `start`: the restart rejects and sets the mark.
        store.changeProjectInstance(pid, inst, { state: "start", phase: "waiting" });
        await restoreRestartGrace();
        assert.deepEqual(marker(), ["error", REVIVED], "the restart brings the copy up again");
        // (c) … or in the middle of a recreate: the continuation does not go on.
        store.changeProjectInstance(pid, inst, { state: "recreate", phase: "remove" });
        assert.equal(await resumeRecreate({ projectId: pid, instance: inst, reason: "Test" }), null);
        assert.deepEqual(marker(), ["error", REVIVED], "the continuation of the recreate brings the copy up again");
      });
    } finally {
      cleanUpRecreate();
      // Red instead of a hang: if a part above breaks off, a row can stand in `start`/`recreate` without a procedure — the quiet of
      // the harness would wait for it endlessly. Back as they stood before the test.
      for (const [i, fields] of [[MAIN, { state: main.state, phase: main.phase }], [inst, { state: "error" }]]) {
        const z = store.projectInstance(pid, i);
        if (z && ["start", "recreate"].includes(z.state) && !procedureAlive(pid, i)) store.changeProjectInstance(pid, i, fields);
      }
    }
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    commitInMain(b, c, "before-the-restart.txt");
    assert.equal(two.report.revived, `Instanz-Zeile mit der Marke ${REVIVED}`);
    nothingLeftOver(b, "(15c)");
  });
});

// ── (15d)–(15f) ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The global stream: every event until `shutdown()`.
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort when closing */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

test("(15d) if the container of a copy in clearing away is missing, the clearing creates it anew itself without reviving the copy — `removed`, the commit stands in the main, the instance row never leaves `clearAway`", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    const k = await buildCopy(b);
    const c = commitInCopy(b, "before-the-loss.txt");
    const old = String(store.projectInstance(pid, inst).containerId).slice(0, 12);
    // The container of the copy is gone (an inner dockerd that after a recreate of B no longer sees its containers; a manual
    // `docker rm`) — its layer, network and volume still stand.
    dx(b.fd, "rm", "-f", b.copy);
    assert.equal(copyContainer(b), null, "precondition: the container of the copy is gone");
    const reader = await globalReaderFor(ctx.base);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init") || null, "init of the global stream");
      const out = await clearAwayCopy(k.id, { reason: "test", ...b.s.opts });
      assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
      assert.match(String(out.report.copyCreated || ""), /^[0-9a-f]{12}$/, `the report does not name the creation: ${JSON.stringify(out.report.copyCreated)}`);
      assert.notEqual(out.report.copyCreated, old, "did the old container still run?");
      commitInMain(b, c, "before-the-loss.txt");
      const until = await ctx.barrier(reader, GLOBAL);
      const rows = reader.events.slice(0, until).filter((e) => e.type === "project/instance" && e.projectId === pid && e.instance === inst);
      assert.ok(rows.length > 0, "no message of the instance row seen");
      assert.deepEqual([...new Set(rows.map((e) => e.state))], ["clearAway"], `the instance row left clearAway: ${JSON.stringify(rows.map((e) => [e.state, e.phase]))}`);
      nothingLeftOver(b, "(15d)");
    } finally { await reader.shutdown(); }
  });
});

test("(15e) if step 0 of a new attempt finds a copy from `error` not empty (wasAliveAgain triggered it, the journal stands on ab-remove), it stays `error`, never `earmarked` — the lock of its chat ends with the same set, no new attempt, the restore rejects; empty ⇒ `removed`, the commit in the main", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
    const k = await buildCopy(b, { chatId: ctx.chat.id });
    const failed = await step5Fails(b, k);
    // Its container started again after the backup (wasAliveAgain, criterion 3 — without a mark, the instance row stands `error`),
    // and a commit arose in it.
    dx(b.fd, "start", b.copy);
    const c = commitInCopy(b, "after-the-start.txt");
    runningVerdicts.set(ctx.chat.id, 1); // something works in the copy: step 0 is not quiet
    try {
      const one = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
      assert.equal(one.state, "earmarked", JSON.stringify(one.report).slice(0, 1500));
      assert.deepEqual(one.report.open.map((o) => [o.chatId, o.reason]), [[ctx.chat.id, "verdict"]]);
      const z = store.stackCopy(k.id);
      assert.deepEqual([z.state, z.phase, z.error], ["error", "", failed.error], "the copy from error does not stand error again after step 0 (earmarked?)");
      assert.equal(store.projectInstance(pid, inst)?.state, "error", "the instance row does not stand error again");
      // Longer than the period of the new attempt from `error` (as in (15), the opposite direction): the lock would trigger it.
      const long = Date.now() - 2 * 3_600_000;
      store.changeProjectInstance(pid, inst, { state: "start", now: long });
      store.changeProjectInstance(pid, inst, { state: "error", now: long });
      const prior = JSON.stringify(store.projectInstance(pid, inst));
      await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root }, async () => {
        const s = projectLock(ctx.chat.id, "turn");
        assert.equal(s?.kind, "error", `the lock revives the copy: ${JSON.stringify(s)}`);
        assert.match(s.text, /^Die Kopie „k1“ dieses Chats ist nicht abgeräumt \(Abräumen unvollständig: .*\) — nichts gestartet, auch nicht im Haupt\. Das Abräumen erneut anstoßen /, s.text);
        assert.equal(recreateErrorAttempt(pid, store.projectInstance(pid, inst)), false, "a new attempt from error");
        assert.equal(procedureAlive(pid, inst), false, "a procedure brings the copy up");
        await assert.rejects(restoreInstance(pid, inst, { reason: "Test" }), (e) => e.code === "COPY_CLEAR_AWAY" && e.status === 409);
      });
      assert.equal(JSON.stringify(store.projectInstance(pid, inst)), prior, "the instance row of the copy was touched");
    } finally {
      runningVerdicts.delete(ctx.chat.id);
      cleanUpRecreate();
      // Red instead of a hang (like (15c)): a row in `start`/`recreate` without a procedure would hold the quiet of the harness.
      const z = store.projectInstance(pid, inst);
      if (z && ["start", "recreate"].includes(z.state) && !procedureAlive(pid, inst)) store.changeProjectInstance(pid, inst, { state: "error" });
    }
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    commitInMain(b, c, "after-the-start.txt");
    assert.match(String(two.report.revived || ""), /^Container [0-9a-f]{12} nach der Sicherung gestartet$/, JSON.stringify(two.report.revived));
    nothingLeftOver(b, "(15e)");
    assert.equal(await withEnvironment({ CBASE_NETWORK_ROOT: b.s.root }, () => projectLock(ctx.chat.id, "turn")), null, "the chat is not free after the clearing");
  });
});

test("(15f) wasAliveAgain, criterion 2 alone: if step 5 failed before it stopped the copy and its instance row stands `ready` afterwards (a release before the fix revived it, its container ran on — no mark, no new start), the clearing fetches and backs up once more before step 5: the commit afterwards stands in the main", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    const k = await buildCopy(b);
    let one;
    try {
      b.fd.errorAt([{ daemon: "host", pattern: "^stop -t 30 " }]); // step 5: `docker stop` of the copy fails
      one = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    } finally { b.fd.errorAt([]); }
    assert.equal(one.state, "error", JSON.stringify(one.report).slice(0, 1500));
    assert.match(one.report.error, /^Abräumen unvollständig: .*injected error/);
    const z = store.stackCopy(k.id);
    assert.deepEqual([z.state, z.journal.step], ["error", "clear-remove"], "precondition: failed in step 5");
    const started = copyContainer(b)?.started;
    assert.equal(copyContainer(b)?.status, "running", "precondition: the container of the copy ran on");
    // As a release before the fix revived it (without restarting the container), then something worked in it.
    setInstanceState(pid, inst, "ready", { phase: "" });
    const c = commitInCopy(b, "after-the-revival.txt");
    assert.equal(copyContainer(b)?.started, started, "precondition: no new start — criterion 3 would otherwise carry too");
    const two = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(two.state, "removed", JSON.stringify(two.report).slice(0, 1500));
    commitInMain(b, c, "after-the-revival.txt");
    assert.equal(two.report.revived, "Instanz-Zeile „ready“");
    nothingLeftOver(b, "(15f)");
  });
});
