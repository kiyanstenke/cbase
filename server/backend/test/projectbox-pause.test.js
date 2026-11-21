// The pause barrier and the thaw (project container, copy stage). Product: projectbox/docker.js (pause, thawOut, thawAll,
// thawRestartGrace, waitForThaw, dockerIn, dockerChildAfterThaw), runtime/inProject.js (the barrier seam), projectbox/restore.js
// (unpause instead of start, FROZEN), projectbox/serverEnd.js, projectbox/idle.js (the "freeze" lock), devtools/code-route.js
// (gitStandsSituation), services.js (service monitor), server.js (hook "project-thaw").
//
// What holds here:
//   (a)  restart: a paused main and a paused, orphaned project container (label `cbase.project`, no row) ⇒ through the REAL hook
//        chain (fireHooks "restartGrace") both are thawed, the main is NEVER started (the daemon rejects `docker start` of a paused
//        one), the row is `ready`; a paused container WITHOUT the label stays as it is.
//   (a2) Without the hook (restore only): the main is thawed anyway (the branch in restore.js), the orphaned one stays paused — the
//        hook is what thaws it.
//   (b)  Main seam of the loop engine: a Bash that starts during a pause waits at the barrier (no exec at the daemon), runs after the
//        thaw and delivers its output — no "is paused" for the agent. Built-in counter-probe: a pause cbase does NOT hold (a `docker
//        pause` from outside) does not reach the barrier, and the Bash gets the daemon's error.
//   (c1) restoreInstance of a frozen main ⇒ FROZEN (409), the row stays `ready`, no docker call.
//   (c2) gitStandsSituation: "is paused" ⇒ the situation "frozen", the git wake-up is NOT called; "is not running" wakes it (built-in
//        counter-probe: the same place wakes when the container stands).
//   (d)  dockerIn waits during the pause (no exec at the daemon) and runs after the thaw; the cap (clock seam advanceCap) rejects with a
//        message saying it was a cap and does NOT thaw. Built-in counter-probe: the same exec past the barrier gets "is paused".
//   (d2) dockerChildAfterThaw: the child waits, runs after the thaw with its output; a kill before the go takes the wait back; the cap
//        ends with 125 and the message. Built-in counter-probe: dockerKind (no barrier) ⇒ "is paused".
//   (e)  projectLocks "freeze": set without idle (a running monitor does not stop it — a "relocation" beside it does), turn and agent
//        "wait", a oneshot runs; `resolve` once.
//   (f)  Server end: a frozen main and a foreign-paused project container are thawed BEFORE the stop (exit 143, not 137); the frozen one
//        gets no snapshot (the last one counts), a ready one beside it does.
//   (g)  `pause`/`unpause` appear as docker argument only in projectbox/docker.js — with a built-in sabotage.
//   (h)  Service monitor: a service in a frozen project container reports no outage, its state stays; after the thaw the same service
//        reports the outage (built-in counter-probe: the check sees it).
//
// Wait only for events: waitingForThaw() (how many starts stand at the barrier), states via waitForTruthy (no deadline), openHooks(),
// the clock seam of the caps. Every wait that could hang on a sabotage also ends on the counter-event (e.g. "the Bash already ran"), so
// a red state is red and not silent.
//
// COUNTER-PROBES (one sabotage in the tree, the whole file run; every sabotage red WITHOUT a hang):
//   server.js: registration of "project-thaw" removed                            ⇒ (a) red ("the orphaned … is still paused"), and
//                                                                                    projectbox-restore.test.js (11) red
//   the same AND restore.js: branch `State.Paused` removed                        ⇒ (a), (a2) red ("cannot start a paused container")
//   server.js: seam without `frozen`/`childAfterThaw`                            ⇒ (b) red ("the Bash ran during the pause: … is paused")
//   restore.js: FROZEN check removed                                              ⇒ (c1) red ("the row was touched")
//   code-route.js: gitStandsSituation without the pause line                      ⇒ (c2) red (situation "stopped", the wake-up ran)
//   docker.js: dockerIn without the barrier (only the catch-up path stays)        ⇒ (d) red ("an exec at the daemon during the pause")
//   idle.js: "freeze" goes through the idle check                                 ⇒ (e) red ("the 'freeze' lock demanded idle … monitor")
//   serverEnd.js: no thawAll                                                      ⇒ (f) red ("not thawed first, then stopped")
//   services.js: no target skipped                                                ⇒ (h) red ("an outage reported during the pause")
//   docker.js: the wait settles the wrong member (the state at build time)        ⇒ (d) red ("an expired wait still counts")
//   docker.js: dockerChildAfterThaw always dockerKind                             ⇒ (b), (d2) red
// (b) to (h) ran together in one sabotage run (they hit different tests; each test fell with ITS message). (g) carries its sabotage itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import {
  advanceCap, docker, dockerIn, dockerKind, dockerChildAfterThaw, frozen2, isFrozen, advanceRethaw, openRethaw, pause,
  thawAll, thawOut, waitingForThaw,
} from "../electron/server/projectbox/docker.js";
import { serverEndMarkerForTest } from "../electron/server/runs/server-end.js";
import { procedureAlive, setInstanceState } from "../electron/server/projectbox/instances.js";
import { projectLock, projectLocks } from "../electron/server/projectbox/idle.js";
import { projectboxServerEnd, desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { restoreInstance, advanceStagesCap, restoreRestartGrace, earmarkRestore } from "../electron/server/projectbox/restore.js";
import { gitStandsSituation, setGitWakeup } from "../electron/server/devtools/code-route.js";
import { fireHooks, openHooks } from "../electron/server/runs/hooks.js";
import { closeMonitors, startMonitor as startMonitorValue } from "../electron/server/runs/monitors.js";
import os from "node:os";
import { checkNow, getMonitorEvents, startMonitor, stopMonitor } from "../electron/server/services.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const PAUSE_TEXT = "Error response from daemon: Container 4f2a is paused, unpause the container before exec";

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const pausedIn = (fd, id) => Boolean(fd.state().container[id]?.paused);

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200" });

// The environment of a restore test (shape of projectbox-restore.test.js): the marks of withOps, the stage cap and the snapshot cap
// set high, the root of the network mark; after the body, still in ops mode, a living procedure is carried to its end (carryOut) and
// every own pause is thawed. NOT via advanceCap: that would hit EVERY running docker call, and a procedure that repeats a failed call
// on a beat (waitForInside) would then run forever — here a pause ends by thawing.
async function inOps(fd, s, fn) {
  return withEnvironment({ CBASE_PROJECT_STAGE_MS: "3600000", CBASE_SNAPSHOT_MS: "3600000", CBASE_NETWORK_ROOT: s?.root }, () =>
    withOps(fd, async () => {
      try { return await fn(); } finally { await carryOut(fd); }
    }));
}
async function carryOut(fd) {
  const alive = () => store.projectInstances().some((z) => procedureAlive(z.projectId, z.instance));
  while (alive() || waitingForThaw() > 0) {
    const gates = path.join(fd.dir, "gates");
    for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) {
      if (f.endsWith(".waiting")) fd.openGate(decodeURIComponent(f.slice(0, -".waiting".length)));
    }
    advanceStagesCap();
    for (const n of frozen2()) await thawOut(n).catch((e) => console.warn(`[pause] carryOut ${n}: ${e?.message || e}`));
    await new Promise((r) => setTimeout(r, 10));
  }
}
function cleanUpRows() {
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
    try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[pause] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}
