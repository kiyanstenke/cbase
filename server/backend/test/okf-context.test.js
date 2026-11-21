// OKF knowledge cycle end to end against the real server: create with auto anchor, validator rejections, staleness detection
// after commits, verify, deprecate filter, slug traversal.
//
// Also the two `.git/config` tests for a converted project (the caller passes `instance` through; the routes do it with
// `instanceForProject(pid)`): the repo search of okf.js (findRepoRoot) reads `.git/config` only without a link (git.js
// isProjectRepo `safe`, anchor: the project folder). A FIFO there does not stop B (staleInfo in the child process ends, and
// the repo counts as a code repo because B read nothing from the FIFO), a link there is not read; verifyAnchors, staleInfo and
// staleInfoForList then ask git (in the project container) for that repo. Without an instance the call is the old one (the link
// counts, the repo is the project repo, no git). Verdict without a clock: the test opens the FIFO itself for writing and writes
// the marker as soon as a reader is there; a blocking reader (the bug) ends RED instead of hanging.
// COUNTER-TEST: okf.js before the repair => both tests red: staleInfo reports `stale: false` (B read the marker from the FIFO or
// behind the link), no git for `link`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { startServer } from "../electron/server/server.js";
import { groupPathsByRepo, staleInfo, staleInfoForList, verifyAnchors } from "../electron/server/okf.js";
import { setInProjectSeam } from "../electron/server/runtime/inProject.js";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);

async function json(url, init = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test("OKF-Context: Anker, Validator, Frische, Deprecate, Links", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-okf-"));
  let server;
  const previousBin = process.env.CLAUDE_BIN;
  try {
    // The workspace dumpster classifies via LLM (runOnce): fail immediately in the test so the fallback applies
    // instead of spawning a real (slow, costly) CLI.
    const bin = path.join(root, "fake-claude");
    fs.writeFileSync(bin, "#!/bin/sh\nexit 3\n");
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    // Project folder with a real git repo (staleness detection depends on commits).
    const wsPath = path.join(root, "workspace");
    const projPath = path.join(wsPath, "proj");
    fs.mkdirSync(path.join(projPath, "src", "auth"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: projPath, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(projPath, "src", "auth", "token.js"), "one");
    git("add", "-A");
    git("commit", "-qm", "one");

    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "OKF", path: wsPath }) })).body;
    const proj = (await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "proj", path: projPath }) })).body;
    const ctx = `${base}/api/projects/${proj.id}/context`;

    // 1) Create with codePaths: slug derived, anchor set automatically.
    const created = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Auth-Token-Refresh", body: "Runs through middleware.",
      codePaths: ["src/auth/"], owners: ["backend"], force: true,
    }) });
    assert.equal(created.status, 201);
    assert.equal(created.body.slug, "auth-token-refresh");
    assert.ok(created.body.lastVerified?.commits, "auto anchor missing");

    // 2) Validator: broken status, dead link, missing path: 400 with instructive problems.
    const bad = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Broken", body: "x", force: true,
      status: "banana", links: { related: ["exists-not"], nonsense: ["x"] }, codePaths: ["src/missing.js"],
    }) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.problems.length, 4);

    // 3) Freshly verified: not stale; a commit on the path: stale with a commit hint.
    let list = (await json(`${ctx}?meta=1`)).body;
    assert.equal(list.find((e) => e.slug === "auth-token-refresh").freshness.stale, false);
    fs.writeFileSync(path.join(projPath, "src", "auth", "token.js"), "two");
    git("commit", "-aqm", "auth: rework refresh");
    list = (await json(`${ctx}?meta=1`)).body;
    const entry = list.find((e) => e.slug === "auth-token-refresh");
    assert.equal(entry.freshness.stale, true);
    assert.equal(entry.body, undefined, "meta=1 must not return the full text");
    // The view list only COUNTS the commits: the list itself is unbounded and drove the metadata
    // response of a real project to 43 KB.
    assert.equal(entry.freshness.commits, undefined, "meta=1 must not return a commit list");
    assert.equal(entry.freshness.commitCount, 1);
    // Whoever loads the entry gets it in full.
    const full = (await json(`${ctx}/${entry.id}`)).body;
    assert.equal(full.freshness.commits[0].subject, "auth: rework refresh");

    // 4) Verify clears the commits.
    const verified = await json(`${ctx}/${entry.id}/verify`, { method: "POST" });
    assert.equal(verified.body.verified, true);
    assert.equal(verified.body.clearedCommits, 1);
    list = (await json(`${ctx}?meta=1`)).body;
    assert.equal(list.find((e) => e.slug === "auth-token-refresh").freshness.stale, false);

    // 5) Successor with link, deprecate the predecessor: the tools' default listing (status=active) hides it.
    const succ = await json(ctx, { method: "POST", body: JSON.stringify({
      category: "architecture", title: "Auth-Token-Refresh v2", body: "New.",
      links: { supersedes: ["auth-token-refresh"] }, force: true,
    }) });
    assert.equal(succ.status, 201);
    const dep = await json(`${ctx}/${entry.id}`, { method: "PUT", body: JSON.stringify({ status: "deprecated", supersededBy: succ.body.slug }) });
    assert.equal(dep.body.status, "deprecated");
    const active = (await json(`${ctx}?meta=1&status=active`)).body.filter((e) => e.origin === "project");
    assert.deepEqual(active.map((e) => e.slug), ["auth-token-refresh-v2"]);

    // 6) Slug lookup with resolved links (traversal).
    const bySlug = (await json(`${ctx}/by-slug/auth-token-refresh-v2`)).body;
    assert.equal(bySlug.linksResolved.supersedes[0].status, "deprecated");
    assert.equal(bySlug.linksResolved.supersedes[0].title, "Auth-Token-Refresh");

    // 7) Workspace light: deprecate without a git anchor, a broken status is rejected.
    const wctx = `${base}/api/workspaces/${ws.id}/context`;
    const witem = (await json(wctx, { method: "POST", body: JSON.stringify({ text: "Note: never deploy on Fridays.", route: "workspace" }) })).body.item;
    assert.ok(witem.slug);
    const wbad = await json(`${wctx}/${witem.id}`, { method: "PUT", body: JSON.stringify({ status: "broken" }) });
    assert.equal(wbad.status, 400);
    const wdep = await json(`${wctx}/${witem.id}`, { method: "PUT", body: JSON.stringify({ status: "deprecated" }) });
    assert.equal(wdep.body.status, "deprecated");
    const wactive = (await json(`${wctx}?status=active`)).body;
    assert.ok(!wactive.some((e) => e.id === witem.id));
  } finally {
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (server) await new Promise((r) => server.close(r));
    // A test must not fail because its temp directory does not go away: a child process still writing
    // causes ENOTEMPTY, which says something about the cleanup, not the product. It is not kept silent
    // either, otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); the test is unaffected.`); }
  }
});

