// The code state of a copy (stacks/code-snapshot.js, stacks/objects.js). The snapshot runs for real: the clone helper in the
// fake docker (fake-docker.mjs), every git through the real wrapper in the helper — executed locally, but with the helper's
// environment (FAKE_DOCKER_MOUNTS), by which an fsmonitor hook recognises where it runs.
//
// What holds here:
//   (1) Snapshot in the helper: project repo first (commit "State before copy <name>" in the helper, part `p`), then the code
//       repos `r0`, `r1` in search order; a worktree (gitfile) is named, not linked. Per repo: all refs including
//       `refs/remotes/origin/HEAD` (symref) and `refs/stash`, HEAD, number of stashes, upstream configuration, `info/exclude`;
//       open changes as a tar (changed, new, with a space, in subfolders), deleted tracked paths as a delete list; objects as
//       hard links (same inode), the upper layer with an opaque `.git`, mount point `.git/objects` and a copied `shallow`
//       (nlink 1); `snapshot.json` 0600. Every hook ran IN THE HELPER with GIT_OPTIONAL_LOCKS=0; every exec into the helper
//       as agent through the wrapper.
//   (2) With `base`: no open changes, no tar.
//   (3) Cap with message: rows and tar.
//   (4) Objects: only files and folders (symlink, FIFO ⇒ error), without tmp_*/incoming-*/*.lock/alternates, promisor named;
//       EPERM ⇒ copy (counted), EXDEV ⇒ error; cap; an existing target and a source through a link ⇒ error.
//   (5) Upper layer and location: shallow never through a link; an existing location ⇒ COPY_LOCATION_EXISTS, a link in the
//       parents ⇒ COPY_LOCATION_REFERENCE; removeCopyLocation.
//   (6) refValid after check-ref-format.
//   (7) Guard: under stacks/ B starts no git — no child process with "git", no gitRun/commandRun without an instance, no import
//       of git.js, every project-repo function with `instance:`, `node:child_process` only in objects.js (xattr) — with a
//       built-in sabotage.
//   (8) The project folder as a code repo with `? app/` and `? wt/` in the status ⇒ snapshot instead of abort; `notLinked` names
//       the embedded repo, the submodule (gitlink) and the IGNORED worktree in `app`, without duplicates;
//       assume-unchanged/skip-worktree: changed ⇒ in the tar (content of the main) and in `open.hidden`, deleted with only
//       assume-unchanged ⇒ delete list, missing with skip-worktree ⇒ `hiddenMissing`; with base (no status) the same list.
//   (9) The object cap takes effect before B has read more than cap + 1 names (counting seam over readdirSync/opendirSync),
//       counts skipped entries too, the depth is limited; `shallow` over the cap ⇒ COPY_CAP before reading; a `.git/config`
//       over 4 MiB is not read ⇒ no mark, with a line in the log.
//   (10) With base ONE `sh -c` in the helper (BEFORE_COPY) reads HEAD and base of the project repo BEFORE the commit "Stand vor
//       Kopie" ⇒ `beforeCopy` at part p (base known: its id; only app knows it: null; an object without ".": text null); the
//       commit itself stays and carries the open changes of the project root; without base no `beforeCopy`. The copy side:
//       stacks-creation.test.js (17)–(19).
//
// COUNTER-PROOFS (each shown red by a short sabotage):
//   code-snapshot.js reading the repo through spawnSync in B instead of commandRun   ⇒ (1) red ("in-b" in the hook log) and (7) red
//   code-snapshot.js without GIT_OPTIONAL_LOCKS in env/envAlways                      ⇒ (1) red (hook saw GIT_OPTIONAL_LOCKS empty)
//   objects.js linkObjects without the lstat branch "no folder, no file"               ⇒ (4) red (symlink linked)
//   objects.js without the EPERM copy                                                  ⇒ (4) red (EPERM thrown)
//   code-snapshot.js without `withoutOpen` (base ignored)                              ⇒ (2) red (tar despite base)
//   objects.js prepareLayer linking `shallow` instead of copying                       ⇒ (1) red ("layer/ shares an inode")
//   code-snapshot.js searchProject with `instance: null`                               ⇒ (7) red, plus in-project-start-places.test.js
//   the old state of the object/config reading (readdirSync + sort, skipped entries not counted, no depth, no shallow cap,
//       config without a cap)                                                          ⇒ (9) red ("301 names", "did not throw", "Missing expected exception", mark read despite 5 MiB)
//   `? x/` read through a path conversion again / listing without gitlinks and worktrees / no entry from `ls-files -v` / no
//       branch for embedded repos with a base                                          ⇒ (8) red (path "app/" is not relative; submodule and worktree missing; hidden [] instead of [cfg.txt, sk.txt]; with base app/sub missing)
//   code-snapshot.js without the call of readBeforeCopy                                ⇒ (10) red (beforeCopy missing), plus stacks-creation (17), (18)
//
// No clock. macOS: TMPDIR real (a helper mounts no bind source across the link /var → /private/var).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DIRS } from "../electron/server/app-state.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { removeHelper, startHelper } from "../electron/server/projectbox/helper.js";
import { createProjectRepo, carriesProjectRepoMarker } from "../electron/server/projectbox/projectRepo.js";
import { locationFor } from "../electron/server/runs/runtime-location.js";
import { SNAPSHOT_VERSION, BEFORE_COPY, codeSnapshot, refValid } from "../electron/server/stacks/code-snapshot.js";
import { prepareLayer, removeCopyLocation, createCopyLocation, setLinkSeam, linkObjects } from "../electron/server/stacks/objects.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