async function thawFallsNeeded(...names) {
  for (const n of names) if (n && isFrozen(n)) await thawOut(n).catch((e) => console.warn(`[pause] cleanup ${n}: ${e?.message || e}`));
}

// A converted project with a RUNNING main (label, row `ready`, empty snapshot) — the state in which a copy freezes it.
function mainRunning(fd, s, { desired = desiredFromInspect([]) } = {}) {
  const name = `cbase-p-${s.projectId}`;
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired, ip: "127.0.0.1" });
  return { name, cid };
}
const hostCalls = (fd, mark = 0) => fd.calls({ daemon: "host" }).slice(mark).map((a) => a.args);

// ── (a) restart ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(a) restart through the hook chain: paused main and orphaned project container are thawed, the main is never started, the row is ready; without label it stays paused", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name, cid } = mainRunning(fd, s);
      const orphaned = dx(fd, "run", "-d", "--name", `cbase-p-orphaned-${s.projectId}`, "--label", "cbase.project=orphaned", "cbase-projectbox:latest");
      const foreign = dx(fd, "run", "-d", "--name", `audit-db-${s.projectId}`, "postgres:16");
      // The state after a hard end of B in the middle of a pause: paused at the daemon, this process's set empty.
      for (const c of [name, orphaned, foreign]) dx(fd, "pause", c);
      assert.equal(isFrozen(name), false, "the set is empty after the restart");
      await inOps(fd, s, async () => {
        const mark = fd.calls({ daemon: "host" }).length;
        assert.equal(earmarkRestore(), 1);
        await fireHooks("restartGrace", {});
        await waitForTruthy(() => openHooks() === 0, "the restart consumers are done");
        const row = store.projectInstance(s.projectId);
        assert.equal(row.state, "ready", `the restore failed on the paused main: ${row.error}`);
        const host = hostCalls(fd, mark);
        assert.ok(!host.some((a) => a[0] === "start"), `a docker start (the daemon rejects it for a paused one): ${JSON.stringify(host)}`);
        assert.ok(host.some((a) => a[0] === "unpause" && (a.includes(cid) || a.includes(name))), `the main was not thawed: ${JSON.stringify(host)}`);
        assert.equal(pausedIn(fd, cid), false, "the main is still paused");
        assert.equal(pausedIn(fd, orphaned), false, "the orphaned project container is still paused — the hook 'project-thaw' is missing");
        assert.equal(pausedIn(fd, foreign), true, "a container without the label cbase.project does not belong to cbase");
        assert.equal(fd.state().container[cid].status, "running");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(a2) Without the hook (restore only): the main is thawed through the branch, never started — the orphaned one stays paused", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name, cid } = mainRunning(fd, s);
      const orphaned = dx(fd, "run", "-d", "--name", `cbase-p-orphaned-${s.projectId}`, "--label", "cbase.project=orphaned", "cbase-projectbox:latest");
      for (const c of [name, orphaned]) dx(fd, "pause", c);
      await inOps(fd, s, async () => {
        const mark = fd.calls({ daemon: "host" }).length;
        assert.equal(earmarkRestore(), 1);
        await restoreRestartGrace();
        const row = store.projectInstance(s.projectId);
        assert.equal(row.state, "ready", row.error);
        const host = hostCalls(fd, mark);
        assert.ok(!host.some((a) => a[0] === "start"), JSON.stringify(host));
        assert.deepEqual(host.filter((a) => a[0] === "unpause"), [["unpause", cid]], "the branch thaws exactly the main, by id");
        assert.equal(pausedIn(fd, orphaned), true, "without the hook the orphaned one stays paused — exactly what (a) holds");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (b) main seam of the loop engine ────────────────────────────────────────────────────────────────────────────────

test("(b) loop engine: a Bash during the pause waits at the barrier and runs after the thaw; a foreign pause does not reach the barrier (counter-probe)", async () => {
  const fd = await fakeDocker();
  const R = { mode: null, name: null, cid: null, result: {}, error: null };
  const content = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));
  const round = async (b) => {
    const id = `call_${R.mode}`;
    const tool = (b.messages || []).find((m) => m.role === "tool" && m.tool_call_id === id);
    if (tool) {
      R.result[R.mode] = content(tool);
      if (R.mode === "foreign") dx(fd, "unpause", R.name);
      return { text: "finished" };
    }
    try {
      if (R.mode === "barrier") await pause(R.name);
      else dx(fd, "pause", R.name); // a pause cbase does not hold
    } catch (e) { R.error = e; }
    return { toolCalls: [{ id, name: "Bash", arguments: { command: `echo BASH-OK-${R.mode}` } }] };
  };
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws, engine } = ctx;
      const npx = path.join(ctx.root, "npx");
      fs.writeFileSync(npx, "#!/bin/sh\nexit 1\n");
      fs.chmodSync(npx, 0o755);
      await withEnvironment({ ...ops(fd), NPX_BIN: npx }, async () => {
        const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Pause" }) });
        const projPath = path.join(ctx.root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Till", path: projPath });
        R.name = `cbase-p-${p.id}`;
        R.cid = dx(fd, "run", "-d", "--name", R.name, "cbase-projectbox:test");
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: R.name, ip: "127.0.0.1" });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        const bashExec = (mode) => fd.calls({ daemon: "host" }).some((a) => a.args[0] === "exec" && a.args.some((x) => String(x).includes(`BASH-OK-${mode}`)));
        try {
          // 1. The pause cbase holds: the Bash waits at the barrier.
          R.mode = "barrier";
          await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go" }) });
          await waitForTruthy(() => waitingForThaw() === 1 || R.result.barrier !== undefined || R.error, "the Bash stands at the barrier");
          assert.equal(R.error, null, `pause failed: ${R.error?.message}`);
          assert.equal(R.result.barrier, undefined, `the Bash ran during the pause: ${R.result.barrier}`);
          assert.equal(isFrozen(R.name), true);
          assert.equal(bashExec("barrier"), false, "an exec of the Bash at the daemon while the container is frozen");
          await thawOut(R.name);
          await waitForTruthy(() => R.result.barrier !== undefined, "the result of the Bash");
          assert.match(R.result.barrier, /BASH-OK-barrier/, R.result.barrier);
          assert.doesNotMatch(R.result.barrier, /is paused/, "the agent saw the pause error");
          assert.equal(bashExec("barrier"), true, "the Bash ran in the project container after the thaw");
          await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn finished");

          // 2. Counter-probe: a pause cbase does NOT hold — no barrier, the daemon's error.
          R.mode = "foreign";
          await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Again" }) });
          await waitForTruthy(() => R.result.foreign !== undefined, "the result of the Bash in the foreign pause");
          assert.match(R.result.foreign, /is paused/, `without the barrier no daemon error — the counter-probe does not bite: ${R.result.foreign}`);
          assert.equal(waitingForThaw(), 0);
          await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn finished");
        } finally {
          await thawFallsNeeded(R.name);
          if (pausedIn(fd, R.cid)) dx(fd, "unpause", R.name);
        }
      });
    }, { engine: { round } });
  } finally {
    fd.cleanUp();
  }
});

