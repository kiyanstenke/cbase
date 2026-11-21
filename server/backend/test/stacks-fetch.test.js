// Fetching a copy back (stacks/fetch.js, stacks/project-repo-copy.js, stacks/returnPath.js, route in stacks/routes.js) with real
// repos: a copy runs through the real sequence up to `ready`, the "agent" works in it via docker exec (the fake replays the upper
// layer), and the fetch goes through the return-path helper with the REAL python3 (harness stacks-copy-harness.mjs).
//
// What is proved:
//   (1) Branches: only new and moved branches land at `copy/k1/<b>` (unchanged feature => no ref), a detached HEAD with a commit at
//       `copy/k1/detached`; a second fetch changes nothing (idempotent); if the copy rewrites history the new state lands at
//       `copy/k1/main-1` and `copy/k1/main` stays. HEAD, branch and worktree of main stay. Every fetch source is the empty repo
//       `returnPath/<part>.git` (argv of the fake docker). A `reference-transaction` hook of main runs in the helper, never in B.
//       Plus the route (200, 400, 404).
//   (2) Project repo and new repos: `git init` with a commit and an open file in a new folder of the copy, the agent stages it in
//       the project repo => no mode 160000 in `copy/k1/main` and in main; a new file of the copy is merged into main, a see-through
//       file of main is not in the copy's commit; `info/exclude` of main stays byte-equal; the bundle clones to the commit and to the
//       backup of the open file. If the agent commits the gitlink itself (`--no-verify`) nothing is merged (`gitlinks`).
//       `retrieve` clones only to a free path.
//   (3) fsck and LFS: a broken commit in the upper object layer => its ref is rejected (the others are fetched); an LFS object with
//       matching content reaches main, one with a wrong name does not.
//   (4) a branch `a` fetched earlier and the copy renaming `a` to `a/b`: `a/b` lands at `copy/k1/a--b` (never under the file ref),
//       `copy/k1/a` stays, `error` is empty, the clear-away ends in `removed`.
//   (5) the list of the upper layer has a bytes cap next to the count cap — above it COPY_CAP with the knob CBASE_COPY_LAYER_BYTES
//       (instead of a string over V8's limit in B), the copy stays `ready`, without the knob it works.
//   (6) COPY_STATUS (real perl, fake git on the PATH) prints `caf\xe9/` from `ls-files --others` and a worktree with `\n` in its path
//       in the upper-case form — stateFromOutput reads `caf\udce9` (nameBytes 63 61 66 e9) and turns the worktree into a finding instead of
//       discarding the whole state.
//   (7) the search (projectRepo.js searchProject) reads names as bytes — a folder `caf\xe9` with `.git` (macOS creates none: the read
//       seam `fs.readdirSync` shows it) appears in newRepos as `caf\udce9`; WIP and BUNDLE get the repo as bytes (stdin or hex),
//       REPO_EXISTS answers with the index; source guard: no `k.pathOf(rel)` as cwd/argv.
//   (8) `git init node_modules/lib` with a commit in the copy => newRepos names it, a bundle is made.
//   (9) a commit on main, then `reset --hard HEAD~1` in the copy => the commit afterwards sits at `copy/k1/reflog-0`.
//  (10) first bundled, then the new repo's `.git` becomes a gitfile => the second fetch names it exactly once.
//  (11) two merges of the project repo of the same project at the same time (the first holds `index.lock` at the gate of the git
//       seam) => both succeed, no index.lock error.
//  (12) the output cap of the docker seam (CBASE_DOCKER_OUTPUT_BYTES) below the list of the upper layer => the list passes (it passes
//       `maxBytes` = its own bytes cap plus margin); an own cap above the seam's reports COPY_CAP with CBASE_COPY_LAYER_BYTES, never
//       "unreadable".
//  (13) a copy's node_modules with more entries than the list cap => the fetch passes (the folder counts as ONE entry); above the
//       search's own cap (CBASE_COPY_DEP_SEARCH_CAP) it names `depSearchIncomplete`.
//  (14) with base "feature" (only app knows it), `{ app: "feature" }` and "main" the copy's project repo stands detached at the state
//       before "State before copy"; a new file in its root reaches main through `copy/k1/detached` (`together.merged`), the open file
//       of main is NOT in the copy's commit, a second fetch is `already`; with "feature" also through the clear-away. Without a start
//       point the tip is never merged (notice). The program (`fromOf`): stacks-return-path-program.test.js.
//
// Without helper and B: the program itself (leftovers, write errors, names, merge, clone) in stacks-return-path-program.test.js.
//
// COUNTER-TESTS (each shown red, restored afterwards); see the header of stacks-clear-away.test.js for the clear-away:
//   returnPath.js fetch: fetch WITH `+`                                      => (1) red (copy/k1/main overwritten)
//   returnPath.js fetchIntoMain: source `location.root.layer(part)`           => (1) red (source not returnPath/<part>.git)
//   returnPath.js asAgent: python3 in B instead of via the helper instance   => (1) red (hook ran in B)
//   project-repo-copy.js: without takeFromTheIndex, hook `exit 0`             => (2) red (160000 in copy/k1/main)
//   project-repo-copy.js: `add -A` instead of `add -u` + list                => (2) red (later.md in the copy's commit)
//   project-repo-copy.js: upkeepExclude with `inContainer: false`            => (2) red (info/exclude of main changed — visible only
//       after a fetch WITHOUT a commit in main: its own commit otherwise tends the file back to its state)
//   project-repo-copy.js: without the gitlink check before the merge         => (2) red (merged despite gitlink)
//   returnPath.js git(): without `transfer.fsckObjects`/`fetch.fsckObjects`   => (3) red (broken commit fetched)
//   fetch.js fetchEverything without fetchLfs                                => (3) red (LFS object missing in main)
//   the fallback names under the file ref (all `a/b-N` below `copy/k1/a`)      => (4) red ("refs/heads/copy/k1/a exists; cannot create ..."),
//       a list without bytes                                                   => (5) red (no COPY_CAP)
//   fetch.js COPY_STATUS `satz` prints the lower-case form raw                => (6) red (unexpected line)
//   projectRepo.js search without `encoding: "buffer"`                        => (7) red (newRepos without caf\udce9)
//   returnPath.js `list` without git_in_dep                                   => (8) red (node_modules/lib missing in newRepos)
//   fetch.js jobsFor without the reflog jobs                                 => (9) red (reflog-0 missing)
//   fetch.js fetchEverything newRepos without the reconciliation by rel        => (10) red (`app/fresh` twice)
//   project-repo-copy.js mergeProjectRepo without the queue                   => (11) red (index.lock: File exists)
//   returnPath.js layerList without `maxBytes`                                => (12) red (COPY_LAYER "unreadable: docker exec: output above the cap of 40000 bytes")
//   fetch.js, returnPath.js searching against the list cap                    => (13) red (COPY_CAP "more than 30 entries")
//   the three product files without the way over the detached tip, without `fromOf` at the check, `merge` without the check of `fromOf`,
//   fetch.js without `start` at mergeProjectRepo                              => (14) red ("not merged: null", "no start point"), plus the
//       program counterpart in stacks-return-path-program.test.js
//
// No clock: waiting is on states (waitForTruthy without a deadline), the gates of the git seam are files. macOS: TMPDIR real (the
// harness sets it).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawn } from "node:child_process";
import * as store from "../electron/server/store.js";
import { dockerKind, dockerProgram } from "../electron/server/projectbox/docker.js";
import { BRANCH, createProjectRepo } from "../electron/server/projectbox/projectRepo.js";
import { setInProjectSeam } from "../electron/server/runtime/inProject.js";
import { clearAwayCopy } from "../electron/server/stacks/clearAway.js";
import { BUNDLE, COPY_STATUS, REPO_EXISTS, WIP, copyFetch, newRepos, stateFromOutput } from "../electron/server/stacks/fetch.js";
import { DETACHED_SOURCE, mergeProjectRepo, waitingMerges } from "../electron/server/stacks/project-repo-copy.js";
import { nameBytes, nulBytes } from "../electron/server/stacks/returnPath.js";
import { fakeDocker } from "./fake-docker.mjs";
import {
  buildCopy, treeOf, showThrough, git, gitCopy, gitlinksIn, inCopy, situationDefault, withCopy, withEnvironment, refs, returnPathCalls, writeInCopy,
} from "./stacks-copy-harness.mjs";