process.env.TMPDIR = fs.realpathSync(os.tmpdir());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STACKS = path.join(HERE, "..", "electron", "server", "stacks");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function raises(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("did not throw");
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cbase-stacks-code-${name}-`));

// ── The situation: project repo with app (clone with origin, branches, stash, open changes, fsmonitor hook), lib (shallow clone)
// and wt (worktree of app, gitfile) ─────────────────────────────────────────────────────────────────────────────────────
function situation(ctx, s) {
  const outside = path.join(ctx.root, `outside-${s.projectId}`);
  fs.mkdirSync(outside, { recursive: true });
  const qApp = path.join(outside, "source-app");
  fs.mkdirSync(qApp);
  git(qApp, "init", "-q", "-b", "main");
  for (const f of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(qApp, f), `${f}\n`);
  git(qApp, "add", ".");
  git(qApp, "commit", "-q", "-m", "one");
  const app = path.join(s.path, "app");
  git(s.path, "clone", "-q", qApp, "app");
  git(app, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(app, "f.txt"), "f\n");
  git(app, "add", "f.txt");
  git(app, "commit", "-q", "-m", "feature");
  git(app, "checkout", "-q", "main");
  fs.appendFileSync(path.join(app, "a.txt"), "stashed\n");
  git(app, "stash", "-q");
  fs.appendFileSync(path.join(app, "a.txt"), "open\n");
  fs.rmSync(path.join(app, "b.txt"));
  fs.writeFileSync(path.join(app, "my space.txt"), "space\n");
  fs.mkdirSync(path.join(app, "under"));
  fs.writeFileSync(path.join(app, "under", "deep.txt"), "deep\n");
  fs.writeFileSync(path.join(app, ".git", "info", "exclude"), "# own rule\n*.log\n");
  const marker = path.join(outside, "fsmonitor.log");
  const hook = path.join(outside, "fsmonitor-hook");
  fs.writeFileSync(hook, `#!/bin/sh\nif [ -n "$FAKE_DOCKER_MOUNTS" ]; then w=in-helper; else w=in-b; fi\nprintf '%s:%s\\n' "$w" "$GIT_OPTIONAL_LOCKS" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(app, "config", "core.fsmonitor", hook);
  git(app, "worktree", "add", "-q", path.join(s.path, "wt"), "-b", "wtbranch");
  const qLib = path.join(outside, "source-lib");
  fs.mkdirSync(qLib);
  git(qLib, "init", "-q", "-b", "main");
  for (const n of [1, 2]) { fs.writeFileSync(path.join(qLib, "l.txt"), `${n}\n`); git(qLib, "add", "."); git(qLib, "commit", "-q", "-m", `l${n}`); }
  git(s.path, "clone", "-q", "--depth", "1", `file://${qLib}`, "lib");
  fs.writeFileSync(path.join(s.path, "notes.md"), "Notes\n");
  return { app, lib: path.join(s.path, "lib"), marker };
}

async function withHelper(s, name, fn) {
  const location = copyLocation({ data: DIRS.data, projectId: s.projectId, name });
  createCopyLocation(location);
  const runtime = locationFor({ projectId: s.projectId, converted: true });
  fs.mkdirSync(runtime.processes, { recursive: true });
  const helper = await startHelper({
    kind: "clone", projectId: s.projectId, instance: copyInstance(name), mounts: [
      { type: "bind", source: s.path, target: s.path },
      { type: "bind", source: runtime.root, target: runtime.root },
      { type: "bind", source: location.root.open, target: location.root.open },
    ],
  });
  try { return await fn(helper, location); } finally { await removeHelper(helper.id); }
}

async function withSituation(fn) {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const l = situation(ctx, s);
    // The test creates the project repo in B (setup, no product path): afterwards app, lib, wt lie in its exclusion.
    const pr = await createProjectRepo(s.path);
    assert.equal(pr.created, true, JSON.stringify(pr));
    fs.writeFileSync(path.join(s.path, "note-new.md"), "new\n");
    const opaqueLog = path.join(ctx.root, `opaque-${s.projectId}.log`);
    const opaque = path.join(ctx.root, `opaque-${s.projectId}`);
    fs.writeFileSync(opaque, `#!/bin/sh\nfor p in "$@"; do printf '%s\\n' "$p" >> '${opaqueLog}'; done\n`, { mode: 0o755 });
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: opaque, HOME: s.home }, () => withOps(fd, () => fn({ ctx, s, l, fd, opaqueLog })));
    } finally { fd.cleanUp(); }
  });
}

// ── (1) Snapshot in the helper ───────────────────────────────────────────────────────────────────────────────────────────

