// Fetching and clearing away without loss, with real repos and the copy view of the fake docker (harness
// server/backend/test/stacks-copy-harness.mjs). "Lossless comes before complete".
//
//   (1) What hangs only in the copy comes into main — a stash without `pop` (`copy/k1/stash-0`), an annotated and a lightweight
//       tag on commits without a branch (`refs/tags/copy/k1/…`, the annotated one as a tag object), a note
//       (`refs/notes/copy/k1/commits`), the own commit of a detached worktree with a clean tree
//       (`copy/k1/detached-<wt-id>`); nothing unchanged, the number of stashes in the report.
//   (2) A repo INSIDE a new repo (registered as a gitlink — `check-ignore` in the outer repo used to end with "is in submodule")
//       and a repo under an ignored folder of a code repo each have a bundle after clearing away that clones to their commit;
//       the copy is `removed`.
//   (3) A REST fetch hits the bundle cap at the first of two new repos (both numbered, none bundled), the agent deletes the
//       second — clearing away ends `removed`, the second is `gone` in the report, the first is in the bundle.
//   (4) The project repo carries `filter=lfs`, the clean filter only runs at the commit in step 3 — afterwards the LFS object
//       (new AND changed file) is in main, the pointer is merged.
//   (5) A clear-away interrupted in step 1 whose stop chain stopped the copy container — the restart grace
//       (copiesRemoveRestartGrace) resumes it, the copy comes up again, `removed` with the commit in main, and the instance row
//       was NEVER `ready` (global stream). Plus the side path: the row is `start` after the start (earmarkRestore), the container is
//       stopped, a trigger comes before the restart grace => `removed`.
//   (6) A commit only the copy's reflog still holds (`reset --hard HEAD~1`) is in main under `copy/k1/reflog-0` after clearing
//       away; the copy is `removed`.
//
// COUNTER-TESTS (each shown red, then reverted):
//   fetch.js COPY_STATUS/stateFromOutput/jobsFor reduced to refs/heads, HEAD of the root       => (1) red (stash-0 missing)
//   fetch.js newRepos without `listen.gitInside`                                       => (2) red (error: the net in stepLayer,
//     "into the .git of app/vendor/lib, fresh/sub wrote the copy without a bundle"); also the net removed
//     (`if (false && unsecured.length)`, the whole old state)                           => (2) red (error: check-ignore
//     "Pathspec 'sub/s.txt' is in submodule 'sub'")
//   fetch.js saveNewRepos without the comparison of vanished repos                      => (3) red (bundle missing for bb)
//   fetch.js fetchProjectRepo without copyLfs                                           => (4) red (LFS object missing in main)
//   clearAway.js run without copyRunning                                                => (5) red (error: COPY_STANDS)
//   fetch.js jobsFor without the reflog jobs                                            => (6) red (reflog-0 missing)
//
// No clock: waits on states (waitForTruthy without deadline). macOS: TMPDIR real (the harness sets it).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { copyInstance } from "../electron/server/projectbox/creation.js";
import { setInstanceState, instancesRestartGrace } from "../electron/server/projectbox/instances.js";
import { clearAwayCopy } from "../electron/server/stacks/clearAway.js";
import { removeStatus, copiesRemoveCleanUp, copiesRemoveRestartGrace, setCopyClearerForTest } from "../electron/server/stacks/remove.js";
import { copyFetch } from "../electron/server/stacks/fetch.js";
import { setCopyState } from "../electron/server/stacks/state.js";
import { waitForTruthy } from "./agent-harness.mjs";
import { GLOBAL } from "./quiet.mjs";
import {
  buildCopy, dx, git, gitCopy, inCopy, situationDefault, withCopy, withEnvironment, nothingLeftOver, refs, writeInCopy,
} from "./stacks-copy-harness.mjs";

const sha256 = (t) => crypto.createHash("sha256").update(t).digest("hex");