const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
async function response(url, init) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init?.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const fetchPost = (base, pid, name, body) => response(`${base}/api/projects/${pid}/stack-copies/${name}/fetch`, { method: "POST", body: JSON.stringify(body) });

// ── (1) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) branches: only new/moved ones, detached HEAD, idempotent, fallback ref after rewritten history, empty-repo source, hook in the helper, route", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const hookLog = path.join(ctx.root, "hook.log");
    // The main's hook is created AFTER the copy starts (the fake does not show it to the copy — it is to run in main only).
    fs.writeFileSync(path.join(app, ".git", "hooks", "reference-transaction"), `#!/bin/sh\nif [ -n "$FAKE_DOCKER_MOUNTS" ]; then echo "helper $1" >> '${hookLog}'; else echo "B $1" >> '${hookLog}'; fi\ncat > /dev/null\n`, { mode: 0o755 });
    const prior = { head: git(app, "symbolic-ref", "HEAD"), main: git(app, "rev-parse", "main"), status: git(app, "status", "--porcelain") };

    writeInCopy(b, path.join(app, "m1.txt"), "m1\n");
    gitCopy(b, app, "add", "m1.txt");
    gitCopy(b, app, "commit", "-q", "-m", "m1");
    const m1 = gitCopy(b, app, "rev-parse", "HEAD");
    gitCopy(b, app, "checkout", "-q", "-b", "new-b");
    writeInCopy(b, path.join(app, "n1.txt"), "n1\n");
    gitCopy(b, app, "add", "n1.txt");
    gitCopy(b, app, "commit", "-q", "-m", "n1");
    const n1 = gitCopy(b, app, "rev-parse", "HEAD");
    gitCopy(b, app, "checkout", "-q", "--detach");
    writeInCopy(b, path.join(app, "d1.txt"), "d1\n");
    gitCopy(b, app, "add", "d1.txt");
    gitCopy(b, app, "commit", "-q", "-m", "d1");
    const d1 = gitCopy(b, app, "rev-parse", "HEAD");

    const e1 = await copyFetch(k.id, b.opts);
    const r1 = e1.repos.find((r) => r.rel === "app");
    assert.deepEqual(r1.error, [], JSON.stringify(r1));
    assert.deepEqual(refs(app), { "refs/heads/copy/k1/detached": d1, "refs/heads/copy/k1/main": m1, "refs/heads/copy/k1/new-b": n1 }, "only new/moved branches and the detached HEAD");
    assert.deepEqual(r1.fetched.map((g) => [g.target, g.fallback]).sort(), [["refs/heads/copy/k1/detached", 0], ["refs/heads/copy/k1/main", 0], ["refs/heads/copy/k1/new-b", 0]]);

    // Idempotent: the same once more — no fallback refs.
    const e2 = await copyFetch(k.id, b.opts);
    assert.deepEqual(refs(app), { "refs/heads/copy/k1/detached": d1, "refs/heads/copy/k1/main": m1, "refs/heads/copy/k1/new-b": n1 }, "second fetch changed refs");
    assert.ok(e2.repos.find((r) => r.rel === "app").fetched.every((g) => g.fallback === 0));

    // The copy rewrites main => fallback ref, the first state stays.
    gitCopy(b, app, "checkout", "-q", "main");
    gitCopy(b, app, "reset", "-q", "--hard", b.start.main);
    writeInCopy(b, path.join(app, "m2.txt"), "m2\n");
    gitCopy(b, app, "add", "m2.txt");
    gitCopy(b, app, "commit", "-q", "-m", "m2");
    const m2 = gitCopy(b, app, "rev-parse", "HEAD");
    const e3 = await copyFetch(k.id, b.opts);
    const r3 = e3.repos.find((r) => r.rel === "app");
    assert.equal(refs(app)["refs/heads/copy/k1/main"], m1, "copy/k1/main overwritten (fetch with +?)");
    assert.equal(refs(app)["refs/heads/copy/k1/main-1"], m2, "the rewritten state is missing at the fallback ref");
    // new-b is new compared to the freeze and is fetched again every time (without effect); main has the fallback ref. On top comes
    // what only a reflog of the copy still holds: d1 (the detached HEAD before `checkout main` — m1 holds new-b)
    // under kopie/k1/reflog-0.
    const withoutReflog = (xs) => xs.filter(([z]) => !z.startsWith("refs/heads/copy/k1/reflog-"));
    assert.deepEqual(withoutReflog(r3.fetched.map((g) => [g.target, g.fallback]).sort()), [["refs/heads/copy/k1/main-1", 1], ["refs/heads/copy/k1/new-b", 0]]);
    const reflog = Object.entries(refs(app)).filter(([n]) => n.startsWith("refs/heads/copy/k1/reflog-")).map(([, o]) => o);
    assert.deepEqual(reflog, [d1], "the tip that only the copy's reflog holds");

    // The main: HEAD, main and worktree unchanged.
    assert.deepEqual({ head: git(app, "symbolic-ref", "HEAD"), main: git(app, "rev-parse", "main"), status: git(app, "status", "--porcelain") }, prior);

    // The hook ran — and only in the helper.
    const log = fs.readFileSync(hookLog, "utf8").split("\n").filter(Boolean);
    assert.ok(log.length > 0, "the hook never ran");
    assert.deepEqual(log.filter((z) => !z.startsWith("helper ")), [], "the hook ran in B");
    // Every fetch source is the empty repo.
    const fetch = returnPathCalls(b).filter((x) => x.command === "fetch");
    assert.ok(fetch.length >= 3, `too few fetch calls: ${fetch.length}`);
    for (const h of fetch) assert.match(h.rest[0], /\/returnPath\/(p|r\d+)\.git$/, `source ${h.rest[0]}`);

    // Route: 200 with a result, 400 for a wrong body, 404 for an unknown copy.
    const ok = await fetchPost(ctx.base, b.s.projectId, "k1", {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Array.isArray(ok.body.result.repos));
    assert.equal((await fetchPost(ctx.base, b.s.projectId, "k1", { retrieve: "fresh" })).status, 400);
    assert.equal((await fetchPost(ctx.base, b.s.projectId, "k1", { different: 1 })).status, 400);
    assert.equal((await fetchPost(ctx.base, b.s.projectId, "k9", {})).status, 404);
    assert.deepEqual(Object.fromEntries(withoutReflog(Object.entries(refs(app)))), { "refs/heads/copy/k1/detached": d1, "refs/heads/copy/k1/main": m1, "refs/heads/copy/k1/main-1": m2, "refs/heads/copy/k1/new-b": n1 });
  });
});