test("(1) snapshot in the helper: project repo first, refs/HEAD/stash/upstream, tar and delete list, hard links, upper layer, all git in the helper", async () => {
  await withSituation(async ({ s, l, fd, opaqueLog }) => {
    const noted = [];
    fs.rmSync(l.marker, { force: true }); // the setup (worktree add in B) already called the hook
    const start = fd.calls({ daemon: "host" }).length;
    const { result, helperId, location } = await withHelper(s, "k1", async (helper, o) => ({
      result: await codeSnapshot({ projectId: s.projectId, name: "k1", projectPath: s.path, location: o, helper, note: (x) => { noted.push(x.part); } }),
      helperId: helper.id, location: o,
    }));
    // Project repo: the commit in the helper.
    assert.equal(result.projectRepo, true);
    assert.equal(git(s.path, "log", "-1", "--format=%s"), "State before copy k1");
    assert.equal(result.commit, git(s.path, "rev-parse", "HEAD"));
    assert.deepEqual(result.repos.map((r) => [r.part, r.rel]), [["p", "."], ["r0", "app"], ["r1", "lib"]]);
    assert.deepEqual(result.notLinked, [{ rel: "wt", reason: "gitfile" }]);
    assert.deepEqual([...new Set(noted)], ["projectRepo", "p", "r0", "r1", "finished"]);

    const file = location.root.snapshot;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const sn = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(sn.version, SNAPSHOT_VERSION);
    assert.equal(sn.base, false);
    const app = sn.repos.find((r) => r.part === "r0");
    const refs = Object.fromEntries(app.refs.map((r) => [r.name, r]));
    for (const n of ["refs/heads/main", "refs/heads/feature", "refs/heads/wtbranch", "refs/remotes/origin/main", "refs/remotes/origin/HEAD", "refs/stash"]) assert.ok(refs[n], `ref ${n} missing: ${Object.keys(refs)}`);
    assert.equal(refs["refs/remotes/origin/HEAD"].symref, "refs/remotes/origin/main");
    assert.equal(refs["refs/heads/feature"].oid, git(l.app, "rev-parse", "feature"));
    assert.deepEqual(app.head, { symref: "refs/heads/main", oid: git(l.app, "rev-parse", "HEAD") });
    assert.equal(app.stash, 1);
    const cfg = Object.fromEntries(app.config);
    assert.equal(cfg["branch.main.remote"], "origin");
    assert.equal(cfg["branch.main.merge"], "refs/heads/main");
    assert.ok(cfg["remote.origin.url"], JSON.stringify(app.config));
    assert.equal(app.exclude, "# own rule\n*.log\n");
    // Open changes: tar with exactly the existing paths, delete list.
    assert.deepEqual([...app.open.paths].sort(), ["a.txt", "my space.txt", "under/deep.txt"]);
    assert.deepEqual(app.open.erase, ["b.txt"]);
    assert.equal(app.open.tar, "r0.tar");
    const inTar = execFileSync("tar", ["-tf", path.join(location.root.open, "r0.tar")], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    assert.deepEqual(inTar, ["a.txt", "my space.txt", "under/deep.txt"]);
    const p = sn.repos.find((r) => r.part === "p");
    assert.equal(p.projectRepo, true);
    assert.deepEqual(p.open.paths, [], "after the commit the project repo is clean");
    // Objects: hard links to the objects of the main.
    const lose = execFileSync("find", [path.join(l.app, ".git", "objects"), "-type", "f"], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(lose.length > 0);
    for (const q of lose) {
      const rel = path.relative(path.join(l.app, ".git", "objects"), q);
      const z = path.join(location.root.objects("r0"), rel);
      assert.equal(fs.statSync(z).ino, fs.statSync(q).ino, `no hard link: ${rel}`);
    }
    assert.equal(app.objects.files, lose.length);
    // Contract: under objects/ every file has nlink ≥ 2 (it shares the inode with the main), no counted copy here; under
    // layer/ NO file shares an inode (nlink 1) — a link there would write through.
    const filesUnder = (w) => execFileSync("find", [w, "-type", "f"], { encoding: "utf8" }).split("\n").filter(Boolean);
    assert.ok(sn.repos.every((r) => r.objects.copied === 0));
    for (const f of filesUnder(path.dirname(location.root.objects("r0")))) assert.ok(fs.statSync(f).nlink >= 2, `objects/ without a link: ${f}`);
    const top = filesUnder(path.dirname(location.root.layer("r0")));
    assert.ok(top.length > 0);
    for (const f of top) assert.equal(fs.statSync(f).nlink, 1, `layer/ shares an inode: ${f}`);
    // The upper layer: opaque .git, mount point, shallow copied.
    for (const t of ["p", "r0", "r1"]) assert.ok(fs.statSync(path.join(location.root.layer(t), ".git", "objects")).isDirectory(), t);
    assert.deepEqual(fs.readFileSync(opaqueLog, "utf8").split("\n").filter(Boolean).sort(), ["p", "r0", "r1"].map((t) => path.join(location.root.layer(t), ".git")).sort());
    const lib = sn.repos.find((r) => r.part === "r1");
    assert.equal(lib.shallow, true);
    const shallow = path.join(location.root.layer("r1"), ".git", "shallow");
    assert.equal(fs.readFileSync(shallow, "utf8"), fs.readFileSync(path.join(l.lib, ".git", "shallow"), "utf8"));
    assert.equal(fs.statSync(shallow).nlink, 1, "shallow is a copy, not a link");
    assert.equal(app.shallow, false);
    // Every hook ran in the helper, with GIT_OPTIONAL_LOCKS=0.
    const hookRows = fs.readFileSync(l.marker, "utf8").split("\n").filter(Boolean);
    assert.ok(hookRows.length > 0, "the fsmonitor hook never ran");
    assert.deepEqual([...new Set(hookRows)], ["in-helper:0"]);
    // On the wire: every exec into the helper as agent through the wrapper (except the removal).
    const exec = fd.calls({ daemon: "host" }).slice(start).map((a) => a.args).filter((a) => a[0] === "exec" && a.includes(helperId));
    assert.ok(exec.length >= 4, JSON.stringify(exec.length));
    for (const a of exec) {
      assert.equal(a[a.indexOf("-u") + 1], "agent", JSON.stringify(a.slice(0, 8)));
      assert.ok(a.includes("/usr/sbin/cbase-wrapper"), JSON.stringify(a.slice(0, 12)));
    }
    assert.equal(exec.filter((a) => a.includes("sh") && a.includes("-c") && a.includes("GIT_OPTIONAL_LOCKS")).length, 3, "one sh -c per repo, with GIT_OPTIONAL_LOCKS");
  });
});

// ── (2) With base ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) with base: no open changes, no tar", async () => {
  await withSituation(async ({ s }) => {
    const { result, location } = await withHelper(s, "k2", async (helper, o) => ({
      result: await codeSnapshot({ projectId: s.projectId, name: "k2", projectPath: s.path, location: o, helper, base: { from: "main" } }), location: o,
    }));
    assert.deepEqual(result.repos.map((r) => r.open), [null, null, null]);
    assert.deepEqual(fs.readdirSync(location.root.open), [], "files in open/ despite base");
    const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
    assert.equal(sn.base, true);
    assert.ok(sn.repos.every((r) => r.open === null && r.refs.length > 0));
  });
});

// ── (10) With base the state of the project repo BEFORE "State before copy" ────────────────────────────────────────────────