// ── (c) no path starts a frozen main ────────────────────────────────────────────────────────────────────────────────

test("(c1) restoreInstance of a frozen main: FROZEN (409), the row stays ready, no docker call", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name } = mainRunning(fd, s);
      await inOps(fd, s, async () => {
        try {
          await pause(name);
          const mark = fd.calls().length;
          const p = restoreInstance(s.projectId, "main", { reason: "Git view: container is stopped" });
          assert.equal(store.projectInstance(s.projectId).state, "ready", "the row was touched");
          assert.equal(procedureAlive(s.projectId, "main"), false, "a restore procedure next to the pause");
          await assert.rejects(p, (e) => e.code === "FROZEN" && e.status === 409);
          assert.deepEqual(fd.calls().slice(mark), [], "a docker call next to the pause");
        } finally {
          await thawFallsNeeded(name);
        }
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(c2) gitStandsSituation: \"is paused\" ⇒ situation \"frozen\" without wake-up; \"is not running\" wakes (counter-probe)", () => {
  const woken = [];
  setGitWakeup((pid) => woken.push(pid));
  try {
    const situation = gitStandsSituation("p-pause", PAUSE_TEXT);
    assert.equal(situation.starts, true);
    assert.equal(situation.reason, "frozen");
    assert.match(situation.notice, /eingefroren|frozen/);
    assert.deepEqual(woken, [], "a pause woke the restore");
    const stands = gitStandsSituation("p-stands", "Error response from daemon: container 4f2a is not running");
    assert.equal(stands.reason, "stopped");
    assert.deepEqual(woken, ["p-stands"], "the counter-probe does not bite: a stopped container did not wake");
  } finally {
    setGitWakeup(null);
  }
});

// ── (d) dockerIn and the child behind the barrier ───────────────────────────────────────────────────────────────────

test("(d) dockerIn waits during the pause and runs after the thaw; the cap rejects with a message and does not thaw; past the barrier \"is paused\" (counter-probe)", async () => {
  const fd = await fakeDocker();
  try {
    await withEnvironment({ ...ops(fd), CBASE_PAUSE_CAP_MS: undefined }, async () => {
      const name = "cbase-p-dpause";
      const cid = dx(fd, "run", "-d", "--name", name, "--label", "cbase.project=dpause", "cbase-projectbox:test");
      try {
        const { id } = await pause(name);
        assert.equal(id, cid);
        assert.equal(isFrozen(name), true);
        assert.equal(isFrozen(cid), true, "known by id (stop chain and restore ask for it)");
        assert.equal(isFrozen(cid.slice(0, 12)), true, "under the short id prefix");
        await assert.rejects(pause(name), (e) => e.code === "ALREADY_FROZEN");
        // Counter-probe: past the barrier the daemon rejects.
        const direct = await docker(["exec", "-u", "agent", name, "docker", "ps", "-q"]).then(() => null, (e) => e);
        assert.ok(direct && /is paused/.test(String(direct.stderr || direct.message)), `without the barrier no "is paused": ${direct?.message}`);

        const prior = fd.calls({ daemon: name }).length;
        const hostPrior = fd.calls({ daemon: "host" }).length;
        let done = null;
        const p = dockerIn(name, ["ps", "-q"]).then((r) => { done = { r }; return r; }, (e) => { done = { e }; throw e; });
        await waitForTruthy(() => waitingForThaw() === 1 || done, "dockerIn stands at the barrier");
        assert.equal(done, null, `dockerIn ran during the pause: ${done?.e?.message}`);
        assert.equal(fd.calls({ daemon: name }).length, prior, "an exec at the inner daemon during the pause");
        assert.deepEqual(hostCalls(fd, hostPrior), [], "an exec at the daemon during the pause (the barrier is missing, only the race caught up)");
        const t = await thawOut(name);
        assert.equal(t.wasPaused, true);
        await p;
        assert.equal(isFrozen(name), false);
        assert.equal(fd.calls({ daemon: name }).length, prior + 1, "exactly one exec after the thaw");

        // The cap: rejected with a message, the pause stays.
        await pause(name);
        done = null;
        const q = dockerIn(name, ["inspect", "x"]).then((r) => { done = { r }; }, (e) => { done = { e }; });
        await waitForTruthy(() => waitingForThaw() === 1 || done, "dockerIn stands at the barrier");
        assert.ok(advanceCap() >= 1, "no running pause cap");
        await q;
        assert.ok(done?.e, "the cap did not reject");
        assert.equal(done.e.code, "PAUSE_CAP");
        assert.match(done.e.message, /frozen for \d+ ms — cap of 300000 ms \(CBASE_PAUSE_CAP_MS\) reached, docker inspect aborted/);
        assert.equal(isFrozen(name), true, "the cap does not thaw");
        assert.equal(waitingForThaw(), 0, "an expired wait still counts");
        assert.equal(pausedIn(fd, cid), true);
      } finally {
        await thawFallsNeeded(name);
      }
      assert.equal(pausedIn(fd, cid), false);
      // Thawing a container that is not (any more) paused is no error.
      assert.equal((await thawOut(name)).wasPaused, false);
    });
  } finally {
    fd.cleanUp();
  }
});

// The end of a child: code, signal, stdout, stderr.
function end(kind) {
  let out = "";
  let err = "";
  kind.stdout?.on("data", (d) => { out += d; });
  kind.stderr?.on("data", (d) => { err += d; });
  return new Promise((r) => kind.once("close", (code, signal) => r({ code, signal, out, err })));
}

test("(d2) child behind the barrier: waits, runs after the thaw (same streams); a kill before the go takes the wait back; the cap ends with 125 and a message; without barrier \"is paused\" (counter-probe)", async () => {
  const fd = await fakeDocker();
  try {
    await withEnvironment(ops(fd), async () => {
      const name = "cbase-p-kpause";
      const cid = dx(fd, "run", "-d", "--name", name, "--label", "cbase.project=kpause", "cbase-projectbox:test");
      const args = (what) => ["exec", "-i", "-u", "agent", name, "sh", "-c", `echo ${what}`];
      const ran = (what) => fd.calls({ daemon: "host" }).some((a) => a.args[0] === "exec" && a.args.some((x) => String(x).includes(what)));
      try {
        await pause(name);
        // Counter-probe: without barrier.
        const without = await end(dockerKind(args("WITHOUT-OK")));
        assert.notEqual(without.code, 0);
        assert.match(without.err, /is paused/, `without the barrier no "is paused": ${JSON.stringify(without)}`);

        // Go after the thaw.
        const k = dockerChildAfterThaw(name, args("KIND-OK"));
        const e1 = end(k);
        assert.ok(k.pid > 0 && k.barrier && k.barrier.started === false);
        await waitForTruthy(() => waitingForThaw() === 1, "the child stands at the barrier");
        assert.equal(ran("KIND-OK"), false, "an exec of the child at the daemon during the pause");
        await thawOut(name);
        const r1 = await e1;
        assert.deepEqual({ code: r1.code, out: r1.out.trim() }, { code: 0, out: "KIND-OK" }, JSON.stringify(r1));
        assert.equal(k.barrier.started, true);

        // Kill before the go.
        await pause(name);
        const kk = dockerChildAfterThaw(name, args("KILL-OK"));
        const e2 = end(kk);
        await waitForTruthy(() => waitingForThaw() === 1, "the child stands at the barrier");
        kk.kill("SIGTERM");
        const r2 = await e2;
        assert.equal(r2.signal, "SIGTERM", JSON.stringify(r2));
        assert.equal(waitingForThaw(), 0, "the wait of the killed child stayed");
        assert.equal(kk.barrier.started, false);

        // The cap.
        const kd = dockerChildAfterThaw(name, args("CAP-OK"));
        const e3 = end(kd);
        await waitForTruthy(() => waitingForThaw() === 1, "the child stands at the barrier");
        assert.ok(advanceCap() >= 1);
        const r3 = await e3;
        assert.equal(r3.code, 125, JSON.stringify(r3));
        assert.match(r3.err, /cap of \d+ ms \(CBASE_PAUSE_CAP_MS\) reached/);
        assert.equal(waitingForThaw(), 0, "an expired wait still counts");
        assert.equal(ran("KILL-OK") || ran("CAP-OK"), false, "a child that never got the go ran at the daemon");
        assert.equal(isFrozen(name), true);
      } finally {
        await thawFallsNeeded(name);
      }
      assert.equal(pausedIn(fd, cid), false);
    });
  } finally {
    fd.cleanUp();
  }
});

// ── (e) the "freeze" lock ───────────────────────────────────────────────────────────────────────────────────────────

test("(e) projectLocks \"freeze\": without idle (a running monitor does not hold it, a relocation does), turn and agent wait, a oneshot runs; resolve once", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const chat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id }) });
    await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: s.projectId }) });
    const fd = await fakeDocker();
    // open work in the project: a real monitor on the chat (runs/monitors.js)
    const monitorLocation = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pause-monitor-"));
    startMonitorValue(chat.id, { command: "sleep 600", description: "Pause", report: "end" }, { cwd: monitorLocation, outputLocation: monitorLocation, deliver: () => {} });
    let lock = null;
    try {
      await withOps(fd, async () => {
        const relocation = projectLocks(s.projectId, { reason: "relocation" });
        assert.equal(relocation.ok, false, "the counter-probe does not bite: the relocation did not see the monitor");
        assert.ok(relocation.open.some((o) => o.reason === "monitor"), JSON.stringify(relocation));
        lock = projectLocks(s.projectId, { reason: "freeze" });
        assert.equal(lock.ok, true, `the "freeze" lock demanded idle: ${JSON.stringify(lock)}`);
        assert.equal(lock.terminalsEnded, 0);
        const turn = projectLock(chat.id, "turn");
        assert.equal(turn?.kind, "wait", JSON.stringify(turn));
        assert.equal(turn.reason, "freeze");
        assert.match(turn.text, /eingefroren/);
        assert.equal(projectLock(chat.id, "agent", { projectId: s.projectId })?.kind, "wait");
        assert.equal(projectLock(chat.id, "oneshot"), null, "a oneshot runs in B");
        assert.equal(projectLocks(s.projectId, { reason: "freeze" }).ok, false, "locked twice");
        assert.equal(lock.resolve(), true);
        assert.equal(lock.resolve(), false, "a second resolve");
        assert.equal(projectLock(chat.id, "turn"), null);
      });
    } finally {
      lock?.resolve?.();
      closeMonitors(chat.id);
      fs.rmSync(monitorLocation, { recursive: true, force: true });
      fd.cleanUp();
    }
  });
});