// ── (2) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) project repo and new repos: no 160000, merged without see-through files, main's exclude unchanged, bundle, own gitlink commit not merged, retrieve", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const k = await buildCopy(b);
    const p = b.s.path;
    const exclude = path.join(p, ".git", "info", "exclude");
    const excludePrior = sha(exclude);

    // A new repo in the copy: a commit and an open file; the agent stages it in the project repo (gitlink in the index).
    const fresh = path.join(p, "fresh");
    inCopy(b, p, "mkdir", "fresh");
    gitCopy(b, fresh, "init", "-q", "-b", "main");
    writeInCopy(b, path.join(fresh, "x.txt"), "x\n");
    gitCopy(b, fresh, "add", "x.txt");
    gitCopy(b, fresh, "commit", "-q", "-m", "x");
    const x = gitCopy(b, fresh, "rev-parse", "HEAD");
    writeInCopy(b, path.join(fresh, "open.txt"), "open\n");
    gitCopy(b, p, "add", "-f", "fresh");
    assert.match(gitCopy(b, p, "ls-files", "-s", "fresh"), /^160000 /, "precondition: the gitlink is in the copy's index");
    writeInCopy(b, path.join(p, "note-copy.md"), "from the copy\n");
    showThrough(b, "later.md", "in main after the start\n");
    assert.equal(inCopy(b, p, "cat", "later.md"), "in main after the start", "precondition: the copy sees main's file");

    const e1 = await copyFetch(k.id, b.opts);
    const pr = e1.projectRepo;
    assert.ok(pr?.copyCommit, JSON.stringify(pr));
    assert.deepEqual(pr.error, []);
    assert.deepEqual(pr.fetched.map((g) => g.target), [`refs/heads/copy/k1/${BRANCH}`]);
    const tree = treeOf(p, `refs/heads/copy/k1/${BRANCH}`);
    assert.ok(tree.includes("100644 note-copy.md"), tree.join("\n"));
    assert.ok(!tree.some((z) => z.endsWith(" later.md")), "a see-through file of main is in the copy's commit (add -A?)");
    assert.deepEqual(tree.filter((z) => z.startsWith("160000 ")), [], "gitlink in copy/k1/main");
    assert.equal(pr.together?.merged, true, JSON.stringify(pr.together));
    assert.equal(git(p, "show", "HEAD:note-copy.md"), "from the copy");
    assert.deepEqual(gitlinksIn(p, "HEAD"), [], "gitlink in main");
    assert.equal(sha(exclude), excludePrior, "main's info/exclude changed");

    // The new repo's bundle clones to the commit and to the backup of the open file.
    assert.deepEqual(e1.newRepos.map((n) => [n.rel, path.basename(n.bundle || "")]), [["fresh", "n0.bundle"]]);
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bundle-"));
    try {
      execFileSync("git", ["clone", "-q", e1.newRepos[0].bundle, path.join(clone, "r")]);
      const r = path.join(clone, "r");
      assert.equal(git(r, "rev-parse", "HEAD"), x);
      git(r, "fetch", "-q", e1.newRepos[0].bundle, "refs/cbase/*:refs/cbase/*");
      assert.equal(git(r, "show", "refs/cbase/wip/clone:open.txt"), "open");
      assert.equal(git(r, "rev-parse", "refs/cbase/wip/clone^"), x);
    } finally { fs.rmSync(clone, { recursive: true, force: true }); }

    // The agent commits the gitlink itself (past the hook): the next commit carries it, nothing is merged.
    gitCopy(b, p, "add", "-f", "fresh");
    gitCopy(b, p, "commit", "-q", "--no-verify", "-m", "gitlink");
    const headPrior = git(p, "rev-parse", "HEAD");
    const e2 = await copyFetch(k.id, b.opts);
    assert.deepEqual(e2.projectRepo.error, []);
    assert.deepEqual(e2.projectRepo.together, { target: `refs/heads/copy/k1/${BRANCH}`, merged: false, gitlinks: ["fresh"] });
    assert.equal(git(p, "rev-parse", "HEAD"), headPrior, "merged despite gitlink");
    assert.deepEqual(gitlinksIn(p, "HEAD"), [], "gitlink in main's history");
    assert.deepEqual(treeOf(p, `refs/heads/copy/k1/${BRANCH}`).filter((z) => z.startsWith("160000 ")), [], "gitlink at the tip of copy/k1/main");
    // Without a commit in main (not merged) nothing tends its `info/exclude` — had the copy written into it, it would stay.
    assert.equal(sha(exclude), excludePrior, "main's info/exclude changed (the copy's list?)");

    // Through the route: the backed-up repo to a free path, others rejected; a second time the path is taken.
    const r1 = await fetchPost(ctx.base, b.s.projectId, "k1", { retrieve: ["fresh", "../x", "notes.md", "fresh/.git"] });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.result.retrieved.map((r) => [r.rel, r.kind]), [["fresh", "repo"]]);
    assert.deepEqual(r1.body.result.denied.map((a) => a.rel).sort(), ["../x", "fresh/.git", "notes.md"]);
    assert.equal(git(fresh, "rev-parse", "main"), x);
    assert.equal(git(fresh, "show", "refs/cbase/wip/clone:open.txt"), "open");
    assert.equal(git(fresh, "remote"), "", "the clone kept origin");
    const r2 = await fetchPost(ctx.base, b.s.projectId, "k1", { retrieve: ["fresh"] });
    assert.deepEqual(r2.body.result.retrieved, []);
    assert.match(r2.body.result.denied[0]?.reason || "", /belegt/);
  });
});

