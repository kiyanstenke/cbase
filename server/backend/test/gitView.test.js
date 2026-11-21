// Guards for the keystone of the git overview — gitView/overview.js (GET …/gitView), cache.js (the ONE reading per project,
// repo and instance), small.js (`branchesRunning`/`counter` in GET …/git) and repos.js (`repos` of the project lists) over the real
// routes of a real server (agent-harness.mjs), the fake docker (fake-docker.mjs, `exec` LOCAL) and real git. READINGS are counted, not
// docker calls: every reading calls the `for-each-ref` of the read script exactly once (read.js — the format with
// `%(upstream:track,nobracket)` appears nowhere else); the logging git wrapper from projectbox-git-scenario.mjs also writes WHERE it
// ran (`container` or `B`).
//
// What it proves, each with the sabotage that breaks it:
//   (1) Route: without the server-mode marker 404, not converted 409 NOT_CONVERTED, an unknown repo 404 UNKNOWN_REPO, a path with ".."
//       400. An instance that is not `ready` — main included — carries `read: false` with its reason and is NOT asked: no docker call,
//       no reading; the repos stand anyway (file system). Sabotage: the state check in overview.js readingsOfTheRepos struck => (1) red
//       (docker exec into the stopped container).
//   (2) Shape: response = RESPONSE_FIELDS, instance = INSTANCE_FIELDS, every row = ROW_FIELDS, `checkedOut` = CHECKED_OUT_FIELDS;
//       `user`/`state` filled (a subagent with a row without a core: `ended`, a branch of a living copy: `running`).
//   (3) Storage: the second request does not read; the running chats still come fresh (a turn appears and disappears without a
//       reading); `fresh=1` reads; after STORAGE_MS (clock seam) it reads; a state change of the instance row (`updated_at`) reads.
//       Sabotage: `fresh` skipped => (3) red; the marker without `updatedAt` => (3) red; withChats struck from gitView => (2)/(3) red.
//   (4) Search before the cap: more than ROWS_MAX rows => `clipped {shown, total}`, the search narrows in the server (without a new
//       reading) and clips only what is still too much after it.
//   (5) Copy: a copy delivers a row ONLY for new or moved things since its snapshot — unchanged only as an entry in `checkedOut` of
//       the main row; its key color stands at the instance; a stopped copy is not asked, a waiting one without an instance row is
//       `starts`.
//   (6) Small view WITH project container: `branchesRunning` (the checked-out branch with fresh `notBackedUp` and chats, a foreign
//       worktree with `chats: null`, the branch of a living copy) and `counter` per group — from ONE reading in the container that the
//       6 s tick does not repeat; a change of the checked-out branch reads anew (never behind the tree: until the new reading stands, the
//       fields are missing); a repo without a project (workspace level) and the local server (without the server-mode marker) carry NONE
//       of the fields. Sabotage: `valid` in small.js skipped => (6) red (after the switch main still stood as checked out). The FIRST
//       response does not carry the fields (the reading starts in the background, see (9)); the guard waits for it (readingsFinished) and
//       asks again. The clock of the storage stands still (clock seam): no entry expires, no successor starts while the guard counts.
//   (7) Small view WITHOUT project container: the same script in B; the end of a turn in the project discards the reading (hook
//       "git-view" at "beforeRunBroadcast", registered in server.js). Sabotage: the registerHook row in server.js struck => (7) red
//       (no new reading after the turn).
//   (9) GET …/git NEVER WAITS: a reading hanging at a gate (read seam) does not delay the answer — it comes WITHOUT the fields; a second
//       question starts no second reading; once it is done, the next answer carries the fields; from half the validity on the successor
//       starts (the answer keeps carrying the fields), an expired entry answers without; stage starts no reading, commit a new one. A
//       FAILED reading (result `read: false` or a throw) answers 200 without the fields. Sabotage: small.js with `await reading(…)`
//       instead of readingWithoutWait => (9) red ("waited for the reading", the watchdog fires after 5 s instead of a hang); `tree(b.repo)`
//       for stage => (9) red; `if (!l?.read) return null` struck in small.js => (9) red (empty fields instead of none).
//   (10) Generation per key: `fresh` begins a NEW reading even if one is running; an older one ending later does not overwrite the
//       younger; dismissReading lets the next call read anew. Sabotage: `fresh` shares the running one (old version) => (10) red; the
//       generation only per project => (10) red (the older one overwrote).
//   (8) `repos` in GET /api/projects and the workspace responses: a converted project at once (file system), another first `null`, then
//       the number (projectRepos in B in the background); without the server-mode marker no field. Sabotage: repoCount without the
//       background path => (8) red (null stayed).
// No time limit: waits for answers and events, never for a duration.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { DIRS } from "../electron/server/app-state.js";
import { running } from "../electron/server/runs/state.js";
import { containerName } from "../electron/server/projectbox/creation.js";
import { copyLocation } from "../electron/server/stacks/location.js";
import { SNAPSHOT_VERSION } from "../electron/server/stacks/code-snapshot.js";
import {
  RESPONSE_FIELDS, CHECKED_OUT_FIELDS, USER_FIELDS, COLORS, GIT_REPO_FIELDS, GROUPS, INSTANCE_FIELDS, ROWS_MAX, ROW_FIELDS,
} from "../electron/server/gitView/contract.js";
import {
  STORAGE_MS, reading, readingsFinished, setReadSeam, setStorageClock, forgetReadings, dismissReading, dismissProject,
} from "../electron/server/gitView/cache.js";
import { repoCountsFinished } from "../electron/server/gitView/repos.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { realGit, gitLocation, readLog, createRepo } from "./projectbox-git-scenario.mjs";

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd, o) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200", GIT_TERMINAL_PROMPT: undefined,
  CBASE_GIT_PROJECTS: path.join(o.location, "git-projects"),
  CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
});
const WITHOUT_OPS = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };
function containerStart(fd, o, name) {
  const env = { ...o.containerEnv, PATH: o.env.PATH };
  execFileSync(fd.bin, ["run", "-d", "--name", name, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
}
const allCalls = (fd) => fd.calls({ daemon: "host" }).length;
// The readings (the `for-each-ref` of the read script) per place: { container, B }.
function readings(o) {
  const output = { container: 0, B: 0 };
  for (const a of readLog(o.log)) if (a.argv?.some((x) => x.includes("%(upstream:track,nobracket)"))) output[a.where] = (output[a.where] || 0) + 1;
  return output;
}
async function response(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const view = (base, pid, q = {}) => response(`${base}/api/projects/${pid}/gitView${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ""}`);
const row = (a, name, instance = "main") => a.rows.find((z) => z.name === name && z.instance === instance) || null;
const full = (kind, fields) => ({ ...Object.fromEntries(USER_FIELDS.map((k) => [k, null])), kind, ...fields });
function refsOf(dir, env) {
  return realGit(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"], env)
    .trim().split("\n").filter(Boolean).map((z) => { const [name, oid] = z.split(" "); return { name, oid }; });
}
function writeSnapshot(pid, name, repos) {
  const location = copyLocation({ data: DIRS.data, projectId: pid, name });
  fs.mkdirSync(location.root.base, { recursive: true });
  fs.writeFileSync(location.root.snapshot, `${JSON.stringify({ version: SNAPSHOT_VERSION, projectId: pid, name, repos })}\n`, { mode: 0o600 });
}
function clearAwayCopies(pid) {
  for (const k of store.liveStackCopies(pid)) {
    try { store.deleteProjectInstance(pid, `copy-${k.name}`); } catch { /* no row */ }
    store.changeStackCopy(k.id, { state: "removed" });
  }
}

test("(1)–(5) large view: route, instances that are not ready, shape, storage, fresh chats, search before the cap, copy rows", async () => {
  forgetReadings();
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu7a-");
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat } = ctx;
      const P = path.join(ctx.root, "workspace", "gu7");
      const A = path.join(P, "app");
      const R = path.join(o.location, "remote.git");
      createRepo(A, o.env, { remote: R });
      const g = (...args) => realGit(A, args, o.env);
      g("checkout", "-q", "-b", "feature/login", "main");
      fs.writeFileSync(path.join(A, "b.txt"), "b\n");
      g("add", "b.txt"); g("commit", "-q", "-m", "login");
      g("push", "-q", "-u", "origin", "feature/login");
      g("checkout", "-q", "main");
      g("branch", "cbase/agent-sa-finished", "main");
      g("branch", "copy/k1/base", "main");
      const p = await ctx.projectWithoutInstance({ name: "Git overview", path: P });
      store.rememberSubagent(chat.id, { agentId: "sa-finished", name: "Old reviewer", state: "finished" });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

      // (1) Without the server-mode marker 404; in server mode, not converted, 409.
      await withEnvironment(WITHOUT_OPS, async () => {
        const r = await view(base, p.id);
        assert.equal(r.status, 404, JSON.stringify(r.body));
      });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        const nu = await view(base, p.id);
        assert.deepEqual([nu.status, nu.body.code], [409, "NOT_CONVERTED"], JSON.stringify(nu.body));

        const mainValue = `cbase-p-${p.id}`;
        containerStart(fd, o, mainValue);
        store.createProjectInstance({ projectId: p.id, state: "stopped", convertedAt: Date.now(), containerId: mainValue });
        try {
          // Main not ready: read false with a reason, NO docker call, NO reading — the repos stand anyway.
          for (const [state, reason] of [["stopped", "stopped"], ["error", "error"]]) {
            store.changeProjectInstance(p.id, "main", { state });
            const beforeD = allCalls(fd);
            const beforeL = readings(o);
            const r = await view(base, p.id);
            assert.equal(r.status, 200, JSON.stringify(r.body));
            assert.deepEqual(r.body.instances, [{ name: "main", color: null, read: false, reason, remoteState: null }]);
            assert.deepEqual([r.body.repo, r.body.repos], [{ rel: "app", name: "app" }, [{ rel: "app", name: "app" }]]);
            assert.deepEqual([r.body.rows, r.body.mainBranch, r.body.clipped], [[], null, null]);
            assert.equal(allCalls(fd), beforeD, `an instance that is not ready (${state}) was asked or woken`);
            assert.deepEqual(readings(o), beforeL);
          }
          const foreign = await view(base, p.id, { repo: "nonexistent" });
          assert.deepEqual([foreign.status, foreign.body.code], [404, "UNKNOWN_REPO"], JSON.stringify(foreign.body));
          const out = await view(base, p.id, { repo: "../x" });
          assert.deepEqual([out.status, out.body.code], [400, "REPO_INVALID"], JSON.stringify(out.body));
        } finally { store.changeProjectInstance(p.id, "main", { state: "ready" }); }

        // (2) Ready: one reading in the container, the shape of the contract, user and state.
        let before = readings(o);
        const r1 = await view(base, p.id);
        assert.equal(r1.status, 200, JSON.stringify(r1.body));
        assert.deepEqual(readings(o), { ...before, container: before.container + 1 }, "not exactly one reading in the container");
        assert.deepEqual(Object.keys(r1.body), [...RESPONSE_FIELDS]);
        assert.deepEqual(r1.body.instances.map((i) => Object.keys(i)), [[...INSTANCE_FIELDS]]);
        // Never fetched (no FETCH_HEAD): `unknown` — not `null` (that would mean "not read").
        assert.deepEqual(r1.body.instances[0], { name: "main", color: null, read: true, reason: null, remoteState: { at: null, source: "unknown" } });
        assert.equal(r1.body.mainBranch?.name, "main");
        for (const z of r1.body.rows) {
          assert.deepEqual(Object.keys(z), [...ROW_FIELDS], z.name);
          for (const e of z.checkedOut) assert.deepEqual(Object.keys(e), [...CHECKED_OUT_FIELDS], z.name);
        }
        const main = row(r1.body, "main");
        assert.equal(main?.group, "checkedOut");
        assert.deepEqual(main.checkedOut, [{ instance: "main", worktree: null, notBackedUp: 0, chats: [] }]);
        assert.deepEqual([row(r1.body, "feature/login")?.group, row(r1.body, "feature/login")?.remote], ["branches", "origin/feature/login"]);
        assert.deepEqual([row(r1.body, "cbase/agent-sa-finished")?.user, row(r1.body, "cbase/agent-sa-finished")?.state],
          [full("subagent", { name: "Old reviewer", chatId: chat.id, agentId: "sa-finished" }), "ended"]);
        assert.deepEqual([row(r1.body, "feature/login").user, row(r1.body, "feature/login").state], [null, null]);

        // (3) The storage: no second reading, no exec — but the chats fresh.
        before = readings(o);
        let beforeD = allCalls(fd);
        const r2 = await view(base, p.id);
        assert.deepEqual(r2.body, r1.body, "the second response differs");
        running.add(chat.id);
        try {
          const r3 = await view(base, p.id);
          assert.deepEqual(row(r3.body, "main").checkedOut[0].chats, [{ chatId: chat.id, title: store.getChat(chat.id).title }], "a turn does not appear at once");
        } finally { running.delete(chat.id); }
        const r4 = await view(base, p.id);
        assert.deepEqual(row(r4.body, "main").checkedOut[0].chats, [], "a turn does not disappear at once");
        assert.deepEqual([readings(o), allCalls(fd)], [before, beforeD], "the storage read anew");

        // fresh=1 reads; after STORAGE_MS it reads; a state change of the instance row reads.
        await view(base, p.id, { fresh: "1" });
        assert.equal(readings(o).container, before.container + 1, "fresh=1 did not read");
        const now = Date.now();
        setStorageClock(() => now + STORAGE_MS + 1);
        try {
          await view(base, p.id);
          assert.equal(readings(o).container, before.container + 2, "an expired entry did not read anew");
        } finally { setStorageClock(null); }
        await view(base, p.id);
        assert.equal(readings(o).container, before.container + 2, "the entry no longer counted");
        const time = store.projectInstance(p.id, "main").updatedAt;
        store.changeProjectInstance(p.id, "main", { state: "ready", now: time + 1 });
        await view(base, p.id);
        assert.equal(readings(o).container, before.container + 3, "a state change of the instance did not discard the entry");

        // (4) Search before the cap: ROWS_MAX + 5 more branches.
        const tip = g("rev-parse", "main").trim();
        const many = Array.from({ length: ROWS_MAX + 5 }, (_, i) => `many/b${String(i).padStart(3, "0")}`);
        execFileSync("git", ["update-ref", "--stdin"], { cwd: A, env: { ...process.env, ...o.env }, input: many.map((n) => `create refs/heads/${n} ${tip}\n`).join("") });
        const k1 = await view(base, p.id, { fresh: "1" });
        const total = r1.body.rows.length + many.length;
        assert.deepEqual([k1.body.rows.length, k1.body.clipped], [ROWS_MAX, { shown: ROWS_MAX, total }]);
        before = readings(o);
        const k2 = await view(base, p.id, { search: "MANY/B00" });
        assert.deepEqual(k2.body.rows.map((z) => z.name).sort(), many.slice(0, 10), "the search (case-insensitive) did not hit exactly");
        assert.equal(k2.body.clipped, null);
        const k3 = await view(base, p.id, { search: "many" });
        assert.deepEqual([k3.body.rows.length, k3.body.clipped], [ROWS_MAX, { shown: ROWS_MAX, total: many.length }]);
        assert.ok(k3.body.rows.every((z) => z.name.startsWith("many/")));
        assert.deepEqual(readings(o), before, "the search read anew (it runs on the stored reading)");
        execFileSync("git", ["update-ref", "--stdin"], { cwd: A, env: { ...process.env, ...o.env }, input: many.map((n) => `delete refs/heads/${n}\n`).join("") });

        // (5) Copy k1: snapshot = today's state => no row of its own, only its checked-out one on the main row.
        const copy = containerName(p.id, "copy-k1");
        store.createStackCopy({ projectId: p.id, name: "k1", state: "ready" });
        try {
          writeSnapshot(p.id, "k1", [{ part: "t1", rel: "app", projectRepo: false, refs: refsOf(A, o.env) }]);
          containerStart(fd, o, copy);
          store.createProjectInstance({ projectId: p.id, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: copy });
          before = readings(o);
          const c1 = await view(base, p.id, { fresh: "1" });
          assert.equal(readings(o).container, before.container + 2, "not one reading per ready instance");
          assert.deepEqual(c1.body.instances.map((i) => [i.name, i.read, i.reason]), [["main", true, null], ["k1", true, null]]);
          const color = c1.body.instances[1].color;
          assert.ok(Number.isInteger(color) && color >= 0 && color < COLORS, `key color ${color}`);
          assert.deepEqual(c1.body.rows.filter((z) => z.instance === "k1"), [], "an unchanged copy delivered rows of its own");
          assert.deepEqual(row(c1.body, "main").checkedOut.map((e) => e.instance), ["main", "k1"]);
          assert.deepEqual([row(c1.body, "copy/k1/base").user, row(c1.body, "copy/k1/base").state], [full("copy", { instance: "k1" }), "running"]);

          // Moved: a commit on feature/login => EXACTLY one copy row, directly under the main row, with `sinceCreation`.
          g("checkout", "-q", "feature/login");
          fs.writeFileSync(path.join(A, "c.txt"), "c\n");
          g("add", "c.txt"); g("commit", "-q", "-m", "further");
          g("checkout", "-q", "main");
          const c2 = await view(base, p.id, { fresh: "1" });
          const own = c2.body.rows.filter((z) => z.instance === "k1");
          assert.deepEqual(own.map((z) => [z.name, z.sinceCreation]), [["feature/login", { ahead: 1, back: 0 }]]);
          const i = c2.body.rows.findIndex((z) => z.name === "feature/login" && z.instance === "main");
          assert.equal(c2.body.rows[i + 1], own[0], "the copy row does not stand under the main row");

          // The copy stopped: not asked; a waiting copy without an instance row is "starts".
          store.changeProjectInstance(p.id, "copy-k1", { state: "stopped" });
          store.createStackCopy({ projectId: p.id, name: "k2" });
          beforeD = allCalls(fd);
          const c3 = await view(base, p.id);
          assert.deepEqual(c3.body.instances.map((x) => [x.name, x.read, x.reason]), [["main", true, null], ["k1", false, "stopped"], ["k2", false, "starts"]]);
          assert.deepEqual(c3.body.rows.filter((z) => z.instance !== "main"), []);
          assert.equal(allCalls(fd), beforeD, "a copy that is not ready was asked");
        } finally { clearAwayCopies(p.id); }
      });
    });
  } finally {
    setStorageClock(null);
    forgetReadings();
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(6) small view with project container: branchesRunning and counter from ONE reading, fresh chats and notBackedUp, never behind the tree", async () => {
  forgetReadings();
  const frozenNow = Date.now();
  setStorageClock(() => frozenNow);
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu7b-");
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws } = ctx;
      const K = path.join(ctx.root, "workspace", "till");
      const L = path.join(ctx.root, "workspace", "storage");
      const R = path.join(o.location, "remote.git");
      createRepo(K, o.env, { remote: R });
      createRepo(L, o.env);
      const g = (...args) => realGit(K, args, o.env);
      g("branch", "feature/x", "main");
      g("branch", "cbase/agent-sa-finished", "main");
      g("branch", "cbase/agent-niemand", "main");
      g("branch", "copy/k1/base", "main");
      const W = path.join(o.location, "wt-extern");
      g("worktree", "add", "-q", "-b", "extern/y", W, "main");
      const p = await ctx.projectWithoutInstance({ name: "Checkout", path: K });
      store.rememberSubagent(chat.id, { agentId: "sa-finished", name: "Old reviewer", state: "finished" });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
      store.createStackCopy({ projectId: p.id, name: "k1", state: "ready" });
      try {
        await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
          const main = `cbase-p-${p.id}`;
          containerStart(fd, o, main);
          store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: main });

          let before = readings(o);
          // The first response does not wait: without fields, the reading starts in the background (9).
          const b0 = await json(`${base}/api/projects/${p.id}/git`);
          assert.ok(GIT_REPO_FIELDS.every((f) => !Object.hasOwn(b0.repos[0], f)), `the first response carried fields: ${JSON.stringify(b0.repos[0]).slice(0, 300)}`);
          await readingsFinished();
          const b1 = await json(`${base}/api/projects/${p.id}/git`);
          assert.equal(b1.repos.length, 1, JSON.stringify(b1));
          const repo = b1.repos[0];
          assert.deepEqual(readings(o), { ...before, container: before.container + 1 }, "not exactly one reading in the container");
          for (const f of GIT_REPO_FIELDS) assert.ok(Object.hasOwn(repo, f), `GET …/git without "${f}"`);
          assert.deepEqual(Object.keys(repo.counter), [...GROUPS]);
          // main and extern/y checked out; feature/x; three under cbase/copy; no remote except the main branch.
          assert.deepEqual(repo.counter, { checkedOut: 2, branches: 1, cbase: 3, remote: 0 });
          const isRunning = Object.fromEntries(repo.branchesRunning.map((z) => [z.name, z]));
          assert.deepEqual(Object.keys(isRunning).sort(), ["copy/k1/base", "extern/y", "main"], "only checked-out and running cbase branches");
          for (const z of repo.branchesRunning) assert.deepEqual(Object.keys(z), [...ROW_FIELDS], z.name);
          assert.deepEqual(isRunning.main.checkedOut, [{ instance: "main", worktree: null, notBackedUp: repo.counts.total, chats: [] }]);
          assert.equal(repo.counts.total, 0);
          assert.equal(isRunning["extern/y"].checkedOut.length, 1);
          assert.equal(isRunning["extern/y"].checkedOut[0].chats, null, "a worktree carries no chats");
          assert.equal(fs.realpathSync(isRunning["extern/y"].checkedOut[0].worktree), fs.realpathSync(W));
          assert.deepEqual([isRunning["copy/k1/base"].state, isRunning["copy/k1/base"].user], ["running", full("copy", { instance: "k1" })]);

          // The tick does not read anew — notBackedUp and chats still come fresh.
          before = readings(o);
          fs.writeFileSync(path.join(K, "fresh.txt"), "n\n");
          running.add(chat.id);
          let b2;
          try { b2 = await json(`${base}/api/projects/${p.id}/git`); } finally { running.delete(chat.id); }
          const main2 = b2.repos[0].branchesRunning.find((z) => z.name === "main");
          assert.deepEqual(main2.checkedOut[0], { instance: "main", worktree: null, notBackedUp: 1, chats: [{ chatId: chat.id, title: store.getChat(chat.id).title }] });
          assert.deepEqual(readings(o), before, "the tick read anew");

          // A change of the checked-out branch: read anew, feature/x checked out, main no longer — until then NO fields (never the
          // reading from before, which would run behind the tree).
          g("checkout", "-q", "feature/x");
          const b3before = await json(`${base}/api/projects/${p.id}/git`);
          assert.ok(GIT_REPO_FIELDS.every((f) => !Object.hasOwn(b3before.repos[0], f)), "the old reading stood next to the new tree");
          await readingsFinished();
          const b3 = await json(`${base}/api/projects/${p.id}/git`);
          assert.equal(readings(o).container, before.container + 1, "the switch did not read anew");
          const names3 = b3.repos[0].branchesRunning.map((z) => z.name).sort();
          assert.deepEqual(names3, ["copy/k1/base", "extern/y", "feature/x"], "the small view ran behind the tree");
          assert.equal(b3.repos[0].branch, "feature/x");

          // Workspace level: the repo of the project carries the fields (from the same storage), a repo without a project none.
          before = readings(o);
          const w = await json(`${base}/api/workspaces/${ws.id}/git`);
          const till = w.repos.find((r) => r.relPath === "till");
          const lager = w.repos.find((r) => r.relPath === "storage");
          assert.deepEqual(till.counter, b3.repos[0].counter);
          assert.ok(lager && GIT_REPO_FIELDS.every((f) => !Object.hasOwn(lager, f)), `a repo without a project carried fields: ${JSON.stringify(lager)}`);
          assert.deepEqual(readings(o), before);
        });
        // The local server (without the server-mode marker): none of the fields.
        await withEnvironment({ ...o.env, ...WITHOUT_OPS }, async () => {
          const local = await json(`${base}/api/projects/${p.id}/git`);
          assert.ok(GIT_REPO_FIELDS.every((f) => !Object.hasOwn(local.repos[0], f)), JSON.stringify(local.repos[0]));
        });
      } finally { clearAwayCopies(p.id); }
    });
  } finally {
    await readingsFinished();
    setStorageClock(null);
    forgetReadings();
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(7)(8) small view in B, dismiss at turn end, `repos` of the project lists", async () => {
  forgetReadings();
  const frozenNow = Date.now();
  setStorageClock(() => frozenNow);
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu7c-");
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, ws } = ctx;
      const B = path.join(ctx.root, "workspace", "office");
      const U = path.join(ctx.root, "workspace", "converted");
      createRepo(B, o.env);
      createRepo(path.join(U, "one"), o.env);
      createRepo(path.join(U, "two"), o.env);
      const p = await ctx.projectWithoutInstance({ name: "Office", path: B });
      const q = await ctx.projectWithoutInstance({ name: "Converted", path: U });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });

      // (8) without the server-mode marker: no field.
      await withEnvironment(WITHOUT_OPS, async () => {
        const list = await json(`${base}/api/projects`);
        assert.ok(list.every((x) => !Object.hasOwn(x, "repos")), "`repos` stood without the server-mode marker");
      });
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        // (7) Without project container: the reading runs in B.
        let before = readings(o);
        await json(`${base}/api/projects/${p.id}/git`); // (9): without fields, the reading starts in the background
        await readingsFinished();
        const b1 = await json(`${base}/api/projects/${p.id}/git`);
        const r1 = b1.repos[0];
        assert.deepEqual(readings(o), { ...before, B: before.B + 1 }, "not exactly one reading in B");
        assert.deepEqual(r1.counter, { checkedOut: 1, branches: 0, cbase: 0, remote: 0 });
        assert.deepEqual(r1.branchesRunning.map((z) => [z.name, z.group, z.checkedOut]), [["main", "checkedOut", [{ instance: "main", worktree: null, notBackedUp: 0, chats: [] }]]]);
        await json(`${base}/api/projects/${p.id}/git`);
        assert.equal(readings(o).B, before.B + 1, "the tick read anew in B");

        // A turn in the project ends => the reading is discarded, the next tick reads.
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
        await ctx.waitForIdle();
        before = readings(o);
        await json(`${base}/api/projects/${p.id}/git`);
        await readingsFinished();
        assert.equal(readings(o).B, before.B + 1, "the turn end did not discard the reading (hook \"git-view\")");

        // (8) `repos`: q converted => 2 at once (file system, without git); p not => null, then 1.
        store.createProjectInstance({ projectId: q.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${q.id}` });
        try {
          const beforeD = allCalls(fd);
          const l1 = await json(`${base}/api/projects`);
          const byKey = (l) => Object.fromEntries(l.map((x) => [x.id, x.repos]));
          assert.equal(byKey(l1)[q.id], 2, JSON.stringify(l1.map((x) => [x.name, x.repos])));
          assert.equal(byKey(l1)[p.id], null, "a project not yet converted waited for git");
          assert.equal(allCalls(fd), beforeD, "the project list called docker");
          await repoCountsFinished();
          const l2 = await json(`${base}/api/projects`);
          assert.deepEqual([byKey(l2)[p.id], byKey(l2)[q.id]], [1, 2]);
          const w = await json(`${base}/api/workspaces/${ws.id}`);
          assert.deepEqual(Object.fromEntries(w.projects.map((x) => [x.id, x.repos])), { [p.id]: 1, [q.id]: 2 });
        } finally { store.deleteProjectInstance(q.id, "main"); }
      });
    });
  } finally {
    await readingsFinished();
    setStorageClock(null);
    forgetReadings();
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(9) GET …/git never waits: a hanging reading does not delay the response, one per key, successor, stage without, failure without fields", async () => {
  forgetReadings();
  const fd = await fakeDocker();
  const o = gitLocation("cbase-git-gu7d-");
  const T0 = Date.now();
  let now = T0;
  setStorageClock(() => now);
  try {
    await withAgentsServer(async (ctx) => {
      const { base } = ctx;
      const B = path.join(ctx.root, "workspace", "wait");
      createRepo(B, o.env);
      const p = await ctx.projectWithoutInstance({ name: "Wait", path: B });
      const git = () => json(`${base}/api/projects/${p.id}/git`);
      const withoutFields = (b, what) => assert.ok(GIT_REPO_FIELDS.every((f) => !Object.hasOwn(b.repos[0], f)), `${what}: ${JSON.stringify(b.repos[0]).slice(0, 300)}`);
      const withFields = (b, what) => assert.ok(GIT_REPO_FIELDS.every((f) => Object.hasOwn(b.repos[0], f)), `${what}: ${JSON.stringify(b.repos[0]).slice(0, 300)}`);
      await withEnvironment({ ...o.env, ...ops(fd, o) }, async () => {
        // The reading hangs at the gate until the guard opens it.
        let open; const gate = new Promise((r) => { open = r; });
        let begun; const nudged = new Promise((r) => { begun = r; });
        let called = 0;
        setReadSeam(async ({ read }) => { called += 1; begun(); await gate; return read(); });
        const before = readings(o);
        const promise = git();
        await nudged;
        // The watchdog turns ONLY the red case (the response waits for the reading) into a message instead of a hang.
        let watch;
        const hangs = new Promise((r) => { watch = setTimeout(() => r("hangs"), 5000); });
        const first = await Promise.race([promise, hangs]);
        clearTimeout(watch);
        if (first === "hangs") { open(); await promise; assert.fail("GET …/git waited for the reading"); }
        withoutFields(first, "the first response carried fields");
        withoutFields(await git(), "the second response (reading running) carried fields");
        assert.equal(called, 1, "a second question started a second reading");
        assert.deepEqual(readings(o), before, "the reading ran before the gate");
        open();
        await readingsFinished();
        const finished = await git();
        withFields(finished, "after the reading the fields were missing");
        assert.deepEqual(finished.repos[0].counter, { checkedOut: 1, branches: 0, cbase: 0, remote: 0 });
        assert.deepEqual([readings(o).B, called], [before.B + 1, 1]);

        // From half the validity on: the response keeps carrying the fields, the successor starts (one).
        now = T0 + STORAGE_MS / 2;
        withFields(await git(), "at half time the fields were missing");
        assert.equal(called, 2, "no successor at half time");
        withFields(await git(), "at half time (second question) the fields were missing");
        assert.equal(called, 2, "two successors");
        await readingsFinished();
        // Expired (older than STORAGE_MS): without fields, read anew.
        now = T0 + STORAGE_MS / 2 + STORAGE_MS;
        withoutFields(await git(), "an expired entry stood in the response");
        await readingsFinished();
        withFields(await git(), "after the expiry the fields were missing");
        assert.equal(called, 3);

        // stage moves no branch: no reading, the fields stay. commit moves one: new reading, the response without fields.
        fs.writeFileSync(path.join(B, "fresh.txt"), "n\n");
        const st = await json(`${base}/api/projects/${p.id}/git/stage`, { method: "POST", body: JSON.stringify({ repo: "", files: ["fresh.txt"] }) });
        withFields(st, "stage discarded the reading");
        assert.equal(called, 3, "stage began a reading");
        const cm = await json(`${base}/api/projects/${p.id}/git/commit`, { method: "POST", body: JSON.stringify({ repo: "", message: "fresh" }) });
        withoutFields(cm, "commit answered with the reading from before the commit");
        assert.equal(called, 4, "commit began no new reading");
        await readingsFinished();

        // A failed reading (result or throw): 200, WITHOUT the fields — never empty lists.
        for (const seam of [async () => ({ read: false, reason: "error", error: "intentional (guard)" }), async () => { throw new Error("intentional (guard)"); }]) {
          setReadSeam(seam);
          dismissProject(p.id);
          const a = await fetch(`${base}/api/projects/${p.id}/git`, { headers: { Connection: "close" } });
          assert.equal(a.status, 200);
          withoutFields(await a.json(), "during the failed reading");
          await readingsFinished();
          const b = await fetch(`${base}/api/projects/${p.id}/git`, { headers: { Connection: "close" } });
          assert.equal(b.status, 200);
          withoutFields(await b.json(), "a failed reading stood as fields in the response");
        }
      });
    });
  } finally {
    await readingsFinished();
    setStorageClock(null);
    forgetReadings();
    fd.cleanUp();
    fs.rmSync(o.location, { recursive: true, force: true });
  }
});

test("(10) generation per key: fresh begins anew, an older reading ending later does not overwrite a younger one, dismissReading", async () => {
  forgetReadings();
  const proj = { id: "gu-generation", path: "/exists-not" }; // without an instance: marker "B", no store
  const open = [];
  setReadSeam(() => new Promise((resolve) => { open.push(resolve); }));
  try {
    const a = reading(proj, "", null);
    const b = reading(proj, "", null);
    assert.equal(open.length, 1, "two simultaneous questions share the run");
    const c = reading(proj, "", null, { fresh: true });
    assert.equal(open.length, 2, "fresh attached itself to the running reading");
    const old = { read: true, seq: 1 };
    const fresh = { read: true, seq: 2 };
    open[1](fresh);
    assert.equal(await c, fresh);
    open[0](old);
    assert.equal(await a, old);
    assert.equal(await b, old);
    assert.equal(await reading(proj, "", null), fresh, "the older reading ending later overwrote the younger");
    assert.equal(open.length, 2, "the stored entry did not count");
    dismissReading(proj.id, "", "main");
    const d = reading(proj, "", null);
    assert.equal(open.length, 3, "dismissReading left the entry");
    open[2]({ read: true, seq: 3 });
    assert.equal((await d).seq, 3);
  } finally { forgetReadings(); }
});