/** Clone the bundle and run `check(clone)` — the clone lives in a throwaway folder. */
function cloneOf(bundle, check) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bundle-"));
  try {
    const r = path.join(d, "r");
    execFileSync("git", ["clone", "-q", bundle, r], { stdio: ["ignore", "ignore", "pipe"] });
    check(r);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

function commitInCopy(b, cwd, file, text, msg) {
  writeInCopy(b, path.join(cwd, file), text);
  gitCopy(b, cwd, "add", file);
  gitCopy(b, cwd, "commit", "-q", "-m", msg);
  return gitCopy(b, cwd, "rev-parse", "HEAD");
}

// The global stream (pattern of stacks-schema.test.js): every event, until `shutdown()`.
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
    } catch { /* abort on close */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

// ── (1) stash, tags, note, detached worktree ─────────────────────────────────────

test("(1) stash without pop, tags on commits without a branch (annotated, lightweight), note, detached worktree with a clean tree — all under copy/k1/… in main", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const p = b.s.path;
    const tagsPrior = git(app, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/notes");

    // (a) git stash — and the turn ends before the `pop`.
    writeInCopy(b, path.join(app, "a.txt"), "a.txt\nin the stash\n");
    gitCopy(b, app, "stash", "push", "-q", "-m", "half");
    const stash = gitCopy(b, app, "rev-parse", "refs/stash");
    // (b) Tags on commits that afterwards lie on no branch.
    gitCopy(b, app, "checkout", "-q", "--detach");
    const t1 = commitInCopy(b, app, "t1.txt", "t1\n", "t1");
    gitCopy(b, app, "tag", "-a", "v-copy", "-m", "annotated in the copy");
    const tagObject = gitCopy(b, app, "rev-parse", "refs/tags/v-copy");
    const t2 = commitInCopy(b, app, "t2.txt", "t2\n", "t2");
    gitCopy(b, app, "tag", "light");
    gitCopy(b, app, "checkout", "-q", "main");
    // (c) A note on a commit of main.
    gitCopy(b, app, "notes", "add", "-m", "note of the copy", b.start.main);
    // (d) A detached worktree with its own commit and a clean tree.
    const wtd = path.join(p, "wtd");
    gitCopy(b, app, "worktree", "add", "-q", "--detach", wtd);
    const w1 = commitInCopy(b, wtd, "w.txt", "w\n", "w1");
    assert.equal(gitCopy(b, wtd, "status", "--porcelain"), "", "precondition: the worktree is clean");
    assert.equal(gitCopy(b, app, "status", "--porcelain"), "", "precondition: the tree is clean (the work is in the stash)");

    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));

    assert.deepEqual(refs(app, "refs/heads/copy"), { "refs/heads/copy/k1/detached-wtd": w1, "refs/heads/copy/k1/stash-0": stash }, "stash or detached worktree missing in main (or something unchanged came along)");
    assert.equal(git(app, "show", `${stash}:a.txt`), "a.txt\nin the stash", "the stash commit carries the work");
    assert.equal(git(app, "cat-file", "-t", "refs/tags/copy/k1/v-copy"), "tag", "the annotated tag did not arrive as a tag object");
    assert.equal(git(app, "rev-parse", "refs/tags/copy/k1/v-copy"), tagObject);
    assert.equal(git(app, "rev-parse", "refs/tags/copy/k1/v-copy^{commit}"), t1);
    assert.equal(git(app, "rev-parse", "refs/tags/copy/k1/light"), t2);
    assert.equal(git(app, "notes", "--ref=copy/k1/commits", "show", b.start.main), "note of the copy");
    assert.deepEqual(git(app, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/notes").split("\n").filter((x) => !x.includes("/copy/k1/")).join("\n"), tagsPrior, "tags/notes of main changed");
    assert.equal(out.report.fetch.stashes, 1, JSON.stringify(out.report.fetch));
    nothingLeftOver(b, "(1)");
  });
});

// ── (2) repo inside a new repo, repo under an ignored folder ─────────────────────

const withVendorIgnored = (b, ctx) => situationDefault(b, ctx, {
  beforeCopy: (_b, app) => {
    fs.appendFileSync(path.join(app, ".gitignore"), "vendor/\n");
    git(app, "add", ".gitignore");
    git(app, "commit", "-q", "-m", "vendor ignored");
  },
});