// ── (3) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) fsck: a broken commit of the copy is not fetched, the other one is; LFS content-addressed into main", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const empty = gitCopy(b, app, "hash-object", "-t", "tree", "-w", "--stdin");
    const broken = inCopy(b, app, "sh", "-c", 'printf "tree %s\\nauthor K <k@k> broken +0000\\ncommitter K <k@k> 1 +0000\\n\\nbroken\\n" "$1" | git hash-object -t commit --literally -w --stdin', "sh", empty);
    gitCopy(b, app, "update-ref", "refs/heads/broken", broken);
    gitCopy(b, app, "checkout", "-q", "-b", "good");
    writeInCopy(b, path.join(app, "g.txt"), "g\n");
    gitCopy(b, app, "add", "g.txt");
    gitCopy(b, app, "commit", "-q", "-m", "good");
    const gut = gitCopy(b, app, "rev-parse", "HEAD");
    // LFS: one object with matching content, one whose name does not match its content.
    const content = "lfs-content\n";
    const h = crypto.createHash("sha256").update(content).digest("hex");
    const wrong = crypto.createHash("sha256").update("different\n").digest("hex");
    for (const x of [h, wrong]) inCopy(b, app, "mkdir", "-p", `.git/lfs/objects/${x.slice(0, 2)}/${x.slice(2, 4)}`);
    writeInCopy(b, path.join(app, ".git", "lfs", "objects", h.slice(0, 2), h.slice(2, 4), h), content);
    writeInCopy(b, path.join(app, ".git", "lfs", "objects", wrong.slice(0, 2), wrong.slice(2, 4), wrong), "not different\n");

    const e = await copyFetch(k.id, b.opts);
    const r = e.repos.find((x) => x.rel === "app");
    assert.deepEqual(r.error.map((f) => f.source), ["refs/heads/broken"], JSON.stringify(r));
    assert.match(r.error[0].notice, /fsck|badDate|bad date/i);
    assert.equal(refs(app)["refs/heads/copy/k1/good"], gut);
    assert.equal(refs(app)["refs/heads/copy/k1/broken"], undefined, "the broken commit was fetched (without fsck?)");
    execFileSync("git", ["cat-file", "-e", gut], { cwd: app });
    assert.throws(() => execFileSync("git", ["cat-file", "-e", broken], { cwd: app, stdio: "ignore" }), "the broken object is in main");

    const lfs = e.lfs.find((x) => x.rel === "app");
    assert.equal(lfs?.copied, 1, JSON.stringify(e.lfs));
    assert.deepEqual(lfs.denied.map((a) => [a.rel, a.reason]), [[`${wrong.slice(0, 2)}/${wrong.slice(2, 4)}/${wrong}`, "content does not match the name"]]);
    assert.equal(fs.readFileSync(path.join(app, ".git", "lfs", "objects", h.slice(0, 2), h.slice(2, 4), h), "utf8"), content);
    assert.equal(fs.existsSync(path.join(app, ".git", "lfs", "objects", wrong.slice(0, 2), wrong.slice(2, 4), wrong)), false);
    // Second fetch: present, nothing twice.
    const e2 = await copyFetch(k.id, b.opts);
    const l2 = e2.lfs.find((x) => x.rel === "app");
    assert.deepEqual([l2.copied, l2.existing], [0, 1]);
  });
});

// ── (4) ───────────────────────────────────────────────────────────────────────────────────────────

test("(4) a branch `a` fetched earlier does not block `a/b` — fallback outside copy/k1/a/, copy/k1/a stays, the clear-away ends in removed", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    gitCopy(b, app, "checkout", "-q", "-b", "a");
    writeInCopy(b, path.join(app, "a1.txt"), "a1\n");
    gitCopy(b, app, "add", "a1.txt");
    gitCopy(b, app, "commit", "-q", "-m", "a1");
    const a1 = gitCopy(b, app, "rev-parse", "HEAD");
    await copyFetch(k.id, b.opts);
    assert.equal(refs(app)["refs/heads/copy/k1/a"], a1);

    // The copy renames `a` to `a/b` (in it both cannot stand side by side).
    gitCopy(b, app, "checkout", "-q", "main");
    gitCopy(b, app, "branch", "-q", "-D", "a");
    gitCopy(b, app, "checkout", "-q", "-b", "a/b");
    writeInCopy(b, path.join(app, "abc.txt"), "ab\n");
    gitCopy(b, app, "add", "abc.txt");
    gitCopy(b, app, "commit", "-q", "-m", "ab");
    const fromIdx = gitCopy(b, app, "rev-parse", "HEAD");
    const e = await copyFetch(k.id, b.opts);
    const r = e.repos.find((x) => x.rel === "app");
    assert.deepEqual(r.error, [], JSON.stringify(r.error));
    const g = r.fetched.find((x) => x.source === "refs/heads/a/b");
    assert.ok(g && !g.target.startsWith("refs/heads/copy/k1/a/"), `fallback under the file ref copy/k1/a: ${JSON.stringify(r.fetched)}`);
    assert.equal(g.target, "refs/heads/copy/k1/a--b");
    assert.deepEqual([refs(app)["refs/heads/copy/k1/a"], refs(app)["refs/heads/copy/k1/a--b"]], [a1, fromIdx]);

    const output = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(output.state, "removed", JSON.stringify(output.report).slice(0, 1500));
    assert.equal(refs(app)["refs/heads/copy/k1/a--b"], fromIdx);
  });
});