// ── `.git/config` of a converted project, only without a link ───────────────────────────────────────────────────────────
const MARKER_PROJECT_REPO = "[cbase]\n\tprojectrepo = true\n";
const INST_N2 = { projectId: "p9", instance: "main", identifier: "p9/main", containerId: "cbase-p-p9" };
const VERIFIED = { commits: { fifo: "abc1234", link: "abc1234" }, at: 1 };

// A FIFO without a writer, read in a CHILD PROCESS (`script`, ESM), same build as projectbox-git.test.js: the test first opens the
// FIFO itself for writing (that waits in the thread pool for a reader) and writes `content` as soon as that succeeds; a blocking
// reader (the bug) thereby gets the content and ends with it, a reader with O_NONBLOCK that accepts only regular files never
// reads from it. After the child ends, a reader of our own (O_NONBLOCK) releases a writer that is still waiting.
async function fifoInChild(fifo, content, script, env) {
  const writer = fs.promises.open(fifo, "w").then(async (fh) => {
    try { await fh.write(content); } catch { /* the reader is already gone (EPIPE) */ } finally { await fh.close(); }
  });
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const r = await new Promise((resolve) => {
    let out = "", err = "";
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    subprocess.on("close", (code, signal) => resolve({ out, err, code, signal }));
  });
  const fd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try { await writer; } finally { fs.closeSync(fd); }
  return r;
}