test("(2) a repo in a new repo (as gitlink) and one under an ignored folder of a code repo — one bundle each, to the commit, removed", async () => {
  await withCopy(withVendorIgnored, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const p = b.s.path;
    const fresh = path.join(p, "fresh");
    const sub = path.join(fresh, "sub");
    inCopy(b, p, "mkdir", "-p", "fresh/sub");
    gitCopy(b, fresh, "init", "-q", "-b", "main");
    gitCopy(b, sub, "init", "-q", "-b", "main");
    const s1 = commitInCopy(b, sub, "s.txt", "s\n", "s1");
    writeInCopy(b, path.join(fresh, "n.txt"), "n\n");
    gitCopy(b, fresh, "add", "-A");
    gitCopy(b, fresh, "commit", "-q", "-m", "n1");
    const n1 = gitCopy(b, fresh, "rev-parse", "HEAD");
    assert.match(gitCopy(b, fresh, "ls-files", "-s", "sub"), /^160000 /, "precondition: sub is registered as a gitlink in fresh");
    const lib = path.join(app, "vendor", "lib");
    inCopy(b, app, "mkdir", "-p", "vendor/lib");
    gitCopy(b, lib, "init", "-q", "-b", "main");
    const l1 = commitInCopy(b, lib, "l.txt", "l\n", "l1");
    assert.equal(gitCopy(b, app, "check-ignore", "vendor/lib/l.txt"), "vendor/lib/l.txt", "precondition: vendor/ is ignored in app");

    const out = await clearAwayCopy(k.id, { reason: "test", automatic: true, ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    const seq = new Map(out.report.fetch.newRepos.map((n) => [n.rel, n]));
    for (const [rel, oid] of [["fresh", n1], ["fresh/sub", s1], ["app/vendor/lib", l1]]) {
      const b1 = seq.get(rel)?.bundle;
      assert.ok(b1 && fs.existsSync(b1), `${rel}: no bundle (${JSON.stringify(out.report.fetch.newRepos)})`);
      cloneOf(b1, (kl) => assert.equal(git(kl, "rev-parse", "HEAD"), oid, `${rel}: the bundle does not clone to the commit of the copy`));
    }
    nothingLeftOver(b, "(2)");
  });
});

// ── (3) bundle cap, vanished repo ────────────────────────────────────────────────

test("(3) REST fetch hits the bundle cap at the first new repo, the second is deleted — clearing away => removed, `gone` in the report", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const p = b.s.path;
    const ids = {};
    for (const n of ["aa", "bb"]) {
      inCopy(b, p, "mkdir", n);
      gitCopy(b, path.join(p, n), "init", "-q", "-b", "main");
      ids[n] = commitInCopy(b, path.join(p, n), "x.txt", `${n}\n`, n);
    }
    await assert.rejects(withEnvironment({ CBASE_COPY_BUNDLE_CAP: "1" }, () => copyFetch(k.id, b.opts)), (e) => e?.code === "COPY_CAP");
    assert.deepEqual(store.stackCopy(k.id).journal.data.fetch.fresh, { aa: 0, bb: 1 }, "precondition: both numbered");
    assert.equal(store.stackCopy(k.id).state, "ready", "precondition: the copy stays ready");
    inCopy(b, p, "rm", "-rf", "bb");

    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.deepEqual(out.report.fetch.newRepos.find((n) => n.rel === "bb"), { rel: "bb", without: "gone" });
    const aa = out.report.fetch.newRepos.find((n) => n.rel === "aa");
    assert.ok(aa?.bundle && fs.existsSync(aa.bundle), JSON.stringify(out.report.fetch.newRepos));
    cloneOf(aa.bundle, (kl) => assert.equal(git(kl, "rev-parse", "HEAD"), ids.aa));
    nothingLeftOver(b, "(3)");
  });
});

// ── (4) LFS filter ───────────────────────────────────────────────────────────────

const LFS_FILTER = `const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const { execFileSync } = require("child_process");
const data = fs.readFileSync(0);
const h = crypto.createHash("sha256").update(data).digest("hex");
const gd = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
const d = path.join(gd, "lfs", "objects", h.slice(0, 2), h.slice(2, 4));
fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(path.join(d, h))) fs.writeFileSync(path.join(d, h), data);
process.stdout.write("version https://git-lfs.github.com/spec/v1\\noid sha256:" + h + "\\nsize " + data.length + "\\n");
`;