// ── (5) ──────────────────────────────────────────────────────────────────────────────────────────

test("(5) the upper layer's list has a byte limit — above it COPY_CAP with the knob, B lives on, without the knob it works", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    writeInCopy(b, path.join(b.app, `${"long".repeat(40)}.txt`), "x\n");
    await assert.rejects(
      withEnvironment({ CBASE_COPY_LAYER_BYTES: "100" }, () => copyFetch(k.id, b.opts)),
      (e) => e?.code === "COPY_CAP" && /mehr als 100 Bytes Liste .*CBASE_COPY_LAYER_BYTES/.test(e.message),
    );
    assert.equal(store.stackCopy(k.id).state, "ready");
    const e = await copyFetch(k.id, b.opts);
    assert.ok(Array.isArray(e.repos));
  });
});

// ── (6) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const TMPR = fs.realpathSync(os.tmpdir());
/** A program (perl) to its end; stdin bytes. */
function perl(script, { args = [], cwd, env = {}, stdin = Buffer.alloc(0) } = {}) {
  return new Promise((resolve, reject) => {
    const subprocess = spawn("perl", ["-e", script, ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const out = []; const err = [];
    subprocess.stdout.on("data", (b) => out.push(b)); subprocess.stderr.on("data", (b) => err.push(b));
    subprocess.once("error", reject);
    subprocess.once("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    subprocess.stdin.on("error", () => {});
    subprocess.stdin.end(stdin);
  });
}

test("(6) COPY_STATUS prints names that are not UTF-8 or carry \\n in the upper-case form — stateFromOutput reads caf\\udce9 and turns the worktree into a finding", async () => {
  const d = fs.mkdtempSync(path.join(TMPR, "cbase-stand-"));
  try {
    const bin = path.join(d, "bin"); fs.mkdirSync(bin);
    const repo = path.join(d, "repo"); fs.mkdirSync(path.join(repo, "ok", ".git"), { recursive: true });
    const id1 = "a".repeat(40); const id2 = "b".repeat(40);
    // The fake git: only the questions of COPY_STATE, with the answers macOS cannot produce.
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh
case "$1" in
  for-each-ref|log|rev-list) exit 0;;
  rev-parse) case "$*" in *refs/stash*) exit 1;; esac; echo ${id1}; exit 0;;
  symbolic-ref) echo refs/heads/main; exit 0;;
  worktree) printf 'worktree /main\\0HEAD ${id1}\\0branch refs/heads/main\\0\\0worktree /tmp/a\\nb\\0HEAD ${id2}\\0detached\\0\\0'; exit 0;;
  ls-files) printf 'caf\\351/\\0ok/\\0'; exit 0;;
