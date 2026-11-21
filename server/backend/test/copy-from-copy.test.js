// Copy from a copy, with real repos through the real queue on the fake docker (harness server/backend/test/stacks-copy-harness.mjs).
// The new copy gets a COPY of the template's upper layers (`layer/` as a whole: `cbase-clone layer`, phase 1 live, phase 2 as a
// reconcile in the pause) over the same lower layers — the main and the objects as hard links to the template's (stacks/code-snapshot.js
// templateSnapshot). The TEMPLATE is frozen, not the main (stacks/freeze.js, "freeze" lock per instance in projectbox/idle.js).
//
// What holds:
//   (1) From k1 (branch with commit, stash, changed/deleted/staged/untracked, project root changed) arises k2 with EXACTLY k1's state —
//       HEAD, status, stash, reflog, files —, including what k1 wrote between phase 1 and the pause. In phase 2 only k1 is locked and
//       paused, never the main; phase 1 runs unlocked. The snapshot carries `template`, the objects are hard links to k1's (same inode),
//       k1's commit lies in k2's own upper object layer. Result: `code.template` and the template sentence instead of the reflog/index
//       sentence; the turn's copy paragraph names the template (runs/system-prompt.js copyOfTheTurn). The main stays untouched. What k2
//       writes, neither k1 nor the main sees; fetching from k2 brings only `copy/k2/kind`, never the template's branch. k1 can be cleared
//       away afterwards, k2 stays ready and keeps its objects.
//   (2) base from the template: asked IN the template (stacks/request.js baseInTheTemplate) — a branch only of the template passes, one
//       only of the main is 409 COPY_BASE (also via submitCopyRequest, without a row), a repo the template does not carry likewise. Built
//       over the whole request, `app` stands clean on the base: untracked files of the template drop (stacks/prepare.js CLEAN_UP),
//       ignored ones stay, the project repo (not named) stands clean on its HEAD; the template stays as it was.
//   (3) The template before any effort: unknown => 409 TEMPLATE_UNKNOWN, invalid => 400 BASE_INSTANCE_INVALID, not ready => 409
//       TEMPLATE_NOT_READY, each without a row. A waiting copy waits for its TEMPLATE (the reason names it), the state waker wakes it as
//       soon as the template becomes ready (stacks/queue.js wakeMainReady — the main does not wake it), and it arises. If the template is
//       gone, the waiting copy fails with a reason instead of waiting forever.
//   (4) The template's worktrees (under `copy-worktrees/k1` and at another place) are not carried by k2 as its own — `feat` is free in k2,
//       fetching from k2 takes nothing from them; a worktree in the project folder came with the layer and works in k2; the template keeps
//       all three (stacks/prepare.js FOREIGN_WORKTREES).
//
// Counter-tests (which sabotage turns which test red):
//   freeze.js without `layer --phase 2` (phase 1 only)                       => (1) red ("the layer copy (phase 2) never ran")
//   freeze.js with the "freeze" lock on the main instead of the source        => (1) red ("the template is not locked in phase 2")
//   freeze.js so that the copy always arises from the main                    => (1), (2), (3) red ("phase 1 never ran"; prepare: "the
//       repo "app" does not know "template" as a commit (COPY_BASE)")
//   idle.js (ONLY_MAIN: "freeze" touches only the main)                       => (1), (2), (3) red (copy error: lock: …)
//   request.js baseInMain instead of baseInTheTemplate                        => (2) red (branch only of the main accepted)
//   prepare.js without CLEAN_UP                                               => (2) red ("app does not stand clean on the base")
//   queue.js wakeMainReady only for the main                                  => (3) red ("the main wakes a copy from a template")
//   queue.js without templateGone                                             => (3) red ("k4 waits without a template: …")
//   prepare.js without the FOREIGN WORKTREES step                             => (4) red ("k2 carries foreign worktrees": app, different/y,
//       copy-worktrees/k1/x, wt-inside)
//
// No clock: states are waited for (waitForTruthy without a deadline) and the stop markers of the fake clone (b.clone.layerHold).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { MAIN, containerName, copyInstance } from "../electron/server/projectbox/creation.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLocked } from "../electron/server/projectbox/idle.js";
import { copyOfTheTurn, projectFocusPrompt } from "../electron/server/runs/system-prompt.js";
import { clearAwayCopy } from "../electron/server/stacks/clearAway.js";
import { baseInTheTemplate, submitCopyRequest } from "../electron/server/stacks/request.js";
import { readSnapshot } from "../electron/server/stacks/code-snapshot.js";
import { SET } from "../electron/server/stacks/result.js";
import { copyFetch } from "../electron/server/stacks/fetch.js";
import { wakeMainReady, wakeQueue } from "../electron/server/stacks/queue.js";
import { copyRequests } from "../electron/server/stacks/state.js";
import { locationFor, worktreeRoot } from "../electron/server/runs/runtime-location.js";
import { waitForTruthy } from "./agent-harness.mjs";
import { buildCopy, dx, git, situationDefault, withCopy, refs } from "./stacks-copy-harness.mjs";