test("(10) with base the helper reads HEAD and base of the project repo BEFORE \"State before copy\" (beforeCopy at part p); the commit stays; without base no beforeCopy", async () => {
  await withSituation(async ({ s, fd }) => {
    // Open changes of the project root: note-new.md (new, from the situation) and notes.md changed.
    fs.appendFileSync(path.join(s.path, "notes.md"), "changed\n");
    const before = git(s.path, "rev-parse", "HEAD");
    const start = fd.calls({ daemon: "host" }).length;
    const { result, location, helperId } = await withHelper(s, "k10", async (helper, o) => ({
      result: await codeSnapshot({ projectId: s.projectId, name: "k10", projectPath: s.path, location: o, helper, base: "main" }), location: o, helperId: helper.id,
    }));
    // The commit "State before copy" stays and carries the open changes into the main; the refs of the snapshot stand
    // afterwards.
    assert.equal(git(s.path, "log", "-1", "--format=%s"), "State before copy k10");
    assert.equal(git(s.path, "rev-parse", "HEAD^"), before);
    const inside = git(s.path, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    for (const f of ["note-new.md", "notes.md"]) assert.ok(inside.includes(f), `${f} missing in the commit: ${inside}`);
    const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
    const p = sn.repos.find((r) => r.part === "p");
    assert.equal(p.head.oid, result.commit);
    // beforeCopy: the state before — the base applies against it (stacks/prepare.js checkoutArgs).
    assert.deepEqual(p.beforeCopy, { head: before, base: before, text: "main" });
    assert.deepEqual(result.repos.find((r) => r.part === "p").beforeCopy, p.beforeCopy, "the summary carries beforeCopy too");
    assert.ok(sn.repos.filter((r) => r.part !== "p").every((r) => r.beforeCopy === undefined), "beforeCopy only at the project repo");
    // Read in the helper, as ONE sh -c with GIT_OPTIONAL_LOCKS.
    const exec = fd.calls({ daemon: "host" }).slice(start).map((a) => a.args).filter((a) => a[0] === "exec" && a.includes(helperId) && a.includes(BEFORE_COPY));
    assert.equal(exec.length, 1, "BEFORE_COPY did not run exactly once in the helper");
    assert.equal(exec[0][exec[0].indexOf("-u") + 1], "agent");
    assert.ok(exec[0].some((x) => String(x).includes("GIT_OPTIONAL_LOCKS")), JSON.stringify(exec[0].slice(0, 14)));

    // A base the project repo does not know (only app): `base` null, `head` the state before THIS commit.
    const before2 = git(s.path, "rev-parse", "HEAD");
    const sn2 = await withHelper(s, "k11", async (helper, o) => {
      await codeSnapshot({ projectId: s.projectId, name: "k11", projectPath: s.path, location: o, helper, base: "feature" });
      return JSON.parse(fs.readFileSync(o.root.snapshot, "utf8"));
    });
    assert.deepEqual(sn2.repos.find((r) => r.part === "p").beforeCopy, { head: before2, base: null, text: "feature" });
    // An object the project repo does not name: no text — the copy stands on the state before anyway (nowhere).
    const before3 = git(s.path, "rev-parse", "HEAD");
    const sn3 = await withHelper(s, "k12", async (helper, o) => {
      await codeSnapshot({ projectId: s.projectId, name: "k12", projectPath: s.path, location: o, helper, base: { app: "feature" } });
      return JSON.parse(fs.readFileSync(o.root.snapshot, "utf8"));
    });
    assert.deepEqual(sn3.repos.find((r) => r.part === "p").beforeCopy, { head: before3, base: null, text: null });
    // Without base: no beforeCopy (the open changes come along through the commit — as before).
    const sn4 = await withHelper(s, "k13", async (helper, o) => {
      await codeSnapshot({ projectId: s.projectId, name: "k13", projectPath: s.path, location: o, helper });
      return JSON.parse(fs.readFileSync(o.root.snapshot, "utf8"));
    });
    assert.equal(sn4.repos.find((r) => r.part === "p").beforeCopy, undefined);
  });
});

// ── (3) Cap ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) cap with message: rows (refs) and tar", async () => {
  await withSituation(async ({ s }) => {
    const e1 = await withEnvironment({ CBASE_COPY_ROWS_CAP: "2" }, () => withHelper(s, "k3", (helper, o) => raises(codeSnapshot({ projectId: s.projectId, name: "k3", projectPath: s.path, location: o, helper }))));
    assert.equal(e1.code, "COPY_CAP", e1.message);
    assert.match(e1.message, /^app: \d+ Refs — Deckel 2 .*CBASE_COPY_ROWS_CAP/); // German T() output (uiLang de)
    const e2 = await withEnvironment({ CBASE_COPY_TAR_CAP: "1" }, () => withHelper(s, "k4", (helper, o) => raises(codeSnapshot({ projectId: s.projectId, name: "k4", projectPath: s.path, location: o, helper }))));
    assert.equal(e2.code, "COPY_CAP", e2.message);
    assert.match(e2.message, /Tar der offenen Änderungen .*Deckel 1 .*CBASE_COPY_TAR_CAP/); // German T() output (uiLang de)
  });
});

// ── (4) Objects ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function objectFolder(root) {
  const q = path.join(root, "repo", ".git", "objects");
  for (const d of ["ab", "pack", "info", "incoming-1"]) fs.mkdirSync(path.join(q, d), { recursive: true });
  fs.writeFileSync(path.join(q, "ab", "cdef01"), "object");
  fs.writeFileSync(path.join(q, "ab", "tmp_obj_x"), "half");
  fs.writeFileSync(path.join(q, "pack", "pack-1.pack"), "pack");
  fs.writeFileSync(path.join(q, "pack", "pack-1.promisor"), "");
  fs.writeFileSync(path.join(q, "pack", "pack-2.pack.lock"), "");
  fs.writeFileSync(path.join(q, "info", "alternates"), "/elsewhere\n");
  fs.writeFileSync(path.join(q, "incoming-1", "x"), "received");
  fs.writeFileSync(path.join(q, "tmp_pack_y"), "half");
  return q;
}