esac
exit 1
`, { mode: 0o755 });
    const r = await perl(COPY_STATUS, { cwd: repo, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(r.code, 0, r.stderr);
    const st = stateFromOutput(r.stdout.toString("utf8"), "repo");
    assert.deepEqual(st.gitfile, ["caf\udce9"]);
    assert.ok(nameBytes(st.gitfile[0]).equals(Buffer.from([0x63, 0x61, 0x66, 0xe9])), "not the bytes from the copy");
    assert.deepEqual(st.embedded, ["ok"]);
    assert.deepEqual(st.worktrees, [], "a worktree with \\n in its path is among the worktrees whose open work is backed up");
    assert.deepEqual(st.findings.map((b) => b.worktree), ["/tmp/a\nb"]);
    assert.deepEqual(st.wtHeads, [{ path: null, detached: true, head: id2, id: "" }], "its HEAD still counts");
    // The lower-case form with U+FFFD stays blocked.
    assert.throws(() => stateFromOutput("g caf�\0", "repo"), /unerwartete Zeile/);
    assert.throws(() => stateFromOutput('G "caf\\ufffd"\0', "repo"), /unerwartete Zeile/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── (7) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) a repo `caf\\xe9` appears in newRepos as caf\\udce9; WIP, BUNDLE and REPO_EXISTS take the repo as bytes", async (t) => {
  const d = fs.mkdtempSync(path.join(TMPR, "cbase-bytes-"));
  try {
    const p = path.join(d, "project"); fs.mkdirSync(p);
    const real = path.join(d, "real"); fs.mkdirSync(real);
    git(real, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(real, "x.txt"), "x\n");
    git(real, "add", "x.txt"); git(real, "commit", "-q", "-m", "x");
    // The read seam: the project folder has a folder whose name is not UTF-8 (macOS creates none) — read as bytes it is `caf\xe9`
    // and shows the content of `real`; read as text (the old way) it would be `caf�`, which does not exist.
    const FAKE = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const pathFake = Buffer.concat([Buffer.from(`${p}/`), FAKE]);
    const orig = fs.readdirSync;
    t.mock.method(fs, "readdirSync", function (q, opts) {
      const b = Buffer.isBuffer(q) ? q : Buffer.from(String(q));
      if (b.equals(Buffer.from(p))) {
        const raw = opts?.encoding === "buffer";
        return [...orig.call(fs, q, opts), { name: raw ? FAKE : FAKE.toString("utf8"), isDirectory: () => true, isFile: () => false }];
      }
      if (b.equals(pathFake)) return orig.call(fs, opts?.encoding === "buffer" ? Buffer.from(real) : real, opts);
      return orig.call(fs, q, opts);
    });
    const k = { snapshot: { repos: [], notLinked: [] }, projectPath: p, inst: () => null };
    const n = await newRepos(k, { statuses: new Map(), listen: { gitInside: new Set(), files: [] } });
    t.mock.restoreAll();
    assert.deepEqual(n.fresh, ["caf\udce9"], "the repo whose name is not UTF-8 is missing");
    assert.equal(nameBytes(path.join(p, n.fresh[0])).toString("hex"), Buffer.concat([Buffer.from(`${p}/`), FAKE]).toString("hex"));

    // The scripts themselves: the repo comes as bytes (stdin or hex), the run is in the project folder.
    fs.cpSync(real, path.join(p, "fresh"), { recursive: true });
    fs.writeFileSync(path.join(p, "fresh", "open.txt"), "open\n");
    const w = await perl(WIP, { args: ["top", "1700000000", "wip", "clone"], cwd: p, stdin: nulBytes(["fresh", "open.txt"]) });
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stdout.toString(), /^wip=[0-9a-f]{40}\nid=clone\ncount=1\n$/);
    const missing = await perl(WIP, { args: ["top", "1700000000", "wip", "clone"], cwd: p, stdin: nulBytes(["exists-not"]) });
    assert.notEqual(missing.code, 0, "a target WIP cannot change into was skipped");
    assert.match(missing.stderr, /chdir exists-not/);
    const bu = await perl(BUNDLE, { args: [p, nameBytes("fresh").toString("hex"), String(1 << 30)], cwd: d });
    assert.equal(bu.code, 0, bu.stderr);
    fs.writeFileSync(path.join(d, "n0.bundle"), bu.stdout);
    git(real, "bundle", "verify", "-q", path.join(d, "n0.bundle"));
    const found = await perl(REPO_EXISTS, { cwd: p, stdin: nulBytes(["missing", "fresh"]) });
    assert.equal(found.stdout.toString(), "n 0\0d 1\0");

    // Source guard: no path of a new repo as text at cwd (WIP) or argv (BUNDLE).
    const q = fs.readFileSync(path.join(import.meta.dirname, "../electron/server/stacks/fetch.js"), "utf8");
    assert.match(q, /k\.run\(inProject \? k\.projectPath : cwd, "perl", \["-e", WIP,[^\n]*stdin: nulBytes\(\[target, \.\.\.top\]\)/, "WIP does not run in the project folder with the target as bytes");
    assert.match(q, /\["perl", "-e", BUNDLE, k\.projectPath, nameBytes\(rel\)\.toString\("hex"\),/, "BUNDLE does not get the repo as hex");
    assert.doesNotMatch(q, /BUNDLE, k\.pathOf\(rel\)/);
    assert.doesNotMatch(q, /k\.run\(cwd, "perl", \["-e", WIP/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── (8)–(10) ────────────────────────────────────────────────────────────────────────────────────

test("(8) a repo in the copy's node_modules (`git init node_modules/lib` with a commit) is bundled", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const p = b.s.path;
    const lib = path.join(p, "node_modules", "lib");
    inCopy(b, p, "mkdir", "-p", "node_modules/lib");
    gitCopy(b, lib, "init", "-q", "-b", "main");
    writeInCopy(b, path.join(lib, "index.js"), "lib\n");
    gitCopy(b, lib, "add", "index.js");
    gitCopy(b, lib, "commit", "-q", "-m", "lib");
    const c = gitCopy(b, lib, "rev-parse", "HEAD");
    const e = await copyFetch(k.id, b.opts);
    const n = e.newRepos.find((x) => x.rel === "node_modules/lib");
    assert.ok(n?.bundle, `node_modules/lib missing in newRepos: ${JSON.stringify(e.newRepos)}`);
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bundle-"));
    try {
      execFileSync("git", ["clone", "-q", n.bundle, path.join(clone, "r")]);
      assert.equal(git(path.join(clone, "r"), "rev-parse", "HEAD"), c);
    } finally { fs.rmSync(clone, { recursive: true, force: true }); }
  });
});

test("(9) a commit that only the reflog still holds (`reset --hard HEAD~1`) afterwards sits at copy/k1/reflog-0", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    writeInCopy(b, path.join(app, "way.txt"), "gone\n");
    gitCopy(b, app, "add", "way.txt");
    gitCopy(b, app, "commit", "-q", "-m", "way");
    const way = gitCopy(b, app, "rev-parse", "HEAD");
    gitCopy(b, app, "reset", "-q", "--hard", "HEAD~1");
    const e = await copyFetch(k.id, b.opts);
    const r = e.repos.find((x) => x.rel === "app");
    assert.deepEqual(r.error, [], JSON.stringify(r));
    assert.equal(refs(app)["refs/heads/copy/k1/reflog-0"], way, `the commit is missing in main: ${JSON.stringify(refs(app))}`);
    // A second fetch fetches nothing new (onlyNew, same id).
    const e2 = await copyFetch(k.id, b.opts);
    assert.deepEqual(e2.repos.find((x) => x.rel === "app").fetched.filter((g) => g.source.startsWith("refs/cbase/reflog-")).map((g) => [g.target, g.fallback]), [["refs/heads/copy/k1/reflog-0", 0]]);
  });
});

test("(10) a bundled new repo whose .git afterwards is a gitfile appears exactly once in the second fetch", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    // INSIDE a repo of the snapshot (`app`): there COPY_STATE names it as `g` (gitfile) AND the upper layer as a written `.git`
    // (gitInside => REPO_EXISTS "g") — two ways to the same rel. Under the root alone there would be only one.
    const fresh = path.join(b.app, "fresh");
    inCopy(b, b.app, "mkdir", "fresh");
    gitCopy(b, fresh, "init", "-q", "-b", "main");
    writeInCopy(b, path.join(fresh, "x.txt"), "x\n");
    gitCopy(b, fresh, "add", "x.txt");
    gitCopy(b, fresh, "commit", "-q", "-m", "x");
    const e1 = await copyFetch(k.id, b.opts);
    assert.deepEqual(e1.newRepos.map((n) => [n.rel, Boolean(n.bundle)]), [["app/fresh", true]]);
    // A VALID gitfile (the folder moves next door) — with a missing gitdir git would not take `fresh` as a repo.
    inCopy(b, fresh, "mv", ".git", "../new.gitdir");
    writeInCopy(b, path.join(fresh, ".git"), "gitdir: ../new.gitdir\n");
    const e2 = await copyFetch(k.id, b.opts);
    assert.deepEqual(e2.newRepos.filter((n) => n.rel === "app/fresh").length, 1, `app/fresh not exactly once: ${JSON.stringify(e2.newRepos)}`);
  });
});

// ── (11) ──────────────────────────────────────────────────────────────────────────────────────────────

test("(11) two merges of the same project's project repo at the same time — both succeed, no index.lock error", async () => {
  const d = fs.mkdtempSync(path.join(TMPR, "cbase-together-"));
  const fd = await fakeDocker();
  const saved = Object.fromEntries(["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "GIT_TERMINAL_PROMPT"].map((n) => [n, process.env[n]]));
  try {
    Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
    delete process.env.GIT_TERMINAL_PROMPT;
    const p = path.join(d, "project"); fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, "note.md"), "one\n");
    assert.equal((await createProjectRepo(p)).created, true);
    // The fetched state of the copy: a branch copy/k1/main with a new file; in main an open change (the commit before the merge
    // takes the index.lock).
    git(p, "checkout", "-q", "-b", "copy/k1/main");
    fs.writeFileSync(path.join(p, "from-copy.md"), "k\n");
    git(p, "add", "from-copy.md"); git(p, "commit", "-q", "--no-verify", "-m", "copy");
    const oid = git(p, "rev-parse", "HEAD");
    git(p, "checkout", "-q", "main");
    fs.writeFileSync(path.join(p, "note.md"), "two\n");
    const results = [{ ok: true, source: `refs/heads/${BRANCH}`, target: "refs/heads/copy/k1/main", oid }];
    for (const c of ["cbase-p-pair-a", "cbase-p-pair-b"]) execFileSync(fd.bin, ["run", "-d", "--name", c, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
    const inst = (c) => ({ projectId: "pair", instance: "main", identifier: `pair/${c}`, containerId: c });
    // The git seam: A's first `add`/`rm` holds the index.lock (like a running git) and waits at a gate file; the gate opens as soon
    // as B's index-writing git ENDS (without the queue: B fails at the lock) — or when B waits in the queue.
    const lock = path.join(p, ".git", "index.lock"); const gate = path.join(d, "gate");
    let held = null; const atGate = new Promise((r) => { held = r; });
    let aHeld = false;
    const writes = (args) => args.includes("add") || args.includes("rm");
    setInProjectSeam({
      kind: (args, opts) => {
        if (args.includes("cbase-p-pair-a") && !aHeld && writes(args)) {
          aHeld = true;
          fs.writeFileSync(lock, "");
          const k2 = spawn("/bin/sh", ["-c", 'until [ -e "$T" ]; do sleep 0.02; done; rm -f "$L"; exec "$@"', "sh", dockerProgram(), ...args], { ...opts, env: { ...opts.env, T: gate, L: lock } });
          held();
          return k2;
        }
        const kind = dockerKind(args, opts);
        if (args.includes("cbase-p-pair-b") && writes(args)) kind.once("exit", () => fs.writeFileSync(gate, ""));
        return kind;
      },
      program: dockerProgram, processLocation: () => path.join(d, "processes"), container: (i) => i.containerId,
    });
    const k = { projectPath: p, name: "k1" };
    const a = mergeProjectRepo(k, { helperInst: inst("cbase-p-pair-a"), results });
    await atGate;
    const bRun = mergeProjectRepo(k, { helperInst: inst("cbase-p-pair-b"), results });
    if (waitingMerges(p) > 0) fs.writeFileSync(gate, ""); // B waits in the queue — A may go on
    const [ra, rb] = await Promise.allSettled([a, bRun]);
    assert.equal(ra.status, "fulfilled", String(ra.reason?.message || ""));
    assert.equal(rb.status, "fulfilled", `the second merge failed: ${String(rb.reason?.message || "").slice(0, 400)}`);
    assert.equal(ra.value.together?.merged, true, JSON.stringify(ra.value));
    assert.equal(rb.value.together?.already, true, JSON.stringify(rb.value));
    assert.equal(git(p, "show", "HEAD:from-copy.md"), "k");
  } finally {
    setInProjectSeam(null);
    for (const [n, v] of Object.entries(saved)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
    fd.cleanUp();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ── (12) ─────────────────────────────────────────────────────────────────────────────────

test("(12) the docker seam's output cap is never below the list's bytes cap — below it the list passes, above it COPY_CAP", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    // ≈ 1500 × 50 bytes ≈ 75 KB list of the upper layer — above the seam cap of 40,000 bytes that the test sets (every other
    // output of the fetch stays far below).
    inCopy(b, b.app, "/bin/sh", "-c", 'mkdir many && cd many && i=0; while [ $i -lt 1500 ]; do : > "a-file-with-a-long-name-to-pad-the-listing-$i.txt"; i=$((i+1)); done');
    const seam = { CBASE_DOCKER_OUTPUT_BYTES: "40000" };
    // Case C: the own cap (60,000) above the seam's => the list reports ITS cap, not "unreadable".
    await assert.rejects(
      withEnvironment({ ...seam, CBASE_COPY_LAYER_BYTES: "60000" }, () => copyFetch(k.id, b.opts)),
      (e) => e?.code === "COPY_CAP" && /mehr als 60000 Bytes Liste .*CBASE_COPY_LAYER_BYTES/.test(e.message),
    );
    assert.equal(store.stackCopy(k.id).state, "ready");
    // Case A: without an own knob (128 MiB) the list passes above the seam cap.
    const e = await withEnvironment(seam, () => copyFetch(k.id, b.opts));
    assert.ok(Array.isArray(e.repos));
    assert.equal(store.stackCopy(k.id).state, "ready");
  });
});

// ── (13) ─────────────────────────────────────────────────────────────────────────────────

test("(13) a copy's node_modules above the list cap => the fetch passes; above the search cap it names `depSearchIncomplete`", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    inCopy(b, b.app, "/bin/sh", "-c", 'mkdir -p node_modules/pkg && cd node_modules/pkg && i=0; while [ $i -lt 40 ]; do : > "d$i.js"; i=$((i+1)); done');
    // 41 entries in node_modules, list cap 30: the folder counts as ONE entry of the list.
    const e = await withEnvironment({ CBASE_COPY_LAYER_CAP: "30" }, () => copyFetch(k.id, b.opts));
    assert.ok(Array.isArray(e.repos));
    assert.equal(e.depSearchIncomplete, undefined, JSON.stringify(e.depSearchIncomplete));
    // The search's own cap (5): the fetch passes and says where the search stopped.
    const f = await withEnvironment({ CBASE_COPY_DEP_SEARCH_CAP: "5" }, () => copyFetch(k.id, b.opts));
    assert.deepEqual(f.depSearchIncomplete, ["app/node_modules"]);
    assert.equal(store.stackCopy(k.id).state, "ready");
  });
});

// ── (14) ───────────────────────────────────────────────────────

// The situation of situationDefault, plus a second commit in the project repo (`b.vorvor` = its parent — a state BELOW the start
// point) and an open file in the PROJECT ROOT of main — it goes into "State before copy k1".
async function situationRootOpen(b, ctx) {
  await situationDefault(b, ctx);
  b.vorvor = git(b.s.path, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(b.s.path, "second.md"), "two\n");
  git(b.s.path, "add", "second.md");
  git(b.s.path, "commit", "-q", "-m", "second");
  fs.writeFileSync(path.join(b.s.path, "open-main.md"), "open in main\n");
  b.before = git(b.s.path, "rev-parse", "HEAD");
}

// With a base the copy's project repo stands detached at the state BEFORE "State before copy" — for a base it does not know
// ("feature", `{ app: … }`) as well as for one it knows ("main"). What arises in its root cbase commits onto the detached HEAD;
// merging without conflict by itself applies to it just as for `main`.
// `afterwards`: "clearAway" — another file arrives through the clear-away; "foreign" — a tip that does not descend from the start
// point (the copy goes back to `b.vorvor`) is NOT merged, but stays on its ref and is reported.
for (const [fall, base, afterwards] of [["base \"feature\" (only app knows it)", "feature", "clearAway"], ["base { app: \"feature\" }", { app: "feature" }, "foreign"], ["base \"main\"", "main", null]]) {
  const what = afterwards === "clearAway" ? " and clear-away" : afterwards === "foreign" ? " (a tip below the start point is not)" : "";
  test(`(14) ${fall} — the copy's detached project repo is merged into main on fetch${what}, without main's open file`, async () => {
    await withCopy(situationRootOpen, async ({ b }) => {
      const k = await buildCopy(b, { base });
      const p = b.s.path;
      // Precondition: the commit "State before copy" carries the open file in main; the copy stands detached before it.
      assert.equal(git(p, "log", "-1", "--format=%s"), "State before copy k1");
      assert.equal(gitCopy(b, p, "rev-parse", "HEAD"), b.before, "precondition: the copy's project repo is at the state before");
      assert.throws(() => gitCopy(b, p, "symbolic-ref", "-q", "HEAD"), "precondition: the copy's HEAD is detached");

      writeInCopy(b, path.join(p, "note-copy.md"), "from the copy\n");
      const e1 = await copyFetch(k.id, b.opts);
      const pr = e1.projectRepo;
      assert.deepEqual(pr.error, [], JSON.stringify(pr.error));
      assert.ok(pr.copyCommit, JSON.stringify(pr));
      assert.deepEqual(pr.fetched.map((g) => g.target), ["refs/heads/copy/k1/detached"]);
      assert.equal(pr.together?.merged, true, `not merged: ${JSON.stringify(pr.together)}`);
      assert.equal(pr.together.target, "refs/heads/copy/k1/detached");
      assert.equal(git(p, "show", "HEAD:note-copy.md"), "from the copy", "note-copy.md is not in main's HEAD");
      // The open file of main is NOT in the copy's commit — it stays in main ("State before copy").
      assert.ok(!treeOf(p, pr.copyCommit).some((z) => z.endsWith(" open-main.md")), "open-main.md in the copy's commit");
      assert.equal(git(p, "show", "HEAD:open-main.md"), "open in main");
      assert.equal(git(p, "symbolic-ref", "HEAD"), "refs/heads/main", "main's HEAD stays on main");

      // A second fetch without news: already merged, main's HEAD unchanged.
      const header = git(p, "rev-parse", "HEAD");
      const e2 = await copyFetch(k.id, b.opts);
      assert.equal(e2.projectRepo.together?.already, true, JSON.stringify(e2.projectRepo.together));
      assert.equal(git(p, "rev-parse", "HEAD"), header);

      if (afterwards === "clearAway") {
        // The clear-away fetches by itself (clearAway.js, project-repo step): another file of the copy comes along.
        writeInCopy(b, path.join(p, "note-2.md"), "two\n");
        const output = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
        assert.equal(output.state, "removed", JSON.stringify(output.report).slice(0, 1500));
        assert.equal(output.report.projectRepo?.together?.merged, true, JSON.stringify(output.report.projectRepo));
        assert.equal(git(p, "show", "HEAD:note-2.md"), "two", "note-2.md did not reach main during the clear-away");
      }
      if (afterwards === "foreign") {
        // The copy goes back BELOW the start point and works there: cbase commits onto this tip, it does not descend from the
        // start point (returnPath.js `fromOf`) — not merged, main stays, the work sits on its ref.
        gitCopy(b, p, "checkout", "-q", "--detach", b.vorvor);
        writeInCopy(b, path.join(p, "aside.md"), "aside\n");
        const e3 = await copyFetch(k.id, b.opts);
        const z = e3.projectRepo.together;
        assert.deepEqual([z?.detached, z?.merged], [true, false], JSON.stringify(z));
        assert.match(z.notice, /does not descend from the start point/);
        assert.equal(git(p, "rev-parse", "HEAD"), header, "a tip below the start point was merged into main");
        assert.equal(git(p, "show", `${z.target}:aside.md`), "aside", "the copy's work is not on the reported ref");
        assert.equal(git(p, "rev-parse", `${z.target}^`), b.vorvor);
      }
    });
  });
}

test("(14) without a start point a detached tip is never merged — a notice instead of silence, no helper call", async () => {
  const k = { projectPath: path.join(TMPR, "exists-not"), name: "k1" };
  const detachedRef = { ok: true, source: DETACHED_SOURCE, target: "refs/heads/copy/k1/detached", oid: "a".repeat(40) };
  const r = await mergeProjectRepo(k, { helperInst: null, results: [detachedRef], start: null });
  assert.equal(r.mainCommit, null);
  assert.deepEqual([r.together.target, r.together.detached, r.together.merged], [detachedRef.target, true, false], JSON.stringify(r));
  assert.match(r.together.notice, /keinen Startpunkt/);
  // Neither main nor a detached tip fetched: nothing to merge.
  assert.deepEqual(await mergeProjectRepo(k, { helperInst: null, results: [{ ...detachedRef, ok: false }], start: "b".repeat(40) }), { mainCommit: null, together: null });
});