const K1 = copyInstance("k1");

// Commands IN a copy by name (the harness knows only k1 as `b.copy`).
const inK = (b, name, cwd, ...cmd) => dx(b.fd, "exec", "-w", cwd, containerName(b.s.projectId, copyInstance(name)), ...cmd);
const gitK = (b, name, cwd, ...args) => inK(b, name, cwd, "git", "-c", "user.name=agent", "-c", "user.email=agent@copy", ...args);
const write = (b, name, file, text) => inK(b, name, path.dirname(file), "/bin/sh", "-c", 'printf "%s" "$1" > "$2"', "sh", text, path.basename(file));
// `git status --porcelain` per row with "|" in front: dx trims the output, and the first row would otherwise lose its leading space.
const statusK = (b, name, cwd) => inK(b, name, cwd, "/bin/sh", "-c", "git status --porcelain | sed 's/^/|/'").split("\n").filter(Boolean).sort();
const exists = (b, name, cwd, rel) => inK(b, name, cwd, "/bin/sh", "-c", 'if [ -e "$1" ]; then echo yes; else echo gone; fi', "sh", rel) === "yes";
const containerOf = (b, name) => Object.values(b.fd.state().container).find((c) => c.name === name) || null;

/** The first file under a folder (recursive, sorted) — for the inode comparison of the objects. */
function firstFile(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(dir, e.name);
    if (e.isFile()) return p;
    if (e.isDirectory()) { const f = firstFile(p); if (f) return f; }
  }
  return null;
}
const looseObject = (dir, oid) => path.join(dir, oid.slice(0, 2), oid.slice(2));

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) k2 arises from k1 with the template's whole state; only k1 is frozen; k2 works and fetches independently; k1 can be cleared away", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    const app = b.app;
    const p = b.s.path;
    await buildCopy(b);
    const location1 = b.location;

    // Work in k1: a branch with a commit, a stash, open changes of every kind, the project root changed.
    gitK(b, "k1", app, "checkout", "-q", "-b", "template");
    write(b, "k1", path.join(app, "v.txt"), "v1\n");
    gitK(b, "k1", app, "add", "v.txt");
    gitK(b, "k1", app, "commit", "-q", "-m", "v1");
    const v1 = gitK(b, "k1", app, "rev-parse", "HEAD");
    write(b, "k1", path.join(app, "a.txt"), "in stash\n");
    gitK(b, "k1", app, "stash", "-q");
    write(b, "k1", path.join(app, "a.txt"), "open in k1\n");
    inK(b, "k1", app, "rm", "b.txt");
    write(b, "k1", path.join(app, "s.txt"), "staged\n");
    gitK(b, "k1", app, "add", "s.txt");
    write(b, "k1", path.join(app, "u.txt"), "unversioned\n");
    write(b, "k1", path.join(p, "notes.md"), "Notes from k1\n");

    const mainStatus = () => ({ p: git(p, "rev-parse", "HEAD"), pStatus: git(p, "status", "--porcelain"), app: git(app, "symbolic-ref", "HEAD"), main: git(app, "rev-parse", "main"), appStatus: git(app, "status", "--porcelain"), branches: git(app, "for-each-ref", "--format=%(refname)", "refs/heads") });
    const mainPrior = mainStatus();

    const n0 = b.fd.calls().length;
    const c1 = containerName(pid, K1);
    const h1 = b.clone.layerHold(1);
    const h2 = b.clone.layerHold(2);
    let finished = false;
    const build = buildCopy(b, { name: "k2", baseInstance: K1 });
    build.then(() => { finished = true; }, () => { finished = true; });
    let w1 = false;
    let w2 = false;
    try {
      await waitForTruthy(() => h1.reached() || finished || null, "phase 1 of the layer copy");
      assert.ok(h1.reached(), "the layer copy (phase 1) never ran");
      // Phase 1 runs live: the template is neither locked nor paused, it keeps working — phase 2 takes it along.
      assert.equal(projectLocked(pid, K1), null, "the template is already locked in phase 1");
      assert.equal(Boolean(containerOf(b, c1)?.paused), false, "the template is already paused in phase 1");
      write(b, "k1", path.join(app, "late.txt"), "after phase 1\n");
      w1 = true; h1.further();
      await waitForTruthy(() => h2.reached() || finished || null, "phase 2 of the layer copy");
      assert.ok(h2.reached(), "the layer copy (phase 2) never ran");
      assert.equal(projectLocked(pid, K1)?.reason, "freeze", "the template is not locked in phase 2");
      assert.equal(projectLocked(pid), null, "the main is locked — the template is what gets frozen");
      assert.equal(Boolean(containerOf(b, c1)?.paused), true, "the template is still running in phase 2");
      assert.equal(Boolean(containerOf(b, b.main)?.paused), false, "the main is paused");
    } finally {
      if (!w1) h1.further();
      if (!w2) { w2 = true; h2.further(); }
    }
    const k2 = await build;
    const location2 = b.location;
    assert.equal(projectLocked(pid, K1), null, "the template's lock stayed");
    assert.equal(Boolean(containerOf(b, c1)?.paused), false, "the template stayed paused");
    // `unpause` names the id (projectbox/docker.js thaw), `pause` the name — both brought to the name.
    const nameOf = (x) => Object.entries(b.fd.state().container).find(([id, c]) => c.name === x || id === x || id.startsWith(x))?.[1].name || x;
    const hold = b.fd.calls().slice(n0).filter(({ args: a }) => a[0] === "pause" || a[0] === "unpause").map(({ args: a }) => `${a[0]} ${nameOf(a[1])}`);
    assert.deepEqual(hold, [`pause ${c1}`, `unpause ${c1}`], "only the template stood still");

    // The state: k2 is k1 — also stash, reflog, index and what k1 wrote between phase 1 and the pause.
    const snapshot = (name) => ({
      head: gitK(b, name, app, "symbolic-ref", "HEAD"),
      oid: gitK(b, name, app, "rev-parse", "HEAD"),
      status: statusK(b, name, app),
      stash: gitK(b, name, app, "stash", "list", "--format=%H"),
      reflog: gitK(b, name, app, "reflog", "--format=%H"),
      a: inK(b, name, app, "cat", "a.txt"),
      late: inK(b, name, app, "cat", "late.txt"),
      notes: inK(b, name, p, "cat", "notes.md"),
    });
    const s1 = snapshot("k1");
    assert.equal(s1.head, "refs/heads/template");
    assert.equal(s1.oid, v1);
    assert.deepEqual(s1.status, ["| D b.txt", "| M a.txt", "|?? late.txt", "|?? u.txt", "|A  s.txt"]);
    assert.equal(s1.stash.split("\n").filter(Boolean).length, 1);
    assert.deepEqual(snapshot("k2"), s1, "k2 does not carry the template's state");

    // Snapshot and objects: `template`, hard links to k1's objects, k1's commit in k2's own upper layer.
    const sn = readSnapshot(location2);
    assert.deepEqual(sn.template, { name: "k1", instance: K1 });
    assert.equal(sn.commit, null);
    const part = sn.repos.find((r) => r.rel === "app")?.part;
    assert.match(String(part), /^r\d+$/);
    const f1 = firstFile(location1.root.objects(part));
    assert.ok(f1, "the template has no objects");
    const f2 = path.join(location2.root.objects(part), path.relative(location1.root.objects(part), f1));
    assert.equal(fs.statSync(f2).ino, fs.statSync(f1).ino, "k2's objects are no hard links to k1's");
    assert.ok(fs.existsSync(looseObject(location2.root.layerObjects(part), v1)), "the template's commit is missing in k2's upper object layer");

    // Result and the turn's copy paragraph.
    const e = store.stackCopy(k2.id).result;
    assert.equal(e.code.template, "k1");
    assert.ok(e.hints.includes(SET.template("k1")), e.hints.join("\n"));
    assert.ok(!e.hints.includes(SET.reflogs) && !e.hints.includes(SET.index), "reflog/index sentence on a copy from a copy");
    assert.deepEqual(copyOfTheTurn({ projectId: pid, instance: copyInstance("k2") }), { name: "k2", template: "k1" });
    assert.deepEqual(copyOfTheTurn({ projectId: pid, instance: K1 }), { name: "k1" });
    const paragraph = projectFocusPrompt(store.getProject(pid), { converted: true, copy: { name: "k2", template: "k1" } });
    assert.match(paragraph, /The code state is that of the copy "k1" at the freeze/);
    assert.doesNotMatch(paragraph, /reflogs, the index state and stashes did not/);

    // The main: untouched (no "state before copy", no branch).
    assert.deepEqual(mainStatus(), mainPrior, "the copy from the template changed the main");

    // k2 works: neither k1 nor the main sees it.
    gitK(b, "k2", app, "checkout", "-q", "-b", "kind");
    write(b, "k2", path.join(app, "a.txt"), "from k2\n");
    inK(b, "k2", app, "rm", "c.txt");
    gitK(b, "k2", app, "add", "-A");
    gitK(b, "k2", app, "commit", "-q", "-m", "kind");
    const kind = gitK(b, "k2", app, "rev-parse", "HEAD");
    assert.deepEqual(snapshot("k1"), s1, "k2 wrote into the template");
    assert.ok(exists(b, "k1", app, "c.txt"), "k2 deleted in the template");
    assert.deepEqual(mainStatus(), mainPrior, "k2 wrote into the main");

    // Fetching from k2: only its own branch — the template's was already in the snapshot.
    const eh = await copyFetch(k2.id, b.opts);
    assert.deepEqual(eh.repos.find((r) => r.rel === "app")?.error, []);
    const fetched = Object.fromEntries(Object.entries(refs(app, "refs/heads/copy/k2")).filter(([n]) => !/\/(stash|reflog)-\d+$/.test(n)));
    assert.deepEqual(fetched, { "refs/heads/copy/k2/kind": kind });
    assert.equal(git(app, "show", `${kind}:a.txt`), "from k2");
    assert.deepEqual(refs(app, "refs/heads/copy/k1"), {}, "a branch under the template's name came from k2");

    // The template goes, k2 stays — with its objects.
    assert.equal((await clearAwayCopy(store.liveStackCopy(pid, "k1").id, { reason: "test", ...b.opts })).state, "removed");
    assert.equal(fs.existsSync(location1.root.base), false, "the template's location stayed");
    assert.equal(store.stackCopy(k2.id).state, "ready");
    assert.equal(store.projectInstance(pid, copyInstance("k2"))?.state, "ready");
    assert.ok(fs.existsSync(f2), "k2 lost an object with the template");
    assert.ok(fs.existsSync(looseObject(location2.root.layerObjects(part), v1)), "k2 lost the template's commit");
    assert.equal(gitK(b, "k2", app, "rev-parse", "HEAD"), kind);
    assert.equal(gitK(b, "k2", app, "rev-parse", "kind^"), v1);
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) base from the template: asked in the template; the copy stands clean on the base, ignored files stay, the template untouched", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    const app = b.app;
    const p = b.s.path;
    await buildCopy(b);
    const location1 = b.location;
    gitK(b, "k1", app, "checkout", "-q", "-b", "template");
    write(b, "k1", path.join(app, "v.txt"), "v1\n");
    gitK(b, "k1", app, "add", "v.txt");
    gitK(b, "k1", app, "commit", "-q", "-m", "v1");
    const v1 = gitK(b, "k1", app, "rev-parse", "HEAD");
    write(b, "k1", path.join(app, "a.txt"), "open in k1\n");
    write(b, "k1", path.join(app, "u.txt"), "unversioned\n");
    inK(b, "k1", app, "mkdir", "fresh");
    write(b, "k1", path.join(app, "fresh", "x.txt"), "x\n");
    write(b, "k1", path.join(app, "k.log"), "ignored\n");
    write(b, "k1", path.join(p, "notes.md"), "Notes from k1\n");
    // A commit only the main knows (without touching its working tree).
    const onlyMain = git(app, "commit-tree", "-p", "main", "-m", "only in main", "main^{tree}");
    git(app, "branch", "only-main", onlyMain);

    const state1 = () => ({ head: gitK(b, "k1", app, "symbolic-ref", "HEAD"), status: gitK(b, "k1", app, "status", "--porcelain"), notes: inK(b, "k1", p, "cat", "notes.md") });
    const prior1 = state1();

    // The pre-check asks the template.
    const project = store.getProject(pid);
    const inst = store.projectInstance(pid, K1);
    const repos = readSnapshot(location1).repos.map((r) => ({ rel: String(r.rel) }));
    assert.deepEqual(repos.map((r) => r.rel).sort(), [".", "app"]);
    await baseInTheTemplate("template", { project, inst, repos });
    await baseInTheTemplate({ app: "template" }, { project, inst, repos });
    const base409 = (e) => e?.code === "COPY_BASE" && e?.status === 409;
    await assert.rejects(baseInTheTemplate("only-main", { project, inst, repos }), base409);
    await assert.rejects(baseInTheTemplate({ app: "only-main" }, { project, inst, repos }), base409);
    await assert.rejects(baseInTheTemplate({ foreign: "main" }, { project, inst, repos }), base409);
    await assert.rejects(submitCopyRequest({ projectId: pid, name: "k9", baseInstance: K1, base: "only-main" }), base409);
    assert.equal(store.liveStackCopy(pid, "k9"), null, "a row despite 409");

    const k2 = await buildCopy(b, { name: "k2", baseInstance: K1, base: { app: "template" }, overRequest: true });
    assert.deepEqual(k2.base, { app: "template" });
    assert.equal(gitK(b, "k2", app, "rev-parse", "HEAD"), v1);
    assert.equal(gitK(b, "k2", app, "status", "--porcelain"), "", "app does not stand clean on the base");
    assert.equal(inK(b, "k2", app, "cat", "a.txt"), "a.txt");
    assert.equal(exists(b, "k2", app, "u.txt"), false, "untracked file of the template stayed");
    assert.equal(exists(b, "k2", app, "fresh"), false, "an untracked folder of the template stayed");
    assert.equal(inK(b, "k2", app, "cat", "k.log"), "ignored", "the ignored file dropped");
    // The project repo (not named in the base) stands clean on its HEAD.
    assert.equal(inK(b, "k2", p, "cat", "notes.md"), "Notizen");
    assert.equal(gitK(b, "k2", p, "status", "--porcelain"), "");
    assert.ok(exists(b, "k2", p, "app"), "the embedded repo fell victim to the cleaning in the project repo");
    const e = store.stackCopy(k2.id).result;
    assert.equal(e.code.template, "k1");
    assert.ok(e.hints.includes(SET.template("k1")));
    // The template: as before.
    assert.deepEqual(state1(), prior1, "the copy with a base changed the template");
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) template unknown, invalid, not ready: rejection without a row; a waiting copy wakes with its template and fails without it", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    await buildCopy(b);
    const request = (baseInstance) => submitCopyRequest({ projectId: pid, name: "k9", baseInstance });
    await assert.rejects(request(copyInstance("way")), (e) => e?.code === "TEMPLATE_UNKNOWN" && e?.status === 409);
    await assert.rejects(request("copy-Groß"), (e) => e?.code === "BASE_INSTANCE_INVALID" && e?.status === 400);
    store.changeProjectInstance(pid, K1, { state: "start" });
    await assert.rejects(request(K1), (e) => e?.code === "TEMPLATE_NOT_READY" && e?.status === 409);
    assert.equal(store.liveStackCopy(pid, "k9"), null, "a row despite the rejection");

    // A row that already stands (the request would not allow it now): it waits for its template, not for the main.
    let finished = false;
    const build = buildCopy(b, { name: "k3", baseInstance: K1 });
    build.then(() => { finished = true; }, () => { finished = true; });
    const w = await waitForTruthy(() => {
      const z = store.liveStackCopy(pid, "k3");
      return finished || (z?.state === "waiting_queue" && /k1/.test(z.reason)) ? z || {} : null;
    }, "k3 waits for its template");
    assert.equal(w.state, "waiting_queue", JSON.stringify(w));
    assert.match(w.reason, /Vorlage „k1“ nicht bereit \(start\)|template "k1" not ready \(start\)/);
    // The state waker (server.js -> wake main ready): the template wakes, the main does not.
    let woken = false;
    try {
      assert.equal(wakeMainReady(pid, { instance: MAIN, state: "ready" }), false, "the main wakes a copy from a template");
      assert.equal(wakeMainReady(pid, { instance: K1, state: "start" }), false);
      assert.equal(wakeMainReady(pid, { instance: K1, state: "ready" }), true, "the ready template does not wake its waiting copy");
      assert.equal(store.liveStackCopy(pid, "k3").state, "waiting_queue", "k3 began before its template");
      setInstanceState(pid, K1, "ready"); // wakes via the state waker — no queue wake here
      woken = true;
    } finally {
      // A red case does not let k3 wait forever (the copy builder waits without a deadline): template ready, queue woken by hand.
      if (!woken) { if (store.projectInstance(pid, K1)?.state !== "ready") setInstanceState(pid, K1, "ready"); wakeQueue(); }
    }
    const k3 = await build;
    assert.equal(k3.state, "ready");
    assert.deepEqual(readSnapshot(b.location).template, { name: "k1", instance: K1 });

    // The template is gone: the waiting copy fails with a reason.
    const way = copyRequests({ projectId: pid, name: "k4", chatId: "chat-template-way", baseInstance: copyInstance("way") });
    wakeQueue();
    // Waited for `error` OR a wait that names the template — otherwise a red case would hang instead of being red.
    const z = await waitForTruthy(() => { const x = store.stackCopy(way.id); return x.state === "error" || /weg/.test(x.reason || "") ? x : null; }, "k4 fails without a template");
    assert.equal(z.state, "error", `k4 waits without a template: ${z.reason}`);
    assert.match(z.error, /Vorlage „way“ gibt es nicht mehr/);
  });
});

