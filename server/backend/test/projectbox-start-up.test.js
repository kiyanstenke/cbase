// The start sequence of an instance as its own function: projectbox/restore.js runInstanceUp — stages in `depends_on` order,
// native services, names. The restore calls it (its behavior is held by projectbox-restore.test.js), and so do the relocation
// and the copy — each under ITS OWN state and ITS OWN occupancy.
//
// What holds here:
//   (1) "No transitions" as a contract at the entry: a state that does not work (`ready`, `error`, unknown) is a TypeError; a
//       row that is not in the given state, or is missing, is an InstanceFailed — every time without setting anything (row
//       unchanged, `state_since` unchanged) and without a docker call.
//   (2) The run against the fake docker with the row in `relocation`: stage 2 starts only after stage 1 is healthy; at every
//       gate the row is in `relocation` with the phase of the stage, the project is NOT occupied and no procedure lives; then
//       phase `names` — the state never changed (`state_since` stays 1: the store stamps it on EVERY change, also a round
//       trip), the state wakeup was never called, and `desired`/`containerId` are untouched (the caller writes snapshot and
//       transition).
//   (3) If the project container is stopped, it throws InstanceFailed — the row stays in its state (no `error`), no wakeup.
//
// Waiting only on events: gates of the fake docker (gateReached/openGate); the stage cap stands in the opposite direction
// (one hour) and expires on cleanup through the clock seam.
//
// COUNTER-TESTS (one sabotage each in projectbox/restore.js, then run this file):
//   the HEAD state without runInstanceUp                                  => the whole file red (no export)
//   at the end `setInstanceState(…, "ready")` before the return           => (2) red (state ready, wakeup called)
//   the body under `withProjectOccupancy(pid, …)`                        => (2) red ("the project is occupied")
//   both entry checks removed                                             => (1) red (ready set / row created)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { procedureAlive, setStateWakeup } from "../electron/server/projectbox/instances.js";
import { projectOccupied } from "../electron/server/projectbox/instance.js";
import { wakeProject } from "../electron/server/projectbox/idle.js";
import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { InstanceFailed, runInstanceUp, advanceStagesCap } from "../electron/server/projectbox/restore.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();