test("(4) objects: hard links by the rules — skipped entries named, EPERM copied, EXDEV/symlink/FIFO/cap/existing target/link ⇒ error", async () => {
  const w = tmp("objects");
  try {
    const q = objectFolder(w);
    const anchor = path.join(w, "repo");
    const r = await linkObjects({ source: q, target: path.join(w, "k", "objects", "r0"), repo: "repo", anchor });
    assert.equal(r.files, 3);
    assert.equal(r.copied, 0);
    assert.equal(r.alternates, true);
    assert.equal(r.promisor, true);
    assert.deepEqual([...r.skipped].sort(), ["ab/tmp_obj_x", "incoming-1", "info/alternates", "pack/pack-2.pack.lock", "tmp_pack_y"]);
    assert.equal(fs.statSync(path.join(w, "k", "objects", "r0", "ab", "cdef01")).ino, fs.statSync(path.join(q, "ab", "cdef01")).ino);
    assert.equal(fs.existsSync(path.join(w, "k", "objects", "r0", "pack", "pack-1.promisor")), true);
    // An existing target is never mixed.
    assert.equal((await raises(linkObjects({ source: q, target: path.join(w, "k", "objects", "r0"), repo: "repo", anchor }))).code, "COPY_LOCATION_EXISTS");
    // EPERM (protected_hardlinks) ⇒ copied and counted; EXDEV ⇒ error.
    setLinkSeam((a, b) => { if (a.endsWith("cdef01")) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); fs.linkSync(a, b); });
    try {
      const r2 = await linkObjects({ source: q, target: path.join(w, "k2"), repo: "repo", anchor });
      assert.equal(r2.copied, 1);
      const z = path.join(w, "k2", "ab", "cdef01");
      assert.equal(fs.readFileSync(z, "utf8"), "object");
      assert.notEqual(fs.statSync(z).ino, fs.statSync(path.join(q, "ab", "cdef01")).ino);
    } finally { setLinkSeam(null); }
    setLinkSeam(() => { throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); });
    try {
      assert.equal((await raises(linkObjects({ source: q, target: path.join(w, "k3"), repo: "repo", anchor }))).code, "COPY_OBJECT_EXDEV");
    } finally { setLinkSeam(null); }
    // Cap.
    const e = await withEnvironment({ CBASE_COPY_OBJECTS_CAP: "2" }, () => raises(linkObjects({ source: q, target: path.join(w, "k4"), repo: "repo", anchor })));
    assert.equal(e.code, "COPY_CAP");
    assert.match(e.message, /Deckel.*CBASE_COPY_OBJECTS_CAP/); // German T() output (uiLang de)
    // A symlink, a FIFO under objects/ ⇒ error with the repo name.
    fs.symlinkSync("/etc/hosts", path.join(q, "ab", "reference"));
    const e2 = await raises(linkObjects({ source: q, target: path.join(w, "k5"), repo: "repo", anchor }));
    assert.equal(e2.code, "COPY_OBJECT_KIND");
    assert.match(e2.message, /^repo: \.git\/objects\/ab\/reference ist ein Symlink/); // German T() output (uiLang de)
    fs.rmSync(path.join(q, "ab", "reference"));
    execFileSync("mkfifo", [path.join(q, "pack", "pipe")]);
    const e3 = await raises(linkObjects({ source: q, target: path.join(w, "k6"), repo: "repo", anchor }));
    assert.match(e3.message, /ist ein FIFO/); // German T() output (uiLang de)
    fs.rmSync(path.join(q, "pack", "pipe"));
    // The source through a link between anchor and objects/ ⇒ error.
    fs.renameSync(path.join(w, "repo", ".git"), path.join(w, "real-git"));
    fs.symlinkSync(path.join(w, "real-git"), path.join(w, "repo", ".git"));
    const e4 = await raises(linkObjects({ source: q, target: path.join(w, "k7"), repo: "repo", anchor }));
    assert.match(e4.message, /führt über einen Verweis/); // German T() output (uiLang de)
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// ── (5) Upper layer and location ─────────────────────────────────────────────────────────────────────────────────────────

test("(5) upper layer and location: shallow never through a link; existing location and a link in the parents ⇒ error; removeCopyLocation", async () => {
  const w = tmp("location");
  try {
    const opaqueLog = path.join(w, "opaque.log");
    const opaque = path.join(w, "opaque");
    fs.writeFileSync(opaque, `#!/bin/sh\nfor p in "$@"; do printf '%s\\n' "$p" >> '${opaqueLog}'; done\n`, { mode: 0o755 });
    await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: opaque }, async () => {
      const repo = path.join(w, "repo");
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.writeFileSync(path.join(w, "secret"), "do not read\n");
      fs.symlinkSync(path.join(w, "secret"), path.join(repo, ".git", "shallow"));
      assert.throws(() => prepareLayer({ layer: path.join(w, "s1"), shallow: path.join(repo, ".git", "shallow"), anchor: repo }), (e) => e.code === "COPY_OBJECT_KIND");
      fs.rmSync(path.join(repo, ".git", "shallow"));
      fs.writeFileSync(path.join(repo, ".git", "shallow"), "abc\n");
      const r = prepareLayer({ layer: path.join(w, "s2"), shallow: path.join(repo, ".git", "shallow"), anchor: repo });
      assert.equal(fs.readFileSync(path.join(r.git, "shallow"), "utf8"), "abc\n");
      assert.ok(fs.statSync(path.join(r.git, "objects")).isDirectory());
      assert.deepEqual(fs.readFileSync(opaqueLog, "utf8").split("\n").filter(Boolean), [r.git]);
    });
    const location = copyLocation({ data: w, projectId: "p1", name: "k1" });
    createCopyLocation(location);
    assert.ok(fs.statSync(location.root.open).isDirectory());
    assert.equal(fs.statSync(location.root.base).mode & 0o777, 0o700);
    assert.throws(() => createCopyLocation(location), (e) => e.code === "COPY_LOCATION_EXISTS");
    assert.deepEqual(await removeCopyLocation({ location, projectId: "p1", instance: "copy-k1" }), { removed: true, overHelper: false });
    assert.equal(fs.existsSync(location.root.base), false);
    // A link in the parents: nothing is created through it.
    const location2 = copyLocation({ data: w, projectId: "p2", name: "k1" });
    fs.mkdirSync(path.join(w, "elsewhere"));
    fs.symlinkSync(path.join(w, "elsewhere"), path.dirname(location2.root.base));
    assert.throws(() => createCopyLocation(location2), (e) => e.code === "COPY_LOCATION_REFERENCE");
    assert.deepEqual(fs.readdirSync(path.join(w, "elsewhere")), []);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// ── (6) refValid ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(6) refValid after check-ref-format", () => {
  for (const ok of ["refs/heads/main", "refs/heads/feature/x-1", "refs/remotes/origin/HEAD", "refs/stash", "refs/tags/v1.0", "refs/heads/ä"]) assert.equal(refValid(ok), true, ok);
  for (const no of ["main", "refs/heads/", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/.x", "refs/heads/a b", "refs/heads/a~1", "refs/heads/a^", "refs/heads/a:b",
    "refs/heads/a?", "refs/heads/a*", "refs/heads/a[", "refs/heads/a\\b", "refs/heads/a@{1}", "refs/heads//a", "refs/heads/a.", "refs/heads/a\nb", "refs/heads/a\x00", "@", ""]) {
    assert.equal(refValid(no), false, JSON.stringify(no));
  }
});