test("okf: a FIFO at .git/config of a converted project does not stop B; staleInfo ends, the repo counts as a code repo", async () => {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-okf-fifo-")));
  try {
    const proj = path.join(location, "till");
    fs.mkdirSync(path.join(proj, "fifo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(proj, "fifo", "a.txt"), "a\n");
    execFileSync("mkfifo", [path.join(proj, "fifo", ".git", "config")]);
    // Without the seam git in the container fails at once (inProject throws), which for staleInfo means "have it checked" (rebased).
    const script = `const { staleInfo } = await import(process.env.OKF_JS);
      const s = await staleInfo(process.env.PROJ, { codePaths: ["fifo/a.txt"], lastVerified: JSON.parse(process.env.LV) }, { instance: JSON.parse(process.env.INST) });
      process.stdout.write(JSON.stringify(s));`;
    const r = await fifoInChild(path.join(proj, "fifo", ".git", "config"), MARKER_PROJECT_REPO, script, {
      OKF_JS: path.resolve(TESTDIR, "..", "electron", "server", "okf.js"), PROJ: proj, INST: JSON.stringify(INST_N2), LV: JSON.stringify(VERIFIED),
    });
    assert.equal(r.code, 0, `child: ${r.signal || r.code} ${r.err}`);
    assert.deepEqual(JSON.parse(r.out), { stale: true, verifiedAt: 1, rebased: true }, `B read .git/config from the FIFO (the marker arrived, no git): ${r.out}`);
  } finally {
    fs.rmSync(location, { recursive: true, force: true });
  }
});

test("okf: a link at .git/config of a converted project is not read; verifyAnchors, staleInfo, staleInfoForList ask git; without an instance as before", async () => {
  const location = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-okf-reference-")));
  // The seam records every git start in the project container (working folder from `-w`) and then fails (no docker in the test).
  const starts = [];
  setInProjectSeam({
    kind: (args) => { starts.push(args[args.indexOf("-w") + 1]); throw new Error("no docker in the test"); },
    program: () => "docker", processLocation: () => path.join(location, "processes"), container: (i) => i.containerId,
  });
  try {
    const proj = path.join(location, "till");
    const link = path.join(proj, "link");
    const outside = path.join(location, "b-file");
    fs.writeFileSync(outside, MARKER_PROJECT_REPO);
    fs.mkdirSync(path.join(link, ".git"), { recursive: true });
    fs.writeFileSync(path.join(link, "a.txt"), "a\n");
    fs.symlinkSync(outside, path.join(link, ".git", "config"));
    const entry = { id: "e1", codePaths: ["link/a.txt"], lastVerified: VERIFIED };
    const including = { instance: INST_N2 };

    // The search itself: with `safe` `link` is a code repo (its marker does not count), without it as before (project repo).
    assert.deepEqual([...groupPathsByRepo(proj, ["link/a.txt"], { safe: true }).groups.keys()], ["link"]);
    assert.deepEqual([...groupPathsByRepo(proj, ["link/a.txt"]).groups.keys()], [], "groupPathsByRepo without `safe` changed");

    // With an instance: each of the three asks git for `link` (in the container); B did not follow the link.
    const a = await verifyAnchors(proj, ["link/a.txt"], including);
    assert.deepEqual(a.commits, {}, JSON.stringify(a));
    assert.deepEqual(starts, [link], "verifyAnchors does not pass the instance on as `safe` (B read the marker behind the link)");
    assert.deepEqual(await staleInfo(proj, entry, including), { stale: true, verifiedAt: 1, rebased: true }, "staleInfo followed the link");
    const list = await staleInfoForList(proj, [entry], including);
    assert.deepEqual(list.get("e1"), { stale: true, verifiedAt: 1, rebased: true }, "staleInfoForList followed the link");
    assert.deepEqual(starts, [link, link, link]);

    // Without an instance the call as before: the link counts, `link` is the project repo, so no repo, no git.
    starts.length = 0;
    assert.deepEqual((await verifyAnchors(proj, ["link/a.txt"])).commits, {});
    assert.deepEqual(await staleInfo(proj, entry), { stale: false, verifiedAt: 1 });
    assert.deepEqual((await staleInfoForList(proj, [entry])).get("e1"), { stale: false, verifiedAt: 1 });
    assert.deepEqual(starts, [], "without an instance a git start in the container");
  } finally {
    setInProjectSeam(null);
    fs.rmSync(location, { recursive: true, force: true });
  }
});