// ── (4) The template's worktrees ────────────────────────────────────────────────────────────────────────────────────────
// The management of the template's worktrees (`.git/worktrees/<id>`) came with its layer, and the runtime folder is mounted rw in EVERY
// project container: k2 took k1's worktrees for its own — `git checkout feat` refuses ("already used by worktree"), fetching saved
// foreign open work and foreign detached heads under `copy/k2/…`. Now, before any other step of the preparation (stacks/prepare.js
// FOREIGN_WORKTREES), every management folder whose worktree does not lie under a target of the overlays drops: the one under
// `copy-worktrees/k1` (like a subagent of the template) AND one at another place the template saw (runtime folder, not under
// copy-worktrees). One IN the project folder came with the layer and is this copy's copy — it stays and works in k2 (with
// `--relative-paths`, git >= 2.48: so `gitdir` points to the place IN the copy on the fake docker as in the kernel; an absolute path
// would carry k1's view of the folder here).
// Sabotage: prepare.js without that step => red ("k2 carries foreign worktrees": four instead of two).
test("(4) the template's worktrees do not belong to the new copy: those under copy-worktrees/k1 and elsewhere drop, the one in the project folder stays; feat is free, fetching takes nothing foreign", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const pid = b.s.projectId;
    const app = b.app;
    const p = b.s.path;
    await buildCopy(b);
    const run = locationFor({ projectId: pid, converted: true });
    const wtX = path.join(worktreeRoot(run, K1), "x");
    const wtY = path.join(run.root, "different", "y");
    gitK(b, "k1", app, "worktree", "add", "-q", "-b", "feat", wtX);
    write(b, "k1", path.join(wtX, "a.txt"), "open in the template's worktree\n");
    gitK(b, "k1", app, "worktree", "add", "-q", "--detach", wtY);
    gitK(b, "k1", wtY, "commit", "-q", "--allow-empty", "-m", "detached in y");
    gitK(b, "k1", app, "worktree", "add", "-q", "--relative-paths", "-b", "inside", "../wt-inside");
    const list = (name) => gitK(b, name, app, "worktree", "list", "--porcelain").split("\n").filter((z) => z.startsWith("worktree ")).map((z) => z.slice(9));
    assert.equal(list("k1").length, 4, `precondition: k1 carries three worktrees (${list("k1").join(", ")})`);

    const k2 = await buildCopy(b, { name: "k2", baseInstance: K1 });
    assert.equal(k2.state, "ready", k2.error || "");
    const w2 = list("k2");
    assert.equal(w2.length, 2, `k2 carries foreign worktrees: ${w2.join(", ")}`);
    assert.ok(!w2.some((x) => x.includes("copy-worktrees") || x.includes(`${path.sep}different${path.sep}`)), w2.join(", "));
    assert.ok(w2.some((x) => x.endsWith(`${path.sep}wt-inside`)), `the worktree in the project folder is missing in k2: ${w2.join(", ")}`);

    // In k2: feat is free, the worktree in the project folder is its own.
    gitK(b, "k2", app, "checkout", "-q", "feat");
    assert.equal(gitK(b, "k2", app, "symbolic-ref", "HEAD"), "refs/heads/feat");
    assert.equal(gitK(b, "k2", path.join(p, "wt-inside"), "symbolic-ref", "HEAD"), "refs/heads/inside");
    // The template: untouched, including the open work in worktree x.
    assert.equal(list("k1").length, 4, "k2 took the template's worktrees");
    assert.equal(inK(b, "k1", wtX, "cat", "a.txt"), "open in the template's worktree");
    assert.equal(gitK(b, "k1", wtX, "symbolic-ref", "HEAD"), "refs/heads/feat");

    // Fetching from k2: nothing from the template's worktrees (their work is fetched by the template).
    await copyFetch(k2.id, b.opts);
    assert.deepEqual(refs(app, "refs/heads/copy/k2"), {}, "k2 saved work from the template's worktrees under its name");
  });
});