// ── (f) server end ──────────────────────────────────────────────────────────────────────────────────────────────────

test("(f) ServerEnd: a frozen main and a foreign-paused project container are thawed BEFORE the stop (143, not 137); the frozen one gets no snapshot, a ready one beside it does", async () => {
  await withAgentsServer(async (ctx) => {
    const s1 = scenario(ctx);
    const s2 = scenario(ctx);
    const fd = await fakeDocker({ programs: s1.programs });
    try {
      const old = { time: 1, container: [], services: [] };
      const h1 = mainRunning(fd, s1, { desired: old });
      const h2 = mainRunning(fd, s2, { desired: old });
      const orphaned = dx(fd, "run", "-d", "--name", `cbase-p-orphaned-${s1.projectId}`, "--label", "cbase.project=orphaned", "cbase-projectbox:latest");
      await inOps(fd, s1, async () => {
        await pause(h1.name);
        dx(fd, "pause", orphaned); // a pause this process does not hold
        const mark = fd.calls({ daemon: "host" }).length;
        const r = await projectboxServerEnd();
        const host = hostCalls(fd, mark);
        const stop = host.findIndex((a) => a[0] === "stop");
        const unpause = host.findIndex((a) => a[0] === "unpause");
        assert.ok(unpause >= 0 && stop > unpause, `not thawed first, then stopped: ${JSON.stringify(host)}`);
        assert.deepEqual(host[unpause].slice(1).sort(), [h1.cid, orphaned].sort(), "ONE unpause with both paused ones, by id");
        assert.ok(!host.some((a) => a[0] === "exec" && a.includes(h1.cid)), "a snapshot of the frozen main");
        const z = fd.state().container;
        for (const [what, id] of [["the frozen main", h1.cid], ["the foreign-paused one", orphaned], ["the ready main", h2.cid]]) {
          assert.deepEqual({ status: z[id].status, exitCode: z[id].exitCode }, { status: "exited", exitCode: 143 }, `${what} did not end with TERM`);
        }
        assert.equal(store.projectInstance(s1.projectId).desired.time, 1, "the frozen main got a snapshot — the last one counts");
        assert.ok(store.projectInstance(s2.projectId).desired.time > 1, "the ready main got no snapshot");
        assert.equal(r.snapshots, 1);
        assert.equal(isFrozen(h1.name), false, "the set was not emptied");
        // The yardstick: a paused one stopped WITHOUT thawing ends hard (137) in the fake docker.
        const control = dx(fd, "run", "-d", "--name", `control-${s1.projectId}`, "cbase-projectbox:latest");
        dx(fd, "pause", control);
        dx(fd, "stop", control);
        assert.equal(fd.state().container[control].exitCode, 137);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (g) pause/unpause only in projectbox/docker.js ──────────────────────────────────────────────────────────────────

// A docker call with `pause`/`unpause` as command: an argument array that STARTS with it, or a shell text `docker pause …`/
// `docker unpause …`. Pure comment lines do not count; neither does the word "pause" in the middle of a list (the channel notes in
// channels/delivery.js).
const PAUSE_ARG = /\[\s*["'`](un)?pause["'`]/;
const PAUSE_SHELL = /\bdocker\s+(un)?pause\b/;
const PAUSE_ALLOWED = new Set(["server/projectbox/docker.js"]);
function pausePlaces(files) {
  const out = [];
  for (const { rel, text } of files) {
    if (PAUSE_ALLOWED.has(rel)) continue;
    text.split("\n").forEach((z, i) => {
      const t = z.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (PAUSE_ARG.test(z) || PAUSE_SHELL.test(z)) out.push(`${rel}:${i + 1}`);
    });
  }
  return out;
}
function sources() {
  const root = path.resolve(TESTDIR, "..", "electron");
  const out = [];
  const run = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) run(p);
      else if (/\.(c|m)?js$|\.sh$/.test(e.name)) out.push({ rel: path.relative(root, p), text: fs.readFileSync(p, "latin1") });
    }
  };
  run(root);
  return out;
}

test("(g) pause/unpause as a docker command stand only in projectbox/docker.js", () => {
  const all = sources();
  assert.ok(all.some((q) => q.rel === "server/projectbox/docker.js" && PAUSE_ARG.test(q.text)), "docker.js carries no pause — the search looks in the wrong place");
  assert.ok(all.length > 200, `only ${all.length} sources read`);
  assert.deepEqual(pausePlaces(all), []);
});

test("(g) built-in sabotage: a pause/unpause outside docker.js is red, a comment and a channel note are not", () => {
  const f = (text) => pausePlaces([{ rel: "server/x.js", text }]);
  assert.deepEqual(f('await docker(["unpause", id]);'), ["server/x.js:1"]);
  assert.deepEqual(f('x\nawait dockerIn(c, [ "pause", n ]);'), ["server/x.js:2"]);
  assert.deepEqual(f('execFileSync("sh", ["-c", `docker pause ${c}`]);'), ["server/x.js:1"]);
  assert.deepEqual(f("// docker pause only explained here\n * `docker unpause` likewise"), []);
  assert.deepEqual(f('const KINDS = new Set(["cap", "pause", "resumed"]);'), []);
  assert.deepEqual(pausePlaces([{ rel: "server/projectbox/docker.js", text: 'docker(["pause", c]);' }]), [], "docker.js is the allowed place");
});

// ── (h) service monitor ─────────────────────────────────────────────────────────────────────────────────────────────

test("(h) service monitor: no outage and no state lost during the pause; after the thaw the same service reports the outage (counter-probe)", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker();
    const srv = net.createServer();
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const target = { key: `pause-${s.projectId}`, name: "web", port, container: "", projectId: s.projectId, projectName: "Pause", workspaceId: ctx.ws.id };
    const outages = () => getMonitorEvents(0).filter((e) => e.key === target.key && e.kind === "down").length;
    let name = null;
    try {
      name = mainRunning(fd, s).name;
      await withOps(fd, async () => {
        let active = false;
        startMonitor({ intervalMs: 3_600_000, getTargets: () => (active ? [target] : []) });
        active = true;
        await checkNow(); // first contact: the service runs
        await new Promise((r) => srv.close(r)); // from now on the port does not answer
        try {
          await pause(name);
          for (let i = 0; i < 3; i++) await checkNow();
          assert.equal(outages(), 0, "an outage reported during the pause");
          await thawOut(name);
          for (let i = 0; i < 3; i++) await checkNow();
          assert.equal(outages(), 1, "no outage after the thaw — the state was lost in the pause, or the check does not see the service");
        } finally {
          await thawFallsNeeded(name);
        }
      });
    } finally {
      stopMonitor();
      if (srv.listening) srv.close();
      fd.cleanUp();
    }
  });
});

// ── lifecycle: thawAll frees only what it knows; pause no longer freezes at the server end ──────────────────────────────
// (a) If `ps` fails in thawAll, the entry stays (waiters do NOT run into a frozen container) and the guardian thaws later.
// (b) An entry whose pause() still stands in beforePause is not freed by thawAll; if the server ends while pause stands there, NO
//     `pause` goes out (SERVER_END) and the entry falls. Built-in counter-probe: without a server end the same pause succeeds, and
//     thawAll with a successful ps frees the entry after the thaw.
// COUNTER-PROBES: docker.js `if (!psSucceeded) { … continue; }` removed ⇒ (a) red (the entry fell); `if (!e.pauseSent) continue;`
// removed ⇒ (b) red; the `serverEnds()` check in pause removed ⇒ (b) red (`pause` in the log).
test("lifecycle-1 (a): if `ps` fails in thawAll, the entry stays — waiters do not run off, the guardian thaws later", async () => {
  const fd = await fakeDocker();
  const dir = fs.mkdtempSync(path.join(fd.dir, "ps-broken-"));
  const broken = path.join(dir, "docker");
  fs.writeFileSync(broken, `#!/bin/sh\nif [ "$1" = ps ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi\nexec "${fd.bin}" "$@"\n`, { mode: 0o755 });
  try {
    await withEnvironment({ ...ops(fd), CBASE_PAUSE_CAP_MS: undefined }, async () => {
      const name = "cbase-p-lz1a";
      const cid = dx(fd, "run", "-d", "--name", name, "--label", "cbase.project=lz1a", "cbase-projectbox:test");
      try {
        await pause(name);
        let done = null;
        const p = dockerIn(name, ["ps", "-q"]).then((r) => { done = { r }; }, (e) => { done = { e }; });
        await waitForTruthy(() => waitingForThaw() === 1 || done, "dockerIn is at the barrier");
        process.env.CBASE_DOCKER_BIN = broken;
        const r = await thawAll({ reason: "Test" });
        process.env.CBASE_DOCKER_BIN = fd.bin;
        assert.ok(r.error.some((f) => f.startsWith("ps:")), JSON.stringify(r));
        assert.equal(isFrozen(name), true, "the entry fell although nobody knows whether the container is still paused");
        assert.equal(done, null, "the waiter ran into a frozen container");
        assert.equal(openRethaw(), 1, "no retry scheduled");
        assert.equal(pausedIn(fd, cid), true);
        assert.equal(advanceRethaw(), 1);
        await p;
        assert.ok(done?.r, `the waiter did not run after the thaw: ${done?.e?.message}`);
        assert.equal(isFrozen(name), false);
        assert.equal(pausedIn(fd, cid), false);
      } finally {
        process.env.CBASE_DOCKER_BIN = fd.bin;
        await thawFallsNeeded(name);
      }
    });
  } finally {
    fd.cleanUp();
  }
});

test("lifecycle-1 (b): in beforePause thawAll does not free the entry; if the server ends there, no `pause` goes out — without a server end it does (counter-probe)", async () => {
  const fd = await fakeDocker();
  try {
    await withEnvironment({ ...ops(fd), CBASE_PAUSE_CAP_MS: undefined }, async () => {
      const name = "cbase-p-lz1b";
      const cid = dx(fd, "run", "-d", "--name", name, "--label", "cbase.project=lz1b", "cbase-projectbox:test");
      const pauses = () => hostCalls(fd).filter((a) => a[0] === "pause").length;
      try {
        // A gate: beforePause waits until the test opens it.
        let open;
        const gate = new Promise((r) => { open = r; });
        let standsAtGate;
        const atGate = new Promise((r) => { standsAtGate = r; });
        const run = pause(name, { beforePause: async () => { standsAtGate(); await gate; } }).then((x) => ({ x }), (e) => ({ e }));
        await atGate;
        const r = await thawAll({ reason: "Test" });
        assert.deepEqual(r.error, []);
        assert.equal(isFrozen(name), true, "thawAll freed the entry of a pause() in beforePause");
        serverEndMarkerForTest(true);
        try {
          open();
          const { x, e } = await run;
          assert.ok(e, `pause succeeded in the ending server: ${JSON.stringify(x)}`);
          assert.equal(e.code, "SERVER_END");
          assert.match(e.message, /server end/);
        } finally { serverEndMarkerForTest(false); }
        assert.equal(pauses(), 0, "a pause went out in the ending server");
        assert.equal(isFrozen(name), false, "the entry stayed after the abort");
        assert.equal(pausedIn(fd, cid), false);
        // Counter-probe: without a server end the same pause freezes, and thawAll (ps succeeds) thaws and frees.
        await pause(name, { beforePause: async () => {} });
        assert.equal(pauses(), 1);
        assert.equal(pausedIn(fd, cid), true);
        const r2 = await thawAll({ reason: "Test" });
        assert.deepEqual(r2.thawed, [cid]);
        assert.equal(isFrozen(name), false);
      } finally {
        serverEndMarkerForTest(false);
        await thawFallsNeeded(name);
      }
    });
  } finally {
    fd.cleanUp();
  }
});