// ── (7) The git guard ────────────────────────────────────────────────────────────────────────────────────────────────────

// Comments do not count (strings do: `execFile("git", …)` IS one).
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const PROJECT_REPO = ["createProjectRepo", "commitProjectRepo", "removeProjectRepo", "searchProject", "embeddedRepos", "upkeepExclude"];
// Who may import node:child_process, with the reason (the list may only shrink).
const KIND_ALLOWED = { "objects.js": "setOpaque: python3 sets user.overlay.opaque (no git; test seam CBASE_COPY_OPAQUE_PROGRAM)" };

function g9Violations(files) {
  const v = [];
  for (const [name, raw] of Object.entries(files)) {
    const src = withoutComments(raw);
    if (/\b(execFile|execFileSync|spawn|spawnSync|exec|execSync|fork)\s*\(\s*(["'`])git\b/.test(src)) v.push(`${name}: starts git itself (every git belongs in the clone helper)`);
    if (/\b(gitRun|commandRun)\s*\(\s*(null|undefined|false)\b/.test(src)) v.push(`${name}: gitRun/commandRun without an instance (would run in B)`);
    if (/\bgitInB\b/.test(src)) v.push(`${name}: gitInB (git in B)`);
    if (/from\s+["'][^"']*\/git\.js["']/.test(src)) v.push(`${name}: imports git.js (its starters run without an instance in B)`);
    if (/from\s+["'](node:)?child_process["']/.test(src) && !KIND_ALLOWED[name]) v.push(`${name}: imports node:child_process without an entry in KIND_ALLOWED`);
    for (const f of PROJECT_REPO) {
      for (const m of src.matchAll(new RegExp(`\\b${f}\\s*\\(([^;]*)`, "g"))) {
        if (!/\binstance\s*:/.test(m[1])) v.push(`${name}: ${f}(…) without \`instance:\` (would run in B)`);
        else if (/\binstance\s*:\s*(null|undefined|false)\b/.test(m[1])) v.push(`${name}: ${f}(…) with \`instance: null\` (would run in B)`);
      }
    }
  }
  return v;
}

test("(7) git guard: under stacks/ B starts no git — with a built-in sabotage", () => {
  const files = Object.fromEntries(fs.readdirSync(STACKS).filter((f) => f.endsWith(".js")).map((f) => [f, fs.readFileSync(path.join(STACKS, f), "utf8")]));
  assert.ok(files["code-snapshot.js"] && files["objects.js"]);
  for (const [f, reason] of Object.entries(KIND_ALLOWED)) {
    console.log(`[stacks-g9] child_process allowed in ${f}: ${reason}`);
    assert.match(files[f] || "", /from "node:child_process"/, `${f} is in KIND_ALLOWED but imports nothing — delete the entry`);
  }
  assert.deepEqual(g9Violations(files), []);
  // Sabotage: every rule red once, a comment not.
  const cs = files["code-snapshot.js"];
  const cases = [
    [`${cs}\nexecFileSync("git", ["status"]);\n`, /starts git itself/],
    [`${cs}\nspawn('git', []);\n`, /starts git itself/],
    [`${cs}\nawait gitRun(null, root, ["status"]);\n`, /without an instance/],
    [`${cs}\nimport { findRepos } from "../git.js";\n`, /imports git\.js/],
    [`${cs}\nimport { spawn } from "node:child_process";\n`, /child_process without an entry/],
    [cs.replace("searchProject(root, { instance: helperInst })", "searchProject(root, {})"), /searchProject\(…\) without `instance:`/],
    [cs.replace("{ empty: true, instance: helperInst }", "{ empty: true }"), /commitProjectRepo\(…\) without `instance:`/],
    [cs.replace("searchProject(root, { instance: helperInst })", "searchProject(root, { instance: null })"), /searchProject\(…\) with `instance: null`/],
  ];
  for (const [text, pattern] of cases) {
    const v = g9Violations({ "code-snapshot.js": text });
    assert.ok(v.some((x) => pattern.test(x)), `sabotage ${pattern} stayed green: ${JSON.stringify(v)}`);
  }
  assert.deepEqual(g9Violations({ "x.js": `// execFileSync("git", ["status"])\n/* gitRun(null, a) */\n` }), [], "a comment is not a call");
});

// ── (8) Repos in code repos and hidden changes ───────────────────────────────────────────────────────────────────────────

// The project folder is itself a code repo (no project repo) with a linked worktree `wt` (not ignored: `? wt/` in the status)
// and the code repo `app` (not ignored: `? app/`). In `app`: an embedded repo `sub` (`? sub/`), a submodule `lib/ext`
// (gitlink), an IGNORED worktree `.worktrees/x` (only `git worktree list` knows it) and four files with a bit: `cfg.txt`
// (assume-unchanged, changed), `sk.txt` (skip-worktree, changed), `weg.txt` (assume-unchanged, deleted), `sparse.txt`
// (skip-worktree, missing — a sparse checkout).
function situationCodeRepo(ctx, s) {
  const outside = path.join(ctx.root, `outside-${s.projectId}`);
  fs.mkdirSync(outside, { recursive: true });
  const p = s.path;
  git(p, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(p, "README.md"), "p\n");
  git(p, "add", "README.md");
  git(p, "commit", "-q", "-m", "p");
  git(p, "worktree", "add", "-q", path.join(p, "wt"), "-b", "wtbranch");
  const qExt = path.join(outside, "source-ext");
  fs.mkdirSync(qExt);
  git(qExt, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(qExt, "e.txt"), "e\n");
  git(qExt, "add", ".");
  git(qExt, "commit", "-q", "-m", "e");
  const app = path.join(p, "app");
  fs.mkdirSync(app);
  git(app, "init", "-q", "-b", "main");
  for (const f of ["cfg.txt", "sk.txt", "way.txt", "sparse.txt"]) fs.writeFileSync(path.join(app, f), `${f}\n`);
  fs.writeFileSync(path.join(app, ".gitignore"), ".worktrees/\n");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "a");
  git(app, "-c", "protocol.file.allow=always", "submodule", "add", "-q", qExt, "lib/ext");
  git(app, "commit", "-q", "-m", "sub");
  const sub = path.join(app, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
  git(sub, "add", ".");
  git(sub, "commit", "-q", "-m", "s");
  git(app, "worktree", "add", "-q", path.join(app, ".worktrees", "x"), "-b", "x");
  git(app, "update-index", "--assume-unchanged", "cfg.txt");
  fs.writeFileSync(path.join(app, "cfg.txt"), "hidden changed\n");
  git(app, "update-index", "--skip-worktree", "sk.txt");
  fs.writeFileSync(path.join(app, "sk.txt"), "sk changed\n");
  git(app, "update-index", "--assume-unchanged", "way.txt");
  fs.rmSync(path.join(app, "way.txt"));
  git(app, "update-index", "--skip-worktree", "sparse.txt");
  fs.rmSync(path.join(app, "sparse.txt"));
  return { app };
}

async function withCodeSituation(fn) {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const l = situationCodeRepo(ctx, s);
    const opaque = path.join(ctx.root, `opaque-${s.projectId}`);
    fs.writeFileSync(opaque, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: opaque, HOME: s.home }, () => withOps(fd, () => fn({ ctx, s, l, fd })));
    } finally { fd.cleanUp(); }
  });
}

test("(8) code repo as project folder — `? x/` named instead of an abort, submodule and worktrees in code repos named, hidden changes taken along", async () => {
  await withCodeSituation(async ({ s }) => {
    const { result, location } = await withHelper(s, "k8", async (helper, o) => ({
      result: await codeSnapshot({ projectId: s.projectId, name: "k8", projectPath: s.path, location: o, helper }), location: o,
    }));
    assert.equal(result.projectRepo, false);
    assert.deepEqual(result.repos.map((r) => [r.part, r.rel]), [["p", "."], ["r0", "app"]]);
    const named = [
      { rel: "wt", reason: "gitfile" }, //                 from the search (stage 1)
      { rel: "app/sub", reason: "embedded" }, //        `? sub/` in the status of app
      { rel: "app/lib/ext", reason: "submodule" }, //       gitlink in the index of app
      { rel: "app/.worktrees/x", reason: "worktree" }, //  ignored — only `git worktree list` knows it
    ];
    assert.deepEqual(result.notLinked, named);
    const sn = JSON.parse(fs.readFileSync(location.root.snapshot, "utf8"));
    assert.deepEqual(sn.notLinked, named, "snapshot.json names the same ones (the clearing passes skip them)");
    // `? app/` and `? wt/` in the status of the project folder: not into the tar, not named twice.
    const p = sn.repos.find((r) => r.part === "p");
    assert.deepEqual(p.open.paths, []);
    assert.deepEqual(p.open.hidden, []);
    // The changed files with a bit in the tar, the deleted one with ONLY assume-unchanged in the delete list, the missing one
    // with skip-worktree counted.
    const app = sn.repos.find((r) => r.part === "r0");
    assert.deepEqual([...app.open.paths].sort(), ["cfg.txt", "sk.txt"]);
    assert.deepEqual(app.open.hidden, ["cfg.txt", "sk.txt"]);
    assert.deepEqual(app.open.erase, ["way.txt"]);
    assert.equal(app.open.hiddenMissing, 1);
    const inTar = execFileSync("tar", ["-tf", path.join(location.root.open, "r0.tar")], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    assert.deepEqual(inTar, ["cfg.txt", "sk.txt"]);
    const tarContent = execFileSync("tar", ["-xOf", path.join(location.root.open, "r0.tar"), "cfg.txt"], { encoding: "utf8" });
    assert.equal(tarContent, "hidden changed\n", "the content of the main, not that of HEAD");
    // The summary (what stacks/result.js gets) carries the numbers.
    assert.deepEqual(result.repos.find((r) => r.part === "r0").open, { paths: 2, erase: 1, size: app.open.size, hidden: 2, hiddenMissing: 1 });

    // With base: no status — the embedded repo then comes from `ls-files --others` in the read bundle, submodule and worktrees
    // as without base; the same list.
    const { result: e2 } = await withHelper(s, "k9", async (helper, o) => ({
      result: await codeSnapshot({ projectId: s.projectId, name: "k9", projectPath: s.path, location: o, helper, base: "main" }),
    }));
    assert.deepEqual(e2.notLinked, named);
    assert.deepEqual(e2.repos.map((r) => r.open), [null, null]);
  });
});

// ── (9) Cap BEFORE the expensive operation ───────────────────────────────────────────────────────────────────────────────

// Counts how many names of a folder B gets in hand — through readdirSync AND opendirSync (the two ways to read a folder). A
// counting seam, no clock.
async function withNamesCounter(fn) {
  const old = { readdirSync: fs.readdirSync, opendirSync: fs.opendirSync };
  const z = { names: 0 };
  fs.readdirSync = function (...a) { const r = old.readdirSync.apply(this, a); z.names += r.length; return r; };
  fs.opendirSync = function (...a) {
    const d = old.opendirSync.apply(this, a);
    const read = d.readSync.bind(d);
    d.readSync = () => { const e = read(); if (e) z.names += 1; return e; };
    return d;
  };
  try { return await fn(z); } finally { Object.assign(fs, old); }
}

test("(9) the cap takes effect before the expensive operation — folder entry by entry, depth limited, shallow and config by fstat", async () => {
  const w = tmp("cap");
  try {
    // A big fan-out folder: the cap takes effect before B has read more than cap + 1 names (formerly readdirSync loaded and
    // sorted the whole folder).
    const q = path.join(w, "repo", ".git", "objects");
    fs.mkdirSync(path.join(q, "ab"), { recursive: true });
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(q, "ab", `o${String(i).padStart(4, "0")}`), "x");
    const anchor = path.join(w, "repo");
    const e1 = await withNamesCounter(async (z) => {
      const e = await withEnvironment({ CBASE_COPY_OBJECTS_CAP: "5" }, () => raises(linkObjects({ source: q, target: path.join(w, "k1"), repo: "repo", anchor })));
      return { e, names: z.names };
    });
    assert.equal(e1.e.code, "COPY_CAP", e1.e.message);
    assert.ok(e1.names <= 6, `B read ${e1.names} names before the cap 5 took effect`);
    // Skipped entries count too: a folder full of tmp_* is no free pass.
    fs.rmSync(path.join(q, "ab"), { recursive: true });
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(q, `tmp_obj_${i}`), "x");
    const e2 = await withEnvironment({ CBASE_COPY_OBJECTS_CAP: "10" }, () => raises(linkObjects({ source: q, target: path.join(w, "k2"), repo: "repo", anchor })));
    assert.equal(e2.code, "COPY_CAP", e2.message);
    for (let i = 0; i < 50; i++) fs.rmSync(path.join(q, `tmp_obj_${i}`));
    // Depth: a folder chain under objects/ ⇒ error with a message instead of one open descriptor per level.
    let deep = path.join(q, "info");
    for (let i = 0; i < 40; i++) deep = path.join(deep, "d"); // git creates at most two levels under objects/
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "o"), "x");
    const e3 = await raises(linkObjects({ source: q, target: path.join(w, "k3"), repo: "repo", anchor }));
    assert.equal(e3.code, "COPY_CAP", e3.message);
    assert.match(e3.message, /tiefer als \d+ Ebenen/); // German T() output (uiLang de)
    fs.rmSync(path.join(q, "info"), { recursive: true });
    // Without excess the same pass links as before (the counter-proof against a cap that rejects everything).
    fs.mkdirSync(path.join(q, "ab"));
    fs.writeFileSync(path.join(q, "ab", "cd"), "x");
    assert.equal((await linkObjects({ source: q, target: path.join(w, "k4"), repo: "repo", anchor })).files, 1);

    // shallow: the cap by fstat BEFORE reading.
    await withEnvironment({ CBASE_COPY_OPAQUE_PROGRAM: "/usr/bin/true", CBASE_COPY_SHALLOW_CAP: "16" }, async () => {
      const sh = path.join(w, "repo", ".git", "shallow");
      fs.writeFileSync(sh, `${"a".repeat(40)}\n${"b".repeat(40)}\n`);
      assert.throws(() => prepareLayer({ layer: path.join(w, "s1"), shallow: sh, anchor }), (e) => e.code === "COPY_CAP" && /82 Bytes — Deckel 16/.test(e.message)); // German T() output (uiLang de)
      fs.writeFileSync(sh, "c\n");
      assert.equal(fs.readFileSync(path.join(prepareLayer({ layer: path.join(w, "s2"), shallow: sh, anchor }).git, "shallow"), "utf8"), "c\n");
    });

    // .git/config of the project repo: over the cap not read ⇒ no mark, with one line in the log.
    const pr = path.join(w, "pr");
    fs.mkdirSync(path.join(pr, ".git"), { recursive: true });
    const marker = "[cbase]\n\tprojectrepo = true\n";
    fs.writeFileSync(path.join(pr, ".git", "config"), marker);
    assert.equal(carriesProjectRepoMarker(pr), true, "the mark without excess (otherwise this would test nothing)");
    fs.writeFileSync(path.join(pr, ".git", "config"), `${marker}#${"x".repeat(5 * 1024 * 1024)}\n`); // over the cap (4 MiB)
    const warn = console.warn;
    const rows = [];
    console.warn = (...a) => rows.push(a.join(" "));
    try { assert.equal(carriesProjectRepoMarker(pr), false); } finally { console.warn = warn; }
    assert.ok(rows.some((z) => /cap \d+ .*reached, not read/.test(z)), JSON.stringify(rows));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