// A converted project with a RUNNING project container (the caller checked that) and a stopped inner stack; the row is in
// state `state`, `state_since` = 1 (every change would stamp the current clock).
function projectWithStack(fd, s, stack, state) {
  const name = `cbase-p-${s.projectId}`;
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
  for (const c of stack) {
    const args = ["exec", name, "docker", "run", "-d", "--name", c.name, "--label", "com.docker.compose.project=hf", "--label", `com.docker.compose.service=${c.service}`];
    if (c.dependsOn) args.push("--label", `com.docker.compose.depends_on=${c.dependsOn}`);
    if (c.healthy) args.push("--health-cmd", "true");
    dx(fd, ...args, "img");
  }
  const ids = dx(fd, "exec", name, "docker", "ps", "-aq", "--no-trunc").split("\n").filter(Boolean);
  const inspect = ids.length ? JSON.parse(dx(fd, "exec", name, "docker", "inspect", ...ids)) : [];
  store.createProjectInstance({ projectId: s.projectId, state, convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect(inspect), now: 1 });
  if (ids.length) dx(fd, "exec", name, "docker", "stop", ...ids);
  // `.waiting` marks from seeding do not count: a gate is reached only when the product itself looks.
  for (const f of fs.readdirSync(path.join(fd.dir, "gates"))) if (f.endsWith(".waiting")) fs.rmSync(path.join(fd.dir, "gates", f));
  return { name, cid, idOf: Object.fromEntries(inspect.map((c) => [c.Name.replace(/^\//, ""), c.Id])) };
}

// Which inner containers the product has started so far (`docker start` INSIDE the project container), by name.
function started(fd, name, idOf) {
  const byId = Object.fromEntries(Object.entries(idOf).map(([n, id]) => [id, n]));
  return fd.calls({ daemon: name }).filter((a) => a.args[0] === "start").flatMap((a) => a.args.slice(1)).map((id) => byId[id] || id).sort();
}

// The frame per test: server, scenario, fake docker, stage cap of one hour, a spy as state wakeup (afterwards wakeProject as in
// server.js). At the end: every gate open, every cap expired, the run finished — only THEN the row gone (a still running
// setter would create it anew), and no row stays in a working state (the harness's quiet wait would wait on it).
async function frame(fn) {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const called = [];
    const runs = [];
    const oldCap = process.env.CBASE_PROJECT_STAGE_MS;
    process.env.CBASE_PROJECT_STAGE_MS = "3600000";
    setStateWakeup((pid, x) => called.push({ pid, ...x }));
    try {
      await withOps(fd, () => fn({ s, fd, called, run: (p) => { runs.push(p); return p; } }));
    } finally {
      // A run that is still alive after a failure is brought to its end — every gate it waits on opens, every stage cap
      // expires through the clock seam until it is done (like the settle helper in projectbox-restore.test.js; a later stage
      // reaches its gate only after the earlier one). Without a failure nothing is open and it is a glance. Not a criterion
      // of the test — only cleanup, in operation (outside, the docker seam would refuse every call).
      let open = true;
      const all = Promise.allSettled(runs).then(() => { open = false; });
      await withOps(fd, async () => {
        const gates = path.join(fd.dir, "gates");
        while (open) {
          for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) if (f.endsWith(".waiting")) fd.openGate(decodeURIComponent(f.slice(0, -".waiting".length)));
          advanceStagesCap();
          await Promise.race([all, new Promise((r) => setTimeout(r, 10))]);
        }
      });
      setStateWakeup(wakeProject);
      if (oldCap === undefined) delete process.env.CBASE_PROJECT_STAGE_MS; else process.env.CBASE_PROJECT_STAGE_MS = oldCap;
      store.deleteProjectInstance(s.projectId);
      fd.cleanUp();
    }
  });
}

const STACK = [
  { name: "hf-db-1", service: "db", healthy: true },
  { name: "hf-app-1", service: "app", healthy: true, dependsOn: "db:service_healthy:false" },
];

test("(1) at the entry: no working state => TypeError, row in another state or gone => InstanceFailed — nothing set, no docker", async () => {
  await frame(async ({ s, fd, called }) => {
    const { name, cid } = projectWithStack(fd, s, STACK, "ready");
    // The project container is stopped: without an entry check the run would end at the first `exec` (instead of hanging on a
    // stage gate) — the counter-test turns red, not silent.
    dx(fd, "stop", name);
    const prior = store.projectInstance(s.projectId);
    const calls = fd.calls().length;
    for (const state of ["ready", "error", "nonsense", undefined]) {
      await assert.rejects(runInstanceUp(s.projectId, prior, { containerId: cid, desired: prior.desired, state }), TypeError, String(state));
    }
    // The row is in `ready`, the caller names `relocation`: the first phase write would be a transition.
    await assert.rejects(runInstanceUp(s.projectId, prior, { containerId: cid, desired: prior.desired, state: "relocation" }),
      (e) => e instanceof InstanceFailed && /is in "ready", not in "relocation"/.test(e.message));
    assert.deepEqual(store.projectInstance(s.projectId), prior, "the row changed");
    // Without a row: none is created (the setter would create it).
    const foreign = { ...prior, projectId: `${s.projectId}-fort`, identifier: `${s.projectId}-gone/main` };
    await assert.rejects(runInstanceUp(foreign.projectId, foreign, { containerId: cid, desired: prior.desired, state: "start" }), InstanceFailed);
    assert.equal(store.projectInstance(foreign.projectId), null, "a row was created");
    assert.equal(fd.calls().length, calls, "a docker call despite the refusal");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(called, [], "the state wakeup was called");
  });
});

test("(2) stages, services, names in `relocation`: only phases, never a transition — no wakeup, no occupancy, no procedure, snapshot untouched", async () => {
  await frame(async ({ s, fd, called, run }) => {
    const { name, cid, idOf } = projectWithStack(fd, s, STACK, "relocation");
    const prior = store.projectInstance(s.projectId);
    const p = run(runInstanceUp(s.projectId, prior, { containerId: cid, desired: prior.desired, state: "relocation" }));
    const atGate = (phase) => {
      const z = store.projectInstance(s.projectId);
      assert.equal(z.state, "relocation");
      assert.equal(z.phase, phase);
      assert.equal(z.stateSince, 1, "a state change (also a round trip) stamps state_since");
      assert.equal(projectOccupied(s.projectId), null, "the project is occupied");
      assert.equal(procedureAlive(s.projectId, "main"), false, "a procedure is alive");
    };

    await fd.gateReached("healthy-hf-db-1");
    atGate("stage 1/2");
    assert.deepEqual(started(fd, name, idOf), ["hf-db-1"], "stage 1 — and nothing after it");
    fd.openGate("healthy-hf-db-1");

    await fd.gateReached("healthy-hf-app-1");
    atGate("stage 2/2");
    assert.deepEqual(started(fd, name, idOf), ["hf-app-1", "hf-db-1"], "stage 2 only after stage 1 is healthy");
    fd.openGate("healthy-hf-app-1");

    { const { findings, notices } = await p; assert.deepEqual({ findings, notices }, { findings: [], notices: [] }); } // `liveness` is the input for the liveness check, not a result
    atGate("names");
    const after = store.projectInstance(s.projectId);
    assert.equal(after.error, "");
    assert.deepEqual(after.desired, prior.desired, "the caller writes the snapshot");
    assert.equal(after.containerId, prior.containerId);
    assert.equal(fd.calls({ daemon: "host" }).some((a) => a.args[0] === "start"), false, "the caller starts the project container");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(called, [], "the state wakeup was called");
  });
});

test("(3) a stopped project container => InstanceFailed — the row stays in its state, no wakeup", async () => {
  await frame(async ({ s, fd, called, run }) => {
    const { name, cid } = projectWithStack(fd, s, STACK, "start");
    dx(fd, "stop", name);
    const prior = store.projectInstance(s.projectId);
    await assert.rejects(run(runInstanceUp(s.projectId, prior, { containerId: cid, desired: prior.desired, state: "start" })), InstanceFailed);
    const z = store.projectInstance(s.projectId);
    assert.equal(z.state, "start", "runInstanceUp wrote a transition");
    assert.equal(z.stateSince, 1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(called, []);
  });
});
