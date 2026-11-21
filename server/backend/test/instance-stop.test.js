// Guard for stopping and starting an instance (projectbox/instance-stop.js), through the real routes of a real server
// (agent-harness.mjs), the fake docker (fake-docker.mjs, its `exec` runs LOCAL) and the project-container scenario
// (projectbox-scenario.mjs: network marker, inside, hosts file), with the project-container observer (projectbox/resumption.js) on.
//
// Each promise, with the way that breaks it:
//   (1) Stop: a running turn of a chat of the instance => 409 INSTANCE_WORKING, nothing on the wire. Without it 202 with the row in
//       `stop`, then `stopped` with `docker stop -t 30 <id>` on the wire, the desired state freshly read (db and app `running`), the
//       container stands; `/api/runs/active` counts `projectStopped` 1 and is quiet. STOPPED STAYS STOPPED: the `die` of the stop
//       triggers no restart, and even AFTER the "cbase stops itself" marker is forgotten (its deadline runs out in operation) the
//       reconcile of a new stream starts nothing — the state alone holds; the post-start (earmarkRestore) leaves the row alone, and
//       a restore without an explicit start is rejected with STOPPED (the git waker). If someone starts the container behind cbase's
//       back, the next reconcile stops it again (verdict "stopped-running").
//       Start (gate open) => 202 `kind: "start"`, exactly ONE `docker start` of the container, the inner ones with desired state
//       `running` come up, the row is `ready`; a second start is 409 INSTANCE_NOT_STOPPED.
//       The work lock of stopping applies to the instance of the chat: a turn in copy-k1 turns the stop of copy-k1 into 409
//       INSTANCE_WORKING (nothing on the wire), the stop of main goes through beside it.
//       The REAL git view (GET /api/projects/:pid/git -> readGitTree -> gitSituation) only reads a stopped instance — no `docker
//       start`, no phase, no row under "git-view:<pid>", and it names the "Instances" tab.
//   (2) The storage gate: gate closed => 202 `kind: "waiting"` with a reason, the row stays `stopped` (phase `waiting_storage`), no
//       `docker start`; a second start keeps waiting (new: false); abort takes the phase back (a second abort is 409
//       NO_WAITING_START). Waiting again, the gate opens, the storage queue (source "instance-start") brings the instance up =>
//       `ready`.
//   (3) A turn in a stopped instance starts it, writes the separator "main started." (role `hint`) into its chat and runs as soon
//       as it is `ready` — in the project container.
//   (4) Preview links: the rewrite proxy answers 502 with the text from `stoppedTextOf` while the instance is stopped — for requests
//       AND upgrades, without asking the service; while it runs, everything goes through as before.
//   (5) A stop interrupted by a restart of B (`stop` without a living procedure) ends `stopped` in the post-start — never `error`;
//       with a living procedure the row stays. `stop` holds `busy`, `stopped` does not (field `projectStopped`).
//   (6) If an occupation rejects the start at the lock, the sentence says so (instead of "is started for this run"), and the end of
//       the occupation makes up the start — the turn runs, exactly ONE `docker start`.
//
// No clock: the tests wait on states, observer verdicts, its quiet and the end of the runs (waitForTruthy without a deadline).
// Without an account (withoutAccount from setup-harness.mjs) in (3) and (6), the tests with a turn: a turn parked at the lock
// checks the limit on waking — otherwise the server on a Mac would read the keychain and ask the usage endpoint of the REAL account.
//
// COUNTER-TESTS (one sabotage each, on the real tree):
//   instance-stop.js: stopProcedure ends in `ready` instead of `stopped`                  => (1), (2), (3) red
//   restore.js: the STOPPED rejection struck (`if (false)`)                               => (1) red (the restore without a start runs)
//   resumption.js: `await keepTrackOfStopped(z, c)` struck from the reconcile             => (1) red (the one started behind cbase's back keeps running)
//   idle.js: `if (inst.state === "stopped") return stoppedVerdict(…)` removed             => (3) red (the turn starts nothing, no separator)
//   rewrite-proxy.js: `stoppedText()` before the request replaced by null                  => (4) red (the service is asked, no 502 text)
//   instances.js: the loop over `stop` in the post-start runs over [] instead of the rows => (5) red (the interrupted stop stays work)
//   devtools/code-route.js: gitSituation asks with the purpose "turn" again instead of "view" => (1) red (the git view started main)
//   instance-stop.js: checkAction with `instanceWork(inst.projectId)` without the name    => (1) red (the copy stopped beside the turn)
//   server.js: `setOccupancyEnd(…)` struck                                                => (6) red (the turn stayed in the queue)
//   idle.js: the branch `nudge?.ok === false` in stoppedVerdict struck                   => (6) red ("is started for this run")
// NOT red on its own: the reconcile takes `stopped` rows as `ready` into its list — the state is checked TWICE, in upfrontNo (row
// of NOW) and in restoreInstance (STOPPED, counter-tested above) — the second layer holds. That is intended.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { pendingRunInputs, persistRunInputs, running } from "../electron/server/runs/state.js";
import { withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { projectLock } from "../electron/server/projectbox/idle.js";
import { procedureAlive, instancesRestartGrace, setInstanceState, withProcedure } from "../electron/server/projectbox/instances.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { restoreInstance, advanceStagesCap, earmarkRestore } from "../electron/server/projectbox/restore.js";
import { forgetSelfStopped } from "../electron/server/projectbox/docker.js";
import { advanceRestart, resumptionRestartGrace, resumptionQuiet, resumptionStatus, stopResumption } from "../electron/server/projectbox/resumption.js";
import { startSeparatorText } from "../electron/server/projectbox/instance-stop.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";
import { stoppedTextOf } from "../electron/server/preview/links.js";
import { startRewriteProxy } from "../electron/server/preview/rewrite-proxy.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withoutAccount } from "./setup-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

// ── environment (shape of projectbox-resumption.test.js withOps) ──────────────────────────────────────────────────────────
async function inOps(fd, s, fn, values = {}) {
  const desired = { CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s?.root, CBASE_PROJECT_DESIRED_MS: "0", CBASE_RECREATE_CHECK_BACK_MS: "100", ...values };
  const saved = Object.fromEntries(Object.keys(desired).map((x) => [x, process.env[x]]));
  try {
    for (const [x, v] of Object.entries(desired)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
    return await withOps(fd, async () => {
      try { return await fn(); } finally {
        stopResumption("test end");
        await carryOut();
        await resumptionQuiet();
      }
    }, values);
  } finally {
    for (const [x, v] of Object.entries(saved)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
  }
}
async function carryOut() {
  while (store.projectInstances().some((z) => procedureAlive(z.projectId, z.instance))) {
    advanceStagesCap();
    await new Promise((r) => setTimeout(r, 10));
  }
}
function cleanUpRows() {
  for (const z of store.projectInstancesInState([...store.PROJECT_WORK_STATES, "stopped"])) {
    try { setInstanceState(z.projectId, z.instance, "ready", { phase: "" }); } catch (e) { console.warn(`[instance-stop] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const hostStarts = (fd, mark = 0) => fd.calls().slice(mark).filter((a) => a.daemon === "host" && a.args[0] === "start").map((a) => a.args);
const hostStops = (fd, mark = 0) => fd.calls().slice(mark).filter((a) => a.daemon === "host" && a.args[0] === "stop").map((a) => a.args);
const status = (fd, name) => JSON.parse(dx(fd, "inspect", name))[0].State.Status;
const verdictsOf = (name) => resumptionStatus().verdicts.filter((u) => u.name === name);
const states = (desired) => Object.fromEntries((desired?.container || []).map((c) => [c.name, c.state]));
const row = (pid) => store.projectInstance(pid, "main");

const STACK = [{ name: "a-db-1", service: "db" }, { name: "a-app-1", service: "app", dependsOn: "db" }];

// A converted project whose project container RUNS, with its inner stack; the row `ready` after the container.
function projectRunning(fd, s) {
  const name = `cbase-p-${s.projectId}`;
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "--label", "cbase.instance=haupt", "cbase-projectbox:latest");
  for (const c of STACK) {
    const args = ["exec", name, "docker", "run", "-d", "--name", c.name, "--label", "com.docker.compose.project=a", "--label", `com.docker.compose.service=${c.service}`];
    if (c.dependsOn) args.push("--label", `com.docker.compose.depends_on=${c.dependsOn}`);
    dx(fd, ...args, "img");
  }
  const ids = dx(fd, "exec", name, "docker", "ps", "-aq", "--no-trunc").split("\n").filter(Boolean);
  const desired = desiredFromInspect(JSON.parse(dx(fd, "exec", name, "docker", "inspect", ...ids)));
  store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired });
  return { name, cid };
}

async function observerOn(fd) {
  assert.equal(resumptionRestartGrace(), undefined);
  await waitForTruthy(() => fd.streams().length === 1, "stream running");
  await resumptionQuiet();
}
async function streamNew(fd) {
  assert.equal(fd.endStreams(), 1);
  await waitForTruthy(() => resumptionStatus().restartScheduled || null, "restart scheduled");
  advanceRestart();
  await waitForTruthy(() => fd.streams().length === 1, "new stream");
  await resumptionQuiet();
}

async function raw(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const post = (url, body = {}) => raw(url, { method: "POST", body: JSON.stringify(body) });
const notStop = (pid) => (row(pid)?.state !== "stop" ? true : null);
const notStart = (pid) => (!["start", "stop"].includes(row(pid)?.state) && !procedureAlive(pid, "main") ? true : null);

// ── (1) stop, stopped stays stopped, start ────────────────────────────────────────────────────────────────────────────────
test("(1) stop: work lock, then stop → stopped with `stop -t 30 <id>`; stopped stays stopped (event, reconcile without marker, restart grace, git waker), one start behind cbase's back is stopped again; start ⇒ ready", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: randomUUID() });
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    let turnChat = null;
    let kChat = null;
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const { name, cid } = projectRunning(fd, s);
        const pid = s.projectId;
        const url = (action) => `${ctx.base}/api/projects/${pid}/instances/main/${action}`;
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start") || null, "the start of the seeding reached the observer");

        // Work lock: a running turn of a chat of the instance => 409, nothing on the wire.
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
        turnChat = ctx.chat.id;
        running.add(turnChat);
        try {
          const prior = fd.calls().length;
          const r = await post(url("stop"));
          assert.deepEqual([r.status, r.body.code], [409, "INSTANCE_WORKING"], JSON.stringify(r.body));
          assert.deepEqual(fd.calls().slice(prior), [], "a docker call ran under the lock");
          assert.equal(row(pid).state, "ready");
        } finally { running.delete(turnChat); turnChat = null; }

        // The same lock in a COPY — a turn of a chat in copy-k1 holds copy-k1 (409 with this chat, nothing on the wire), but not
        // main: the stop below goes through beside it. The copy rows exist only for this check (no container — the lock judges
        // before any question to it); the chat keeps its binding to copy-k1.
        const copy = store.createStackCopy({ projectId: pid, name: "k1", chatId: ctx.chat.id, state: "ready" });
        store.createProjectInstance({ projectId: pid, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: "" });
        const t = Date.now();
        kChat = store.createChat({ id: randomUUID(), workspaceId: ctx.ws.id, projectId: pid, createdAt: t, updatedAt: t }).id;
        await json(`${ctx.base}/api/chats/${kChat}`, { method: "PATCH", body: JSON.stringify({ instance: "copy-k1" }) });
        running.add(kChat);
        const beforeK = fd.calls().length;
        const rk = await post(`${ctx.base}/api/projects/${pid}/instances/copy-k1/stop`);
        assert.deepEqual([rk.status, rk.body.code], [409, "INSTANCE_WORKING"], JSON.stringify(rk.body));
        assert.deepEqual(rk.body.chats.map((c) => c.id), [kChat]);
        assert.deepEqual(fd.calls().slice(beforeK), [], "a docker call ran under the lock of the copy");
        assert.equal(store.projectInstance(pid, "copy-k1").state, "ready");
        store.deleteProjectInstance(pid, "copy-k1");
        store.changeStackCopy(copy.id, { state: "removed" });

        // An unknown field => 400 (a missing field is no instruction — and a foreign one no permission).
        assert.equal((await post(url("stop"), { immediately: true })).status, 400);

        // Stop.
        const mark = fd.calls().length;
        const n0 = verdictsOf(name).filter((u) => u.action === "die").length;
        const r = await post(url("stop"));
        assert.equal(r.status, 202, `main beside the turn in copy-k1: ${JSON.stringify(r.body)}`);
        running.delete(kChat); kChat = null;
        assert.equal(r.body.instance.state, "stop", "the answer does not name the row as `stop`");
        await waitForTruthy(() => notStop(pid), "the stop is through");
        const z = row(pid);
        assert.equal(z.state, "stopped", JSON.stringify(z));
        assert.equal(z.containerId, cid);
        assert.deepEqual(hostStops(fd, mark), [["stop", "-t", "30", cid]], "the stop on the wire");
        assert.equal(status(fd, name), "exited");
        assert.deepEqual(states(z.desired), { "a-db-1": "running", "a-app-1": "running" }, "the desired state from before the stop");
        const active = await json(`${ctx.base}/api/runs/active`);
        assert.equal(active.projectStopped, 1, JSON.stringify(active));
        assert.deepEqual(active.projectWork, [], "stopped is no work");
        assert.equal(active.busy, false);

        // The `die` of the stop: no restart.
        await waitForTruthy(() => verdictsOf(name).filter((u) => u.action === "die").length > n0 || null, "the die of the stop reached the observer");
        await resumptionQuiet();
        assert.deepEqual(hostStarts(fd, mark), [], "the die of the stop started the container");

        // The marker runs out in operation — forgotten; a reconcile (new stream) still starts nothing: the state alone holds.
        forgetSelfStopped([cid, name]);
        await streamNew(fd);
        assert.deepEqual(hostStarts(fd, mark), [], "the reconcile started the stopped instance");
        assert.equal(row(pid).state, "stopped");

        // The post-start earmarks nothing, the git waker (restore without an explicit start) is rejected.
        assert.equal(earmarkRestore(), 0);
        assert.equal(row(pid).state, "stopped");
        await assert.rejects(restoreInstance(pid, "main", { reason: "git view: container stands" }), { code: "STOPPED" });
        assert.equal(row(pid).state, "stopped");
        assert.deepEqual(hostStarts(fd, mark), []);

        // The REAL git view (GET …/git, readGitTree → gitSituation → startLock) only reads the stopped instance — no `docker
        // start`, no phase, no separator under "git-view:<pid>"; it says where to start.
        const markG = fd.calls().length;
        const tree = await raw(`${ctx.base}/api/projects/${pid}/git`);
        assert.equal(tree.status, 200, JSON.stringify(tree.body));
        assert.deepEqual(tree.body, { repos: [], error: "Die Instanz main ist gestoppt — im Reiter „Instanzen“ starten." });
        assert.deepEqual(hostStarts(fd, markG), [], "the git view started the stopped instance");
        assert.deepEqual([row(pid).state, row(pid).phase], ["stopped", ""], "the git view triggered a start");
        assert.deepEqual(store.listMessages(`git-view:${pid}`), [], "orphaned row under git-view:<pid>");

        // Started behind cbase's back: the next reconcile stops it again (with a verdict), the row stays stopped.
        dx(fd, "start", name);
        assert.equal(status(fd, name), "running");
        const markH = fd.calls().length;
        await streamNew(fd);
        assert.ok(verdictsOf(name).some((u) => u.reason === "stopped-running"), JSON.stringify(verdictsOf(name)));
        assert.deepEqual(hostStops(fd, markH), [["stop", "-t", "30", cid]], "the reconcile did not stop it again");
        assert.equal(status(fd, name), "exited");
        assert.equal(row(pid).state, "stopped");

        // Start (gate open on the Mac: no cgroup files under the root).
        const markS = fd.calls().length;
        const st = await post(url("start"));
        assert.equal(st.status, 202, JSON.stringify(st.body));
        assert.deepEqual([st.body.kind, st.body.wait], ["start", null]);
        assert.equal(st.body.instance.state, "start");
        await waitForTruthy(() => notStart(pid), "the start is through");
        assert.equal(row(pid).state, "ready", JSON.stringify(row(pid)));
        assert.deepEqual(hostStarts(fd, markS).filter((a) => a.includes(cid)), [["start", cid]], "exactly ONE docker start of the project container");
        const inside = Object.values(fd.state(name).container).filter((c) => c.status === "running").map((c) => c.name).sort();
        assert.deepEqual(inside, ["a-app-1", "a-db-1"], "the inner ones with desired state running");
        const second = await post(url("start"));
        assert.deepEqual([second.status, second.body.code], [409, "INSTANCE_NOT_STOPPED"], JSON.stringify(second.body));
        assert.equal((await json(`${ctx.base}/api/runs/active`)).projectStopped, 0);
      });
    } finally {
      if (turnChat) running.delete(turnChat);
      if (kChat) running.delete(kChat);
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (2) the storage gate ──────────────────────────────────────────────────────────────────────────────────────────────────
test("(2) storage gate: closed ⇒ waits (phase waiting_storage, no docker start), again ⇒ keeps waiting, abort takes it back; gate open + queue ⇒ ready", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: randomUUID() });
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    const sp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-in6-storage-"));
    const cg = path.join(sp, "sys", "fs", "cgroup");
    fs.mkdirSync(cg, { recursive: true });
    fs.writeFileSync(path.join(cg, "memory.max"), "1000\n");
    fs.writeFileSync(path.join(cg, "memory.current"), "900\n"); // 90 % => closed
    try {
      await inOps(fd, s, async () => {
        const { cid } = projectRunning(fd, s);
        const pid = s.projectId;
        const url = (action) => `${ctx.base}/api/projects/${pid}/instances/main/${action}`;
        assert.equal((await post(url("stop"))).status, 202);
        await waitForTruthy(() => notStop(pid), "the stop is through");
        assert.equal(row(pid).state, "stopped");

        const mark = fd.calls().length;
        const w1 = await post(url("start"));
        assert.equal(w1.status, 202, JSON.stringify(w1.body));
        assert.equal(w1.body.kind, "waiting");
        assert.match(w1.body.wait?.reason || "", /90/, JSON.stringify(w1.body));
        assert.deepEqual([row(pid).state, row(pid).phase], ["stopped", "waiting_storage"]);
        const w2 = await post(url("start"));
        assert.deepEqual([w2.status, w2.body.kind], [202, "waiting"], JSON.stringify(w2.body));
        wakeStorageQueue(); // the gate is closed: nothing
        assert.deepEqual(hostStarts(fd, mark), [], "started with the gate closed");
        assert.deepEqual([row(pid).state, row(pid).phase], ["stopped", "waiting_storage"]);

        const abbr = await post(url("start-abort"));
        assert.equal(abbr.status, 200, JSON.stringify(abbr.body));
        assert.deepEqual([abbr.body.instance.state, abbr.body.instance.phase], ["stopped", ""]);
        const abbr2 = await post(url("start-abort"));
        assert.deepEqual([abbr2.status, abbr2.body.code], [409, "NO_WAITING_START"], JSON.stringify(abbr2.body));

        // Waiting again; the gate opens, the queue brings it up.
        assert.equal((await post(url("start"))).body.kind, "waiting");
        fs.writeFileSync(path.join(cg, "memory.current"), "100\n");
        wakeStorageQueue();
        await waitForTruthy(() => (row(pid).state !== "stopped" ? true : null), "the queue touched the instance");
        await waitForTruthy(() => notStart(pid), "the start is through");
        assert.deepEqual([row(pid).state, row(pid).phase], ["ready", ""], JSON.stringify(row(pid)));
        assert.deepEqual(hostStarts(fd, mark).filter((a) => a.includes(cid)), [["start", cid]]);
      }, { CBASE_STORAGE_ROOT: sp });
    } finally {
      cleanUpRows();
      fd.cleanUp();
      fs.rmSync(sp, { recursive: true, force: true });
    }
  });
});