const withPsd = (b, ctx) => situationDefault(b, ctx, {
  beforeCopy: (_b) => {
    // In main without the filter: the .psd is a full blob in the project repo (the project-repo creation commits it).
    fs.writeFileSync(path.join(b.s.path, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
    fs.writeFileSync(path.join(b.s.path, "old.psd"), "PSD old\n");
  },
});

test("(4) project repo with filter=lfs — the object that only the commit in step 3 creates is in main after clearing away", async () => {
  await withCopy(withPsd, async ({ ctx, b }) => {
    const k = await buildCopy(b);
    const p = b.s.path;
    const filter = path.join(ctx.root, `lfs-filter-${crypto.randomUUID()}.cjs`);
    fs.writeFileSync(filter, LFS_FILTER);
    // The filter only in the copy (git-lfs as with a user who set it up themselves).
    gitCopy(b, p, "config", "filter.lfs.clean", `"${process.execPath}" "${filter}"`);
    const newContent = "PSD new from the copy\n";
    const changed = "PSD old, changed in the copy\n";
    writeInCopy(b, path.join(p, "new.psd"), newContent);
    writeInCopy(b, path.join(p, "old.psd"), changed); // changed, not staged

    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    for (const [file, content] of [["new.psd", newContent], ["old.psd", changed]]) {
      const h = sha256(content);
      const object = path.join(p, ".git", "lfs", "objects", h.slice(0, 2), h.slice(2, 4), h);
      assert.equal(fs.existsSync(object) ? fs.readFileSync(object, "utf8") : null, content, `${file}: the LFS object is missing in main (only the pointer came)`);
      assert.match(git(p, "show", `HEAD:${file}`), new RegExp(`oid sha256:${h}`), `${file}: the pointer is not merged`);
    }
    nothingLeftOver(b, "(4)");
  });
});

// ── (5) interrupted clear-away ───────────────────────────────────────────────────

test("(5a) clear-away interrupted in step 1, copy container stopped — the restart grace resumes => removed, commit in main, instance row never `ready`", async () => {
  await withCopy(situationDefault, async ({ ctx, b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const pid = b.s.projectId;
    const inst = copyInstance("k1");
    const m1 = commitInCopy(b, app, "m1.txt", "m1\n", "m1");
    // A clear-away that the last server run began in step 1; the server end's stop chain stopped the copy.
    setCopyState(k.id, "clearAway", { phase: "fetch" });
    dx(b.fd, "stop", b.copy);
    assert.equal(JSON.parse(dx(b.fd, "inspect", b.copy))[0].State.Running, false, "precondition: the copy container is stopped");
    instancesRestartGrace();
    assert.equal(store.projectInstance(pid, inst)?.state, "clearAway", "the instances' restart grace touched the row");

    const reader = await globalReaderFor(ctx.base);
    setCopyClearerForTest((id, o) => clearAwayCopy(id, { ...o, ...b.opts }));
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init") || null, "init of the global stream");
      copiesRemoveCleanUp(); // a new process: nothing in the waker
      const after = copiesRemoveRestartGrace();
      assert.equal(after.jobs, 1);
      await after.finished;
      await waitForTruthy(() => {
        const z = store.stackCopy(k.id);
        return ["removed", "error"].includes(z.state) && removeStatus().running === 0 ? z : null;
      }, "copy k1 cleared away or error");
      const z = store.stackCopy(k.id);
      assert.equal(z.state, "removed", `${z.error}`);
      assert.equal(refs(app)["refs/heads/copy/k1/main"], m1, "the commit of the copy is missing in main");
      assert.match(String(z.result?.copyStarted || ""), /^[0-9a-f]{12}$/, "the report does not name the start");
      const until = await ctx.barrier(reader, GLOBAL);
      const rows = reader.events.slice(0, until).filter((e) => e.type === "project/instance" && e.projectId === pid && e.instance === inst);
      assert.ok(rows.length > 0, "no notice of the instance row seen");
      assert.deepEqual([...new Set(rows.map((e) => e.state))], ["clearAway"], `the instance row left clearAway: ${JSON.stringify(rows.map((e) => [e.state, e.phase]))}`);
      nothingLeftOver(b, "(5a)");
    } finally {
      setCopyClearerForTest(null);
      await reader.shutdown();
    }
  });
});

test("(5b) side path: the instance row is `start` after the start, the container is stopped, the trigger comes before the restart grace => removed", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const m1 = commitInCopy(b, app, "m1.txt", "m1\n", "m1");
    dx(b.fd, "stop", b.copy);
    // What earmarkRestore() does with this row before listening.
    setInstanceState(b.s.projectId, copyInstance("k1"), "start", { phase: "waiting" });
    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.equal(refs(app)["refs/heads/copy/k1/main"], m1);
    nothingLeftOver(b, "(5b)");
  });
});

// ── (6) commit held only by the reflog ───────────────────────────────────────────

test("(6) a commit only the copy's reflog holds is in main under copy/k1/reflog-0 after clearing away", async () => {
  await withCopy(situationDefault, async ({ b }) => {
    const k = await buildCopy(b);
    const app = b.app;
    const way = commitInCopy(b, app, "way.txt", "gone\n", "way");
    gitCopy(b, app, "reset", "-q", "--hard", "HEAD~1");
    const out = await clearAwayCopy(k.id, { reason: "test", ...b.opts });
    assert.equal(out.state, "removed", JSON.stringify(out.report).slice(0, 1500));
    assert.equal(refs(app)["refs/heads/copy/k1/reflog-0"], way, `the commit was lost: ${JSON.stringify(refs(app))}`);
  });
});