// ── (3) a turn starts the stopped instance ────────────────────────────────────────────────────────────────────────────────
const MAIN_AGENT = `
  { const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase; const env = cfg.env || {};
    fs.appendFileSync(path.join(LOCATION, "turns.jsonl"), JSON.stringify({ n: turn, text, instance: env.CBASE_INSTANCE || null }) + "\\n"); }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;
const claude = fakeClaude({ main: MAIN_AGENT, sub: `finished(); say({ type: "result", result: "x", session_id: "sub-session" });` });

test("(3) a turn in a stopped instance starts it, writes the separator “main started.” and then runs in the project container", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: randomUUID() });
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        const { name, cid } = projectRunning(fd, s);
        const pid = s.projectId;
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
        assert.equal((await post(`${ctx.base}/api/projects/${pid}/instances/main/stop`)).status, 202);
        await waitForTruthy(() => notStop(pid), "the stop is through");
        assert.equal(row(pid).state, "stopped");

        const mark = fd.calls().length;
        await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please work" }) });
        const turns = () => readJsonl(path.join(ctx.root, "turns.jsonl"));
        await waitForTruthy(async () => (turns().length >= 1 || ((await json(`${ctx.base}/api/runs/active`)).runs === 0 && notStart(pid)) ? true : null), "the turn ran or ended");
        await ctx.waitForQuiet();
        const hints = store.listMessages(ctx.chat.id).filter((m) => m.role === "hint").map((m) => m.text);
        assert.ok(hints.includes(startSeparatorText("main", "start")), `no separator: ${JSON.stringify(hints)}`);
        assert.equal(row(pid).state, "ready", JSON.stringify(row(pid)));
        assert.deepEqual(hostStarts(fd, mark).filter((a) => a.includes(cid)), [["start", cid]], "the turn did not start the instance (exactly once)");
        assert.equal(turns().length, 1, "the turn did not run");
        assert.equal(turns()[0].instance, `${pid}/main`);
        assert.equal(status(fd, name), "running");
        // Order in the history: the separator comes before the answer.
        const roles = store.listMessages(ctx.chat.id).map((m) => m.role);
        assert.ok(roles.indexOf("hint") < roles.lastIndexOf("assistant"), roles.join(" → "));
      }, { CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"), CBASE_IN_PROJECT_ESCALATION_MS: "200" });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  }, { claude }));
});

// ── (4) preview links ─────────────────────────────────────────────────────────────────────────────────────────────────────
test("(4) preview: stopped ⇒ 502 “Instance stopped” for request and upgrade, without asking the service; while it runs, everything goes through", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: randomUUID() });
    store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: "x" });
    const question = stoppedTextOf({ projectId: s.projectId, instance: "main" });
    assert.equal(question(), null, "ready does not stand");
    assert.equal(stoppedTextOf({ projectId: s.projectId, instance: null })(), null, "never without an instance");
    let asked = 0;
    const service = http.createServer((req, res) => { asked += 1; res.writeHead(200, { "content-type": "text/plain" }); res.end("hello"); });
    service.on("upgrade", (_req, plinth) => { asked += 1; plinth.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"); });
    await new Promise((r) => service.listen(0, "127.0.0.1", r));
    const proxy = await startRewriteProxy({ target: `http://127.0.0.1:${service.address().port}`, stoppedText: question });
    const fetchData = async () => { const r = await fetch(`${proxy.url}/`, { headers: { Connection: "close" } }); return { status: r.status, text: await r.text() }; };
    const upgrade = () => new Promise((ok, no) => {
      const k = net.connect(proxy.port, "127.0.0.1", () => k.write(`GET /hmr HTTP/1.1\r\nHost: x.ngrok.app\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
      let buf = "";
      k.on("data", (d) => { buf += d; });
      k.on("end", () => ok(buf));
      k.on("close", () => ok(buf));
      k.on("error", no);
    });
    try {
      assert.deepEqual(await fetchData(), { status: 200, text: "hello" });
      assert.equal(asked, 1);
      setInstanceState(s.projectId, "main", "stop");
      const st = await fetchData();
      assert.equal(st.status, 502);
      assert.match(st.text, /^Instanz gestoppt/);
      setInstanceState(s.projectId, "main", "stopped");
      const g = await fetchData();
      assert.equal(g.status, 502);
      assert.match(g.text, /^Instanz gestoppt — „main“ wurde in cbase gestoppt/);
      const u = await upgrade();
      assert.match(u, /^HTTP\/1\.1 502 Bad Gateway/);
      assert.match(u, /Instanz gestoppt/);
      assert.equal(asked, 1, "the service was asked despite the stopped instance");
      setInstanceState(s.projectId, "main", "ready");
      assert.deepEqual(await fetchData(), { status: 200, text: "hello" });
      assert.equal(asked, 2);
    } finally {
      await proxy.close();
      service.closeAllConnections();
      await new Promise((r) => service.close(r));
      store.deleteProjectInstance(s.projectId, "main");
    }
  });
});

// ── (5) a stop interrupted by the restart ─────────────────────────────────────────────────────────────────────────────────
test("(5) restart grace: `stop` without a living procedure becomes `stopped` (never `error`), with a living one it stays; `busy` only while stopping", async () => {
  await withAgentsServer(async ({ base }) => {
    let resolve = () => {};
    const gate = new Promise((r) => { resolve = r; });
    try {
      setInstanceState("p-in6", "main", "stop", { phase: "container", convertedAt: Date.now() });
      const a = withProcedure("p-in6", "main", () => gate);
      instancesRestartGrace();
      assert.equal(store.projectInstance("p-in6", "main").state, "stop", "a living stop was rewritten");
      assert.equal((await json(`${base}/api/runs/active`)).busy, true, "stopping is work");
      resolve();
      await a;
      instancesRestartGrace();
      const z = store.projectInstance("p-in6", "main");
      assert.deepEqual([z.state, z.phase, z.error], ["stopped", "", ""], JSON.stringify(z));
      const active = await json(`${base}/api/runs/active`);
      assert.deepEqual([active.busy, active.projectStopped], [false, 1], JSON.stringify(active));
    } finally {
      resolve();
      store.deleteProjectInstance("p-in6", "main");
    }
  });
});

// ── (6) a start rejected at the lock ──────────────────────────────────────────────────────────────────────────────────────
// A turn in a stopped instance triggers its start. If an OCCUPATION rejects the start (here a project occupation "copy", held
// like the build of another copy), the verdict used to say "is started for this run" although nothing started, and with neither
// a row transition nor the storage queue coming, the turn waited until the next look (10 min). Now the sentence says why, and
// the end of the occupation (projectbox/instance.js setOccupancyEnd → idle.js afterOccupancy) takes the turn out of the queue —
// SYNCHRONOUSLY in the finally of the occupation —, its look at the lock starts the instance, and it runs.
// COUNTER-TESTS: server.js without `setOccupancyEnd(…)` => red ("the end of the occupation did not wake the waiting turn", no
// hang); idle.js without the branch `nudge?.ok === false` => red (the sentence says "is started for this run").
test("(6) start rejected by an occupation ⇒ honest sentence; the end of the occupation makes up the start, the turn runs", async () => {
  await withoutAccount(() => withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { projectId: randomUUID() });
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    let resolve = () => {};
    let hold = null;
    try {
      await inOps(fd, s, async () => {
        const { cid } = projectRunning(fd, s);
        const pid = s.projectId;
        await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
        assert.equal((await post(`${ctx.base}/api/projects/${pid}/instances/main/stop`)).status, 202);
        await waitForTruthy(() => notStop(pid), "the stop is through");
        assert.equal(row(pid).state, "stopped");

        const gate = new Promise((r) => { resolve = r; });
        hold = withProjectOccupancy(pid, "copy", () => gate);
        const mark = fd.calls().length;
        const m = await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please work" }) });
        assert.equal(m.locked, true, JSON.stringify(m));
        assert.deepEqual(hostStarts(fd, mark), [], "started despite the occupation");
        assert.deepEqual([row(pid).state, row(pid).phase], ["stopped", ""]);
        const u = projectLock(ctx.chat.id, "turn");
        assert.match(u.text, /^Die Instanz main ist gestoppt; ihr Start ist gerade nicht möglich \(An der Instanz main läuft gerade .+\) — er wird nachgeholt, sobald das vorbei ist/, u.text);
        assert.doesNotMatch(u.text, /wird für diesen Lauf gestartet/);
        assert.equal((pendingRunInputs.get(ctx.chat.id) || []).length, 1, "the turn is not waiting in the queue");

        resolve();
        await hold;
        hold = null;
        assert.equal((pendingRunInputs.get(ctx.chat.id) || []).length, 0, "the end of the occupation did not wake the waiting turn");
        const turns = () => readJsonl(path.join(ctx.root, "turns.jsonl"));
        // The turn parks at the lock while the instance starts (`start`) and runs after the transition to `ready` (state waker →
        // fireAutoContinue). Waited on: its run or a visible failure of the start — without a deadline.
        await waitForTruthy(() => (turns().length >= 1 || row(pid).state === "error" ? true : null), "the turn ran (or the start failed)");
        await ctx.waitForQuiet();
        assert.equal(row(pid).state, "ready", JSON.stringify(row(pid)));
        assert.deepEqual(hostStarts(fd, mark).filter((a) => a.includes(cid)), [["start", cid]], "exactly ONE docker start after the end of the occupation");
        assert.equal(turns().length, 1, "the turn did not run");
        const hints = store.listMessages(ctx.chat.id).filter((x) => x.role === "hint").map((x) => x.text);
        assert.ok(hints.includes(startSeparatorText("main", "start")), `no separator: ${JSON.stringify(hints)}`);
      }, { CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"), CBASE_IN_PROJECT_ESCALATION_MS: "200" });
    } finally {
      resolve();
      if (hold) await hold.catch(() => {});
      // A red case leaves no turn in the queue (the harness would otherwise wait for quiet).
      if (pendingRunInputs.has(ctx.chat.id)) { pendingRunInputs.delete(ctx.chat.id); persistRunInputs(ctx.chat.id); }
      cleanUpRows();
      fd.cleanUp();
    }
  }, { claude }));
});
