// The observer of the project containers (projectbox/resumption.js, the mark "cbase stops itself" and dockerStream in
// projectbox/docker.js, the `docker events` stream in fake-docker.mjs).
//
// What holds here:
//   (U)  The verdict on an event (resumptionVerdict) and the pauses of the restart as tables; the knob CBASE_PROJECT_DESIRED_MS
//        (default 60 s, 0 = off, anything else the default).
//   (M)  The mark "cbase stops itself": docker() notes `stop`/`rm`/`kill`/`restart` (also `container <verb>`) BEFORE the child, by
//        name or id (id also as prefix, from 12 characters), not the values of `-t`/`-s`; `inspect` notes nothing; without the ops
//        mark no mark; forgotten only what is not younger; capped (the oldest falls). dockerStream without the ops mark THROWS
//        (NO_OPS) before a child starts.
//   (1)  A project container ends BEHIND cbase's back ⇒ the row goes to `start` (event `project/instance`), the container is started
//        if it stands, and the desired reconcile starts the inner containers with desired `running` — not those with desired
//        `exited`; then `ready`. Three ways: (1a) OOM, the daemon restarts it (oom + die + start, no `docker start` from cbase);
//        (1b) `docker stop` by hand (kill + die + stop — exactly ONE `docker start`); (1c) only the `start` arrives (the `die` fell
//        into a gap). A second event of the same life triggers no second one. (1d) Without a valid assignment nothing: a helper (even
//        with a project label), a foreign name, a row without `converted_at`, a container without a row.
//   (2)  cbase's OWN stops trigger NOTHING: (2a) the stop chain of the server end WITHOUT serverEnds() set — the rows stand `ready`,
//        the mark alone holds (also in the reconcile after a restart of the stream and in the tick); (2b) the server end through the
//        hook chain: serverEnds(), and then the stream ends (hook after "projectbox"); (2c) the recreate (stop + rm of the old
//        container, run of the new) — mark AND state `recreate`.
//   (3)  The tick rewrites the desired state (`written`, then `equal` without writing); a container whose inside is not readable keeps
//        its desired state (`not-readable`); an empty read replaces no non-empty desired state (`empty`); an event of the life DURING
//        the read leaves it (`unquiet`), a row that changes its state during the read too (`moved`); via the timer
//        (CBASE_PROJECT_DESIRED_MS small).
//   (4)  The stream ends unexpectedly ⇒ restart (clock seam advanceRestart) with `--since`, then a reconcile: (4a) a container that
//        ended without an event starts again (reconcile); (4b) a `die` in the gap arrives via `--since` (the container already runs
//        again), exactly ONE restart of it — triggered by the event or by the reconcile via StartedAt, whichever comes first under
//        load; the other sees the row in `start`; (4c) restarted silently (neither `die` nor `start` arrived): `State.StartedAt`
//        younger than the row's `ready` ⇒ the tick writes no desired state from the crash but triggers the resumption, and so does
//        the reconcile.
//   (5)  Without the ops mark: no child process, no docker call — neither via resumptionRestartGrace nor via the whole hook chain
//        "restartGrace" nor in the tick. With the ops mark "project-resumption" is the LAST consumer of "restartGrace" and starts the
//        stream; `close` of the server ends it.
//   (6)  A no for a temporary reason (occupancy) is remembered and looked up at the next tick ⇒ resumption.
//   (7)  (a) A crash with restart in the middle of the start sequence (phase "services"): no snapshot from the fresh dockerd — the
//        restore runs through once more, the desired state stays {db, app: running}, then exactly one resumption. (b) An unmarked
//        `die` DURING a living procedure is remembered (with the event time); after the procedure the tick looks up: the container
//        has restarted since ⇒ resumption. (c) If the store read throws in the tick (database locked), the round does not reject: the
//        process lives, the entry stays, the next tick is scheduled (in a child process with a locked database; the `.catch` chained
//        to desiredTickRound is the second layer). (d) The mark of a FAILED stop expires: a later manual stop of the still running
//        container is a resumption again; that of a successful one never; within the deadline it holds. (e) The copy path: a manual
//        stop of the copy restores exactly this instance, the main keeps its `stateSince`; the reconcile brings back a silently ended
//        copy; the tick sees the copy.
//   (8)  Server end during a restore: (a) in the middle of the start sequence the stop chain stops the project container — no second
//        pass, no docker start, the row ends in `error`; (b) if it already stands it is not started in the ending server; (c) if the
//        daemon restarts it itself the start sequence still does not run again.
//   (9)  The foreign mark b-ends (the gateway) in a B that lives on: a `die` with reason serverEnd is remembered; while the mark holds
//        the tick triggers nothing; after its expiry the container starts again — exactly one docker start.
//  (10)  A crash with restart in a restore the observer did not trigger: after the confirmed `ready` the tick triggers no second
//        resumption.
//  (11)  The route of the snapshot for the gateway.
//  The guard of the stop places is held by projectbox-stop-places.test.js.
//
// Wait only for events and states (waitForTruthy without deadline, gates of the fake docker, the clock seam of the restart), and for
// one that occurs WITH and WITHOUT a resumption (the verdict on the triggering event, a marker in the stream, the quiet of the
// reconcile) — a sabotage turns red instead of hanging silently. The tick stands at 0 (off) except in (3), the stage cap is set high
// (an hour); in (3) the creation cap is small (see there).
//
// COUNTER-PROBES (one sabotage at a time, the whole file run, each red WITHOUT a hang):
//   docker.js: rememberSelfStopped in docker() removed                          ⇒ (M), (2a), (2c) red
//   docker.js: every mark renewed at every call (the youngest counts)           ⇒ (2c) red (the `rm` after the `stop` moved the mark
//                                                                                 behind the `die` — why the OLDEST mark counts)
//   docker.js: dockerStream without the ops-mark check                          ⇒ (M) red
//   resumption.js: no reconcile after the (re)start of the stream               ⇒ (2a), (4a), (4c) red
//   resumption.js: restart without `--since`                                    ⇒ (4a), (4b) red
//   resumption.js: tick without comparing StartedAt/events before-after         ⇒ (3) red ("unquiet")
//   resumption.js: an empty read replaces a non-empty desired state             ⇒ (3) red ("empty")
//   resumption.js: tick without a second look at the row after the read         ⇒ (3) red ("moved")
//   resumption.js: silent restart never recognised                              ⇒ (4c) red
//   resumption.js: a temporary no is not remembered                             ⇒ (6) red
//   resumption.js: verdict without `stale`                                      ⇒ (U), (1a), (1b), (1d), (2a), (3), (4a–c) red
//   resumption.js: verdict without occupancy                                    ⇒ (U), (6) red
//   resumption.js: helper not skipped                                           ⇒ (1d) red
//   server.js: registration of "project-resumption" at "restartGrace" removed   ⇒ (5) red
//   server.js: registration of "project-resumption" at "serverEnd" removed      ⇒ (2b) red
//   server.js: `close` without stopResumption                                   ⇒ (5) red
//   restore.js: checkLiveness does nothing                                      ⇒ (7a) red (the desired state comes from the fresh dockerd)
//   resumption.js: an unmarked die during a living procedure is not remembered  ⇒ (7b) red
//   resumption.js: the look-up without event time                               ⇒ (7b) red
//   resumption.js: catch-up iteration without try/catch                         ⇒ (7c) red (entry gone, no message)
//   docker.js: expireSelfStopped never takes anything back                      ⇒ (7d) red
//   docker.js: a failed call does not mark its marks                            ⇒ (7d) red
//   resumption.js: the instance fixed to the main instead of the label          ⇒ (7e) red (copies never restart)
//   resumption.js: reconcile only for the main instance                         ⇒ (7e) red (the silently ended copy stays gone)
//   restore.js: second pass in the ending server not prevented                  ⇒ (8)(c) red
//   restore.js: docker start / thawOut in the ending server not prevented       ⇒ (8)(a)/(b) red
//   resumption.js: `serverEnd` not among the temporary reasons                  ⇒ (9) red
//   resumption.js: look-up without livenessConfirmed                            ⇒ (10) red
//   restore.js: checkLiveness does not record the confirmed life                ⇒ (10) red
//   relocation/routes.js: route branch removed                                  ⇒ (11) red (404 in ops)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { procedureAlive, setInstanceState, withProcedure } from "../electron/server/projectbox/instances.js";
import { createInstance, withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { recreateStatus, earmarkRecreate, setCreationOptions } from "../electron/server/projectbox/recreate.js";
import { projectboxServerEnd, desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { setNativeServicesStarter, restoreInstance, advanceStagesCap } from "../electron/server/projectbox/restore.js";
import { SELF_CAP, SELF_DEADLINE_MS, docker, dockerStream, expireSelfStopped, selfStoppedSince, forgetSelfStopped, advanceSelfClock } from "../electron/server/projectbox/docker.js";
import {
  RESTART_PAUSES_MS, DESIRED_TICK_MS, restartPauseMs, advanceRestart, desiredTickMs, desiredTickRound, resumptionRestartGrace,
  resumptionQuiet, resumptionStatus, stopResumption, resumptionVerdict,
} from "../electron/server/projectbox/resumption.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { B_ENDS_AGE_MS, B_ENDS_MARKER, bEndsOwnerForTest, serverEndMarkerForTest, serverEnds } from "../electron/server/runs/server-end.js";
import { withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { ID, withOps, scenario } from "./projectbox-scenario.mjs";

// ── (U) tables ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(U) resumptionVerdict as a table: every reason in its order; a start does not see the mark; a mark younger than the die does not count", () => {
  const z = (x = {}) => ({ projectId: "p", instance: "main", state: "ready", stateSince: 1_000, convertedAt: 1, ...x });
  const gut = { row: z(), nameMatches: true, ends: false, selfSince: null, procedure: false, frozen: false, occupied: false };
  const die = { action: "die", time: 2_000 };
  const cases = [
    [die, { ...gut, row: null }, "no-row"],
    [die, { ...gut, row: z({ convertedAt: null }) }, "not-converted"],
    [die, { ...gut, nameMatches: false }, "foreign-name"],
    [die, { ...gut, ends: true, selfSince: 1_500 }, "serverEnd"],
    [die, { ...gut, selfSince: 1_500 }, "self-stopped"],
    [die, { ...gut, selfSince: 2_000 }, "self-stopped"],
    [{ action: "die" }, { ...gut, selfSince: 1_500 }, "self-stopped"], // without time: the mark counts
    [die, { ...gut, selfSince: 2_500 }, "end"], // mark YOUNGER than the die: it was not cbase
    [die, { ...gut, selfSince: 1_500, row: z({ state: "recreate" }) }, "self-stopped"], // the mark first
    [die, { ...gut, row: z({ state: "start" }) }, "state-start"],
    [die, { ...gut, row: z({ state: "clearAway" }) }, "state-clearAway"],
    [die, { ...gut, row: z({ stateSince: 3_000 }) }, "stale"],
    [die, { ...gut, procedure: true }, "procedure"],
    [die, { ...gut, frozen: true }, "frozen"],
    [die, { ...gut, occupied: true }, "occupied"],
    [die, gut, "end"],
    [{ action: "start", time: 2_000 }, { ...gut, selfSince: 1_500 }, "start"],
    [{ action: "start", time: 500 }, gut, "stale"],
  ];
  for (const [e, situation, reason] of cases) {
    const u = resumptionVerdict(e, situation);
    assert.equal(u.reason, reason, `${JSON.stringify(e)} ${JSON.stringify({ ...situation, row: situation.row && { state: situation.row.state, stateSince: situation.row.stateSince, convertedAt: situation.row.convertedAt } })}`);
    assert.equal(u.yes, reason === "end" || reason === "start");
  }
});

test("(U) restart pauses grow and are capped; CBASE_PROJECT_DESIRED_MS: default 60 s, 0 = off, nonsense = default", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 99].map(restartPauseMs), [1_000, 5_000, 15_000, 60_000, 60_000, 60_000]);
  assert.equal(restartPauseMs(-3), RESTART_PAUSES_MS[0]);
  assert.equal(restartPauseMs("x"), RESTART_PAUSES_MS[0]);
  const saved = process.env.CBASE_PROJECT_DESIRED_MS;
  try {
    for (const [raw, desired] of [[undefined, DESIRED_TICK_MS], ["", DESIRED_TICK_MS], ["0", 0], ["250", 250], ["-1", DESIRED_TICK_MS], ["1.5", DESIRED_TICK_MS], ["abc", DESIRED_TICK_MS]]) {
      if (raw === undefined) delete process.env.CBASE_PROJECT_DESIRED_MS; else process.env.CBASE_PROJECT_DESIRED_MS = raw;
      assert.equal(desiredTickMs(), desired, `"${raw}"`);
    }
  } finally {
    if (saved === undefined) delete process.env.CBASE_PROJECT_DESIRED_MS; else process.env.CBASE_PROJECT_DESIRED_MS = saved;
  }
});

// ── environment ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The environment of a test in ops mode (shape of projectbox-restore.test.js): the marks of projectbox-scenario.mjs, the stage cap
// set high, the root of the network mark, the tick OFF (a test calls desiredTickRound itself) and the recreate's check-back beat
// small. `values` wins. At the end, STILL in ops mode: the observer ends, and if a restore is still alive (a failure in the middle
// of it) it is carried to its end — cleanup only.
async function inOps(fd, s, fn, values = {}) {
  const desired = { CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s?.root, CBASE_PROJECT_DESIRED_MS: "0", CBASE_RECREATE_CHECK_BACK_MS: "100", ...values };
  const saved = Object.fromEntries(Object.keys(desired).map((x) => [x, process.env[x]]));
  try {
    for (const [x, v] of Object.entries(desired)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
    return await withOps(fd, async () => {
      try { return await fn(); } finally {
        stopResumption("test end");
        await carryOut(fd);
        await resumptionQuiet();
      }
    }, values);
  } finally {
    for (const [x, v] of Object.entries(saved)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
  }
}

async function carryOut(fd) {
  const alive = () => store.projectInstances().some((z) => procedureAlive(z.projectId, z.instance));
  while (alive()) {
    const gates = path.join(fd.dir, "gates");
    for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) {
      if (f.endsWith(".waiting")) fd.openGate(decodeURIComponent(f.slice(0, -".waiting".length)));
    }
    advanceStagesCap();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function cleanUpRows() {
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
    try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[resumption] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const projectContainer = (pid) => `cbase-p-${pid}`;

// The inner stack: db and app run, migrate is finished (desired `exited`).
const STACK = [
  { name: "a-db-1", service: "db" },
  { name: "a-migrate-1", service: "migrate", dependsOn: "db", finished: true },
  { name: "a-app-1", service: "app", dependsOn: "db" },
];

// A converted project whose project container RUNS, with an inner stack; the desired state from the running stack, the row `ready`
// (created AFTER the container: its `create`/`start` is `stale` for the observer). `stack: []`: no stack, `desired` gives the
// desired state. `instance`: "copy-<name>" creates the container of a COPY (`cbase-k-<pid>-<name>`, label cbase.instance) with a
// copy row.
function projectRunning(fd, s, { stack = STACK, desired: desiredDefault = null, instance = "main" } = {}) {
  const name = instance === "main" ? projectContainer(s.projectId) : `cbase-k-${s.projectId}-${instance.slice("copy-".length)}`;
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "--label", `cbase.instance=${instance}`, "cbase-projectbox:latest");
  for (const c of stack) {
    const args = ["exec", name, "docker", "run", "-d", "--name", c.name, "--label", "com.docker.compose.project=a", "--label", `com.docker.compose.service=${c.service}`];
    if (c.dependsOn) args.push("--label", `com.docker.compose.depends_on=${c.dependsOn}`);
    dx(fd, ...args, "img");
    if (c.finished) dx(fd, "exec", name, "docker", "stop", c.name);
  }
  const ids = stack.length ? dx(fd, "exec", name, "docker", "ps", "-aq", "--no-trunc").split("\n").filter(Boolean) : [];
  const inspect = ids.length ? JSON.parse(dx(fd, "exec", name, "docker", "inspect", ...ids)) : [];
  const desired = desiredDefault || desiredFromInspect(inspect);
  store.createProjectInstance({ projectId: s.projectId, instance, state: "ready", convertedAt: Date.now(), containerId: cid, desired, ...(instance === "main" ? {} : { copyName: instance.slice("copy-".length), chatId: "c-rp95" }) });
  toreForget(fd);
  return { name, cid, idOf: Object.fromEntries(inspect.map((c) => [c.Name.replace(/^\//, ""), c.Id])) };
}

// The `.waiting` marks no longer count: the fake docker sets them at an OPEN gate too — a gate is reached only when the product
// stands before it again after the forgetting.
function toreForget(fd) {
  const gates = path.join(fd.dir, "gates");
  for (const f of fs.existsSync(gates) ? fs.readdirSync(gates) : []) if (f.endsWith(".waiting")) fs.rmSync(path.join(gates, f));
}

// Which inner containers have been started since `ab` (index in the log), by name.
function startedSince(fd, name, idOf, start = 0) {
  const byId = Object.fromEntries(Object.entries(idOf).map(([n, id]) => [id, n]));
  return fd.calls().slice(start).filter((a) => a.daemon === name && a.args[0] === "start").flatMap((a) => a.args.slice(1)).map((id) => byId[id] || id).sort();
}
const hostStarts = (fd, mark = 0) => fd.calls().slice(mark).filter((a) => a.daemon === "host" && a.args[0] === "start").map((a) => a.args);
const states = (desired) => Object.fromEntries((desired?.container || []).map((c) => [c.name, c.state]));
const verdictsOf = (name) => resumptionStatus().verdicts.filter((u) => u.name === name);

// Start the observer and wait until its stream runs and the first reconcile is through.
async function observerOn(fd) {
  assert.equal(resumptionRestartGrace(), undefined, "the consumer must not hold the quiet");
  await waitForTruthy(() => fd.streams().length === 1, "stream runs");
  await resumptionQuiet();
}

// End the stream hard, wait for the scheduled restart and bring it forward through the clock seam (if the pause is already over, it
// ran by itself — same result); afterwards a new stream runs and its reconcile is through. → the state at scheduling.
async function streamNew(fd) {
  assert.equal(fd.endStreams(), 1);
  const scheduled = await waitForTruthy(() => { const x = resumptionStatus(); return x.restartScheduled ? x : null; }, "restart scheduled");
  advanceRestart();
  await waitForTruthy(() => fd.streams().length === 1, "new stream");
  await resumptionQuiet();
  return scheduled;
}

// A reader of the global stream (/api/events) — shape of projectbox-restore.test.js.
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
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
const stateFollowUp = (reader, pid) => reader.events.filter((e) => e.type === "project/instance" && e.projectId === pid).map((e) => e.state);

// ── (M) The mark "cbase stops itself" and dockerStream ─────────────────────────────────────────────────────────────

test("(M) docker() notes stop/rm/kill/restart BEFORE the child (name, id also as prefix; not the values of -t/-s; not inspect); forgets only older ones; capped; without ops neither mark nor child", async () => {
  const fd = await fakeDocker();
  try {
    // Without the ops mark: NO_OPS, no mark, no child.
    await assert.rejects(docker(["stop", "m-without-ops"]), { code: "NO_OPS" });
    assert.equal(selfStoppedSince("m-without-ops"), null);
    assert.throws(() => dockerStream(["events", "--format", "{{json .}}"], {}), { code: "NO_OPS" });
    assert.deepEqual(fd.calls(), [], "a docker call without ops");
    await withOps(fd, async () => {
      const id = dx(fd, "run", "-d", "--name", "m-one", "--label", "cbase.project=m", "img");
      assert.match(id, /^[0-9a-f]{64}$/);
      const before = Date.now();
      await docker(["stop", "-t", "30", id.slice(0, 12)]);
      const t = selfStoppedSince(id);
      assert.ok(t !== null && t >= before, "the full id does not hit the mark of the prefix");
      assert.equal(selfStoppedSince(id.slice(0, 16)), t, "a longer prefix does not hit");
      // A second call (the `rm` after the `stop`) does not move the mark: the OLDEST counts.
      await docker(["rm", "-f", id]);
      assert.equal(selfStoppedSince(id), t, "the rm moved the mark of the stop");
      assert.equal(selfStoppedSince("m-one"), null, "the name was not mentioned");
      assert.equal(selfStoppedSince("30"), null, "the value of -t is no container");
      await assert.rejects(docker(["container", "rm", "-f", "m-one"])); // the fake docker does not know `container` — the mark stands before
      assert.notEqual(selfStoppedSince("m-one"), null, "`container rm` does not note");
      await assert.rejects(docker(["kill", "-s", "KILL", "m-two"])); // does not exist — the mark stands anyway (BEFORE the child)
      assert.notEqual(selfStoppedSince("m-two"), null);
      assert.equal(selfStoppedSince("KILL"), null);
      await assert.rejects(docker(["restart", "--time", "3", "m-three"]));
      assert.notEqual(selfStoppedSince("m-three"), null);
      assert.equal(selfStoppedSince("3"), null);
      await assert.rejects(docker(["inspect", "m-four"]));
      assert.equal(selfStoppedSince("m-four"), null, "inspect notes");
      // Forgetting: only marks that are not younger than the limit.
      assert.equal(forgetSelfStopped(["m-two"], selfStoppedSince("m-two") - 1), 0);
      assert.equal(forgetSelfStopped(["m-two"]), 1);
      assert.equal(selfStoppedSince("m-two"), null);
      assert.equal(forgetSelfStopped([id.slice(0, 12)]), 2, "the prefix does not hit the mark of the full id");
      assert.equal(selfStoppedSince(id), null);
      // The cap: one call with SELF_CAP + 1 names — the oldest falls.
      const many = Array.from({ length: SELF_CAP + 1 }, (_, i) => `m-cap-${i}`);
      await assert.rejects(docker(["rm", "-f", ...many]));
      assert.equal(selfStoppedSince(many[0]), null, "grew over the cap");
      assert.notEqual(selfStoppedSince(many.at(-1)), null);
      forgetSelfStopped(many);
    });
  } finally {
    fd.cleanUp();
  }
});

// ── (1) End behind cbase's back ─────────────────────────────────────────────────────────────────────────────────────

for (const [fall, description] of [
  ["oom", "(1a) OOM, the daemon restarts it (oom + die + start): the row goes to start, NO docker start from cbase, the desired reconcile starts db and app, not migrate; ready"],
  ["hand", "(1b) docker stop by hand (kill + die + stop, the inner dockerd ends with it): the row goes to start, EXACTLY ONE docker start, db and app run again, migrate not; ready"],
  ["onlyStart", "(1c) only the start arrives (the die fell into a gap): the same way, without a docker start from cbase"],
]) {
  test(description, async () => {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
      const reader = await globalReaderFor(ctx.base);
      try {
        await inOps(fd, s, async () => {
          await observerOn(fd);
          const prior = resumptionStatus();
          const { name, cid, idOf } = projectRunning(fd, s);
          const rowPrior = store.projectInstance(s.projectId);
          // Waiting is on the VERDICT on the triggering event (it arises with and without resumption — a sabotage turns red instead
          // of hanging silently); the `start` of the seeding must already be judged for that.
          const trigger = fall === "onlyStart" ? "start" : "die";
          await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
          const n0 = verdictsOf(name).filter((u) => u.action === trigger).length;
          const mark = fd.calls().length;
          if (fall === "oom") fd.crash(name, { oom: true, restart: true });
          else if (fall === "hand") dx(fd, "stop", name);
          else { fd.crash(name, { silent: true, restart: true }); fd.event(name, "start"); }
          await waitForTruthy(() => verdictsOf(name).filter((u) => u.action === trigger).length > n0, `the ${trigger} is at the observer`);
          await resumptionQuiet();
          assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, `no resumption: ${JSON.stringify(verdictsOf(name))}`);
          const z = store.projectInstance(s.projectId);
          assert.equal(z.state, "ready", JSON.stringify(z));
          assert.equal(z.error, "", z.error);
          assert.ok(z.stateSince > rowPrior.stateSince, "the row did not move");
          await waitForTruthy(() => stateFollowUp(reader, s.projectId).includes("ready"), "ready in the stream");
          const followUp = stateFollowUp(reader, s.projectId);
          assert.ok(followUp.indexOf("start") >= 0 && followUp.indexOf("start") < followUp.lastIndexOf("ready"), `sequence ${followUp.join(" → ")}`);
          assert.deepEqual(startedSince(fd, name, idOf, mark), ["a-app-1", "a-db-1"], "the desired reconcile");
          assert.deepEqual(hostStarts(fd, mark), fall === "hand" ? [["start", cid]] : [], "docker start of the project container");
          assert.deepEqual(states(z.desired), { "a-db-1": "running", "a-migrate-1": "exited", "a-app-1": "running" });
          await resumptionQuiet();
          assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, "a second resumption from the same life");
          const yes = verdictsOf(name).filter((u) => u.yes);
          assert.deepEqual(yes.map((u) => u.reason), [fall === "onlyStart" ? "start" : "end"]);
          if (fall === "oom") assert.equal(yes[0].exitCode, "137");
        });
      } finally {
        await reader.shutdown();
        cleanUpRows();
        fd.cleanUp();
      }
    });
  });
}

test("(1d) Without a valid assignment nothing: a helper (even with a project label), a foreign name, an unconverted project, a container without a row — no resumption, no docker start", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const s2 = scenario(ctx);
    const s3 = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        projectRunning(fd, s, { stack: [] });
        projectRunning(fd, s3, { stack: [] });
        store.changeProjectInstance(s3.projectId, "main", { convertedAt: null });
        const helper = `cbase-h-${s.projectId}`;
        const foreign = `foreign-${s.projectId}`;
        const withoutRow = projectContainer(s2.projectId);
        const not = projectContainer(s3.projectId);
        dx(fd, "run", "-d", "--name", helper, "--label", `cbase.project=${s.projectId}`, "--label", "cbase.helper=relocation", "img");
        dx(fd, "run", "-d", "--name", foreign, "--label", `cbase.project=${s.projectId}`, "img");
        dx(fd, "run", "-d", "--name", withoutRow, "--label", `cbase.project=${s2.projectId}`, "img");
        const mark = fd.calls().length;
        for (const w of [helper, foreign, withoutRow, not]) fd.crash(w);
        await waitForTruthy(() => verdictsOf(not).some((u) => u.action === "die"), "the last die is at the observer");
        await resumptionQuiet();
        const die = (n) => verdictsOf(n).filter((u) => u.action === "die").map((u) => u.reason);
        assert.deepEqual(verdictsOf(helper), [], "a helper was judged");
        assert.deepEqual(die(foreign), ["foreign-name"]);
        assert.deepEqual(die(withoutRow), ["no-row"]);
        assert.deepEqual(die(not), ["not-converted"]);
        assert.equal(resumptionStatus().resumptions, prior.resumptions);
        assert.deepEqual(hostStarts(fd, mark), []);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (2) cbase's own stops ───────────────────────────────────────────────────────────────────────────────────────────

test("(2a) The stop chain of the server end WITHOUT serverEnds(): the row stands ready, the mark alone holds — in the event, in the reconcile after a restart of the stream and in the tick; no docker start", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name } = projectRunning(fd, s);
        const mark = fd.calls().length;
        const r = await projectboxServerEnd();
        assert.equal(r.stopped.length, 1, JSON.stringify(r));
        assert.equal(dx(fd, "inspect", "--format", "{{.State.Status}}", name), "exited");
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die"), "the die is at the observer");
        assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["self-stopped"]);
        // A restart of the stream: the reconcile finds the standing container — marked, so nothing.
        await streamNew(fd);
        assert.ok(verdictsOf(name).some((u) => u.action === "reconcile" && u.reason === "self-stopped"), JSON.stringify(verdictsOf(name)));
        // And the tick: "stands", nothing triggered.
        const tick = await desiredTickRound();
        assert.equal(tick[store.instanceIdentifier(s.projectId, "main")], "stands");
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions, prior.resumptions, "cbase's own stop triggered a resumption");
        assert.deepEqual(hostStarts(fd, mark), []);
        assert.equal(store.projectInstance(s.projectId).state, "ready");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(2b) The server end through the hook chain: serverEnds() set, \"projectbox\" stops, then \"project-resumption\" — the stream ends, no resumption", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    const followUp = [];
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name } = projectRunning(fd, s);
        const mark = fd.calls().length;
        observeHooks((info) => { if (info.kind === "serverEnd" && info.phase === "start") followUp.push(info.name); });
        serverEndMarkerForTest(true);
        await fireHooks("serverEnd", {});
        const iP = followUp.indexOf("projectbox");
        const iW = followUp.indexOf("project-resumption");
        assert.ok(iP >= 0 && iW > iP, `order ${followUp.join(", ")}`);
        assert.equal(dx(fd, "inspect", "--format", "{{.State.Status}}", name), "exited", "the stop chain did not run");
        assert.equal(resumptionStatus().running, false, "the observer lives after the server end");
        await waitForTruthy(() => fd.streams().length === 0, "the stream ends");
        await desiredTickRound(); // ends: no tick
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions, prior.resumptions);
        assert.deepEqual(hostStarts(fd, mark), []);
        for (const u of verdictsOf(name).filter((x) => x.action === "die")) assert.equal(u.reason, "serverEnd");
      });
    } finally {
      observeHooks(null);
      serverEndMarkerForTest(false);
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(2c) The recreate (stop + rm of the old container, run of the new, restore) triggers no resumption", async () => {
  const options = new Map();
  setCreationOptions((pid) => options.get(pid) || {});
  let fd = null;
  try {
    await withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID, "cbase-projectbox:new": "5e".repeat(32) }, programs: s.programs, stopsInside: true });
      const pid = s.projectId;
      try {
        await inOps(fd, s, async () => {
          await observerOn(fd);
          const prior = resumptionStatus();
          options.set(pid, s.opts);
          assert.equal((await createInstance(pid, s.opts)).state, "ready");
          store.changeProjectInstance(pid, "main", { convertedAt: Date.now() });
          const name = projectContainer(pid);
          const oldId = dx(fd, "inspect", "--format", "{{.Id}}", name);
          dx(fd, "tag", "cbase-projectbox:new", "cbase-projectbox:latest");
          const mark = fd.calls().length;
          assert.equal(earmarkRecreate(pid, { reason: "Test" }), true);
          await ctx.waitForQuiet();
          await waitForTruthy(() => !recreateStatus(pid).earmarked && !recreateStatus(pid).active, "recreate done");
          await ctx.waitForQuiet();
          const host = fd.calls().slice(mark).filter((a) => a.daemon === "host").map((a) => a.args);
          assert.deepEqual(host.filter((a) => a[0] === "stop"), [["stop", "-t", "30", oldId]], "no recreate");
          const newId = dx(fd, "inspect", "--format", "{{.Id}}", name);
          assert.notEqual(newId, oldId);
          await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die" && u.id === oldId), "the die of the old container is at the observer");
          await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start" && u.id === newId), "the start of the new container is at the observer");
          await resumptionQuiet();
          assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["self-stopped"]);
          assert.equal(resumptionStatus().resumptions, prior.resumptions, `resumption after the recreate: ${JSON.stringify(verdictsOf(name))}`);
          assert.equal(store.projectInstance(pid).state, "ready");
        });
      } finally {
        cleanUpRows();
      }
    });
  } finally {
    setCreationOptions(null);
    fd?.cleanUp();
  }
});

// ── (3) The tick ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) tick: rewrites the desired state (then equal, without writing); not readable and empty leave the old one; an event during the read too; via the timer", async () => {
  await withAgentsServer(async (ctx) => {
    const s1 = scenario(ctx);
    const s2 = scenario(ctx);
    const s3 = scenario(ctx);
    const broken = projectContainer(s2.projectId);
    const fd = await fakeDocker({ programs: s1.programs, execBroken: [broken], inspectGate: "inside" });
    try {
      await inOps(fd, s1, async () => {
        await observerOn(fd);
        fd.openGate("inside"); // the seeding reads via `exec … docker inspect`
        const { name } = projectRunning(fd, s1);
        const oldDesired = { time: 1, container: [{ name: "x-1", id: "e".repeat(64), service: "x", project: "x", state: "running", exitCode: 0, dependsOn: "" }], services: [] };
        projectRunning(fd, s2, { stack: [], desired: oldDesired });
        projectRunning(fd, s3, { stack: [], desired: oldDesired });
        const k1 = store.instanceIdentifier(s1.projectId, "main");
        const k2 = store.instanceIdentifier(s2.projectId, "main");
        const k3 = store.instanceIdentifier(s3.projectId, "main");
        // The stack changes behind cbase's back: app stops, a new container runs.
        dx(fd, "exec", name, "docker", "stop", "a-app-1");
        dx(fd, "exec", name, "docker", "run", "-d", "--name", "a-new-1", "--label", "com.docker.compose.project=a", "--label", "com.docker.compose.service=new", "img");
        const prior = resumptionStatus();
        const r = await desiredTickRound();
        assert.deepEqual({ [k1]: r[k1], [k2]: r[k2], [k3]: r[k3] }, { [k1]: "written", [k2]: "not-readable", [k3]: "empty" });
        assert.deepEqual(states(store.projectInstance(s1.projectId).desired), { "a-db-1": "running", "a-migrate-1": "exited", "a-app-1": "exited", "a-new-1": "running" });
        assert.deepEqual(store.projectInstance(s2.projectId).desired, oldDesired, "an unreadable inside overwrote the desired state");
        assert.deepEqual(store.projectInstance(s3.projectId).desired, oldDesired, "an empty read replaced the desired state");
        assert.equal(resumptionStatus().desiredWritten - prior.desiredWritten, 1);
        const r2 = await desiredTickRound();
        assert.equal(r2[k1], "equal");
        assert.equal(resumptionStatus().desiredWritten - prior.desiredWritten, 1, "an unchanged desired state written again");

        // Unquiet: while the inside is read, an event of its life arrives (kill) — the desired state stays.
        const desiredBeforehand = store.projectInstance(s1.projectId).desired;
        dx(fd, "exec", name, "docker", "start", "a-app-1");
        fd.closeGate("inside");
        toreForget(fd);
        const run = desiredTickRound();
        await fd.gateReached("inside");
        const n = resumptionStatus().events;
        fd.event(name, "kill", { signal: "1" });
        await waitForTruthy(() => resumptionStatus().events > n, "the kill is at the observer");
        fd.openGate("inside");
        const r3 = await run;
        assert.equal(r3[k1], "unquiet");
        assert.deepEqual(store.projectInstance(s1.projectId).desired, desiredBeforehand, "the desired state of a container in motion was written");

        // Moved: while reading, the ROW goes to another state (here by hand to `start`) — the desired state stays.
        fd.closeGate("inside");
        toreForget(fd);
        const run2 = desiredTickRound();
        await fd.gateReached("inside");
        setInstanceState(s1.projectId, "main", "start");
        fd.openGate("inside");
        const r4 = await run2;
        assert.equal(r4[k1], "moved");
        assert.deepEqual(store.projectInstance(s1.projectId).desired, desiredBeforehand, "the desired state of a row that is no longer ready was written");
        setInstanceState(s1.projectId, "main", "ready");

        // Via the timer: the observer anew with a small tick — it writes what changed since (app runs again).
        stopResumption("small tick");
        process.env.CBASE_PROJECT_DESIRED_MS = "20";
        await observerOn(fd);
        assert.equal(resumptionStatus().tickMs, 20);
        await waitForTruthy(() => states(store.projectInstance(s1.projectId).desired)["a-app-1"] === "running", "the tick wrote");
        assert.ok(resumptionStatus().tickRounds > prior.tickRounds + 3);
        // The creation cap is SMALL here (2 s), not set high: no path of this test waits for it — only a resumption that must not
        // happen (a counter-probe) would run into the broken `exec` of s2 and otherwise hang for an hour at waiting for the inner
        // dockerd instead of turning red.
      }, { CBASE_PROJECTBOX_CREATION_MS: "2000" });
    } finally {
      fd.openGate("inside");
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (4) The stream ends ─────────────────────────────────────────────────────────────────────────────────────────────

test("(4a) stream ends ⇒ restart with --since and reconcile: a container that ended WITHOUT an event starts again — exactly one docker start", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, cid, idOf } = projectRunning(fd, s);
        fd.crash(name, { silent: true });
        const mark = fd.calls().length;
        const scheduled = await streamNew(fd);
        assert.equal(resumptionStatus().restarts - prior.restarts, 1);
        assert.equal(scheduled.nextPauseMs, RESTART_PAUSES_MS[1], "the pause does not grow");
        // streamNew waited for the reconcile and every triggered resumption.
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, `no resumption from the reconcile: ${JSON.stringify(verdictsOf(name))}`);
        const events = fd.calls().slice(mark).filter((a) => a.daemon === "host" && a.args[0] === "events");
        assert.equal(events.length, 1);
        assert.ok(events[0].args.includes("--since"), JSON.stringify(events[0].args));
        assert.equal(store.projectInstance(s.projectId).state, "ready");
        assert.deepEqual(hostStarts(fd, mark), [["start", cid]]);
        assert.deepEqual(startedSince(fd, name, idOf, mark), ["a-app-1", "a-db-1"]);
        assert.equal(resumptionStatus().streams - prior.streams, 1);
        assert.equal(resumptionStatus().reconcile - prior.reconcile, 1);
        assert.ok(verdictsOf(name).some((u) => u.action === "reconcile" && u.yes), JSON.stringify(verdictsOf(name)));
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(4b) A die in the gap between two streams arrives via --since (the container already runs again): exactly ONE resumption — from the event or from the reconcile, whichever comes first", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, idOf } = projectRunning(fd, s);
        // The observer has seen the seeding (otherwise the seen-until mark would lie before it, and --since would not reach back far enough).
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
        // Twice anew (the pause grows to 15 s — so the window in which the test sets the crash hangs on no second), then the third
        // death: the crash falls into the gap.
        await streamNew(fd);
        await streamNew(fd);
        assert.equal(fd.endStreams(), 1);
        await waitForTruthy(() => resumptionStatus().restartScheduled, "restart scheduled");
        const mark = fd.calls().length;
        fd.crash(name, { restart: true }); // die + start while NO stream runs
        assert.equal(advanceRestart(), 1, "the restart already ran — the crash was not in the gap");
        await waitForTruthy(() => fd.streams().length === 1, "new stream");
        // A mark AFTER the crash, written while the new stream runs: it arrives in any case, and the stream delivers in file order —
        // once it is judged, everything before it (the redelivered die) is through.
        fd.event(name, "kill", { signal: "marker-4b" });
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "kill" && u.signal === "marker-4b"), "the mark is at the observer");
        await resumptionQuiet();
        assert.equal(store.projectInstance(s.projectId).state, "ready");
        assert.deepEqual(startedSince(fd, name, idOf, mark), ["a-app-1", "a-db-1"]);
        assert.deepEqual(hostStarts(fd, mark), [], "it already ran again");
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1);
        // Which way triggers is decided by the load: the redelivered `die` (yes) or the reconcile after the restart, which recognises
        // the container via StartedAt as silently restarted (4c); the other comes afterwards and sees the row in `start`. The promise
        // is: the `die` ARRIVES (only via --since), and there is exactly ONE yes.
        const u = verdictsOf(name);
        assert.ok(u.some((x) => x.action === "die"), `the die from the gap did not arrive: ${JSON.stringify(u)}`);
        assert.equal(u.filter((x) => x.yes).length, 1, JSON.stringify(u));
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(4c) Silently restarted (die AND start fell out of the buffer): the tick writes no desired state from the crash but triggers the resumption; so does the reconcile after a restart of the stream", async () => {
  await withAgentsServer(async (ctx) => {
    const s1 = scenario(ctx);
    const s2 = scenario(ctx);
    const fd = await fakeDocker({ programs: s1.programs });
    try {
      await inOps(fd, s1, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const p1 = projectRunning(fd, s1);
        const p2 = projectRunning(fd, s2);
        const desired1 = store.projectInstance(s1.projectId).desired;
        const mark = fd.calls().length;
        // Tick: s1 restarted silently (no event) — its inside stands (exit 255).
        fd.crash(p1.name, { silent: true, restart: true });
        const k1 = store.instanceIdentifier(s1.projectId, "main");
        const r = await desiredTickRound();
        assert.equal(r[k1], "newly-started", JSON.stringify(r));
        await resumptionQuiet();
        const z1 = store.projectInstance(s1.projectId);
        assert.equal(z1.state, "ready");
        assert.deepEqual(states(z1.desired), states(desired1), "the desired state from the crash was written");
        assert.deepEqual(startedSince(fd, p1.name, p1.idOf, mark), ["a-app-1", "a-db-1"]);
        assert.deepEqual(hostStarts(fd, mark), []);
        // A second tick: the row is younger than the start — an ordinary snapshot (equal), no second restart.
        assert.equal((await desiredTickRound())[k1], "equal");
        // Reconcile: s2 restarted silently, the stream ends and comes back.
        const ab2 = fd.calls().length;
        fd.crash(p2.name, { silent: true, restart: true });
        await streamNew(fd);
        assert.equal(store.projectInstance(s2.projectId).state, "ready");
        assert.deepEqual(startedSince(fd, p2.name, p2.idOf, ab2), ["a-app-1", "a-db-1"]);
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 2);
        assert.ok(verdictsOf(p2.name).some((u) => u.action === "reconcile" && u.yes && u.reason === "silently restarted"), JSON.stringify(verdictsOf(p2.name)));
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (5) Ops mark, registration, end ────────────────────────────────────────────────────────────────────────────────

test("(5) Without the ops mark no child and no docker call (consumer, whole chain \"restartGrace\", tick); with it \"project-resumption\" is the last consumer of \"restartGrace\" and starts the stream; close of the server ends it", async () => {
  const s0 = { fd: null };
  const names = [];
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    s0.fd = fd;
    // Without the ops mark, but with the fake docker as binary: every call would stand in the log.
    const savedBin = process.env.CBASE_DOCKER_BIN;
    process.env.CBASE_DOCKER_BIN = fd.bin;
    try {
      assert.equal(resumptionRestartGrace(), undefined);
      assert.equal(resumptionStatus().running, false);
      await fireHooks("restartGrace", {});
      assert.deepEqual(await desiredTickRound(), {});
      assert.equal(resumptionStatus().running, false, "an observer without the ops mark");
      assert.deepEqual(fd.streams(), []);
      assert.deepEqual(fd.calls(), [], "a docker call without the ops mark");
    } finally {
      if (savedBin === undefined) delete process.env.CBASE_DOCKER_BIN; else process.env.CBASE_DOCKER_BIN = savedBin;
    }
    // With the ops mark: the whole chain, observed.
    await withOps(fd, async () => {
      process.env.CBASE_NETWORK_ROOT = s.root;
      process.env.CBASE_PROJECT_DESIRED_MS = "0";
      try {
        observeHooks((info) => { if (info.kind === "restartGrace" && info.phase === "start") names.push(info.name); });
        await fireHooks("restartGrace", {});
        assert.equal(names.at(-1), "project-resumption", `order ${names.join(", ")}`);
        assert.ok(names.indexOf("project-restore") < names.indexOf("project-resumption"));
        await waitForTruthy(() => fd.streams().length === 1, "stream runs");
        assert.equal(resumptionStatus().running, true);
        await carryOut(fd);
        await resumptionQuiet();
      } finally {
        observeHooks(null);
        delete process.env.CBASE_NETWORK_ROOT;
        delete process.env.CBASE_PROJECT_DESIRED_MS;
        cleanUpRows();
      }
    });
    // The server closes at the end of withAgentsServer — the observer runs until then.
    assert.equal(resumptionStatus().running, true);
  });
  try {
    assert.equal(resumptionStatus().running, false, "close of the server did not end the observer");
    await waitForTruthy(() => s0.fd.streams().length === 0, "the stream ends");
  } finally {
    stopResumption("test end");
    s0.fd?.cleanUp();
  }
});

// ── (6) Looking up after a temporary no ────────────────────────────────────────────────────────────────────────────

test("(6) A die during an occupancy is remembered; the next tick after its end looks up and triggers the resumption", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, idOf } = projectRunning(fd, s);
        const identifier = store.instanceIdentifier(s.projectId, "main");
        let free;
        const held = new Promise((r) => { free = r; });
        const occupancy = withProjectOccupancy(s.projectId, "creation", () => held);
        const mark = fd.calls().length;
        fd.crash(name);
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die"), "the die is at the observer");
        assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["occupied"]);
        assert.deepEqual(resumptionStatus().catchUp, [identifier]);
        // Still occupied: the tick keeps remembering, triggers nothing.
        await desiredTickRound();
        assert.deepEqual(resumptionStatus().catchUp, [identifier]);
        assert.equal(resumptionStatus().resumptions, prior.resumptions);
        free();
        await occupancy;
        await desiredTickRound();
        await resumptionQuiet();
        assert.deepEqual(resumptionStatus().catchUp, []);
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1);
        assert.equal(store.projectInstance(s.projectId).state, "ready");
        assert.equal(hostStarts(fd, mark).length, 1);
        assert.deepEqual(startedSince(fd, name, idOf, mark), ["a-app-1", "a-db-1"]);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (7) to (11): further guards ─────────────────────────────────────────────────────────────────────────────────────

// The stack stays up after a crash in the middle of the start sequence: {db, migrate: exited, app}.
const DESIRED_TOP = { "a-db-1": "running", "a-migrate-1": "exited", "a-app-1": "running" };

test("(7a) Crash with restart in the middle of the start sequence (phase \"services\"): no snapshot from the fresh dockerd — the restore runs through once more, the desired state stays {db, app: running}, then exactly one resumption", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, cid } = projectRunning(fd, s);
        const z0 = store.projectInstance(s.projectId);
        store.changeProjectInstance(s.projectId, "main", { desired: { ...z0.desired, services: [7] } }); // otherwise the start sequence does not call the starter
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
        const mark = fd.calls().length;
        let calls = 0;
        setNativeServicesStarter(async () => { calls += 1; if (calls === 1) fd.crash(name, { restart: true }); });
        try {
          dx(fd, "stop", name); // by hand: the resumption begins
          // Waiting is on events that occur WITH and WITHOUT the repair (the first starter call, the quiet, the die of the crash) —
          // never on the second pass itself: a sabotage turns red instead of hanging silently.
          await waitForTruthy(() => calls >= 1, "the start sequence reached the starter");
          await resumptionQuiet();
          await waitForTruthy(() => verdictsOf(name).filter((u) => u.action === "die").length >= 2, "the die of the crash is at the observer");
          await resumptionQuiet();
        } finally { setNativeServicesStarter(null); }
        const z = store.projectInstance(s.projectId);
        assert.equal(z.state, "ready", JSON.stringify(z));
        assert.deepEqual(states(z.desired), DESIRED_TOP, "the desired state was written from the fresh inner dockerd");
        assert.equal(calls, 2);
        await desiredTickRound();
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, `more than one resumption: ${JSON.stringify(verdictsOf(name))}`);
        assert.deepEqual(resumptionStatus().catchUp, []);
        assert.deepEqual(hostStarts(fd, mark), [["start", cid]], "docker start of the project container");
        assert.deepEqual(states(store.projectInstance(s.projectId).desired), DESIRED_TOP);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(7b) An unmarked die DURING a living procedure is remembered (with the event time); after the procedure the tick looks up: the container has restarted since ⇒ resumption", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name } = projectRunning(fd, s);
        const identifier = store.instanceIdentifier(s.projectId, "main");
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
        // A procedure of the row lives (state `start`), held by the test — the crash falls into it.
        setInstanceState(s.projectId, "main", "start", { phase: "waiting" });
        let free;
        const held = new Promise((r) => { free = r; });
        const procedure = withProcedure(s.projectId, "main", () => held);
        try {
          fd.crash(name, { restart: true });
          await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die"), "the die is at the observer");
          assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["state-start"]);
          assert.deepEqual(resumptionStatus().catchUp, [identifier], "the die was not remembered");
          // The procedure still lives: the tick leaves the entry.
          await desiredTickRound();
          assert.deepEqual(resumptionStatus().catchUp, [identifier]);
          assert.equal(resumptionStatus().resumptions, prior.resumptions);
        } finally { free(); await procedure; } // also on a red verdict: otherwise the held procedure would hold the cleanup forever
        setInstanceState(s.projectId, "main", "ready", { phase: "" }); // the procedure "ends" without having seen the inside
        await desiredTickRound();
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, `no resumption: ${JSON.stringify(verdictsOf(name))}`);
        assert.deepEqual(resumptionStatus().catchUp, []);
        const z = store.projectInstance(s.projectId);
        assert.equal(z.state, "ready");
        assert.deepEqual(states(z.desired), DESIRED_TOP);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

const KIND_RP92 = `
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as store from ${JSON.stringify(new URL("../electron/server/store.js", import.meta.url).href)};
import { db as storeDb } from ${JSON.stringify(new URL("../electron/server/store/db.js", import.meta.url).href)};
import { resumptionCatchUpRemember, resumptionRestartGrace, resumptionStatus, stopResumption } from ${JSON.stringify(new URL("../electron/server/projectbox/resumption.js", import.meta.url).href)};
const dir = process.argv[2];
store.initStore(dir);
// The store runs in WAL mode (store/db.js), where a foreign BEGIN EXCLUSIVE blocks writers only and reads go through. This test
// is about the catch around a throwing read in the tick, not about the journal mode: back to the rollback journal for it.
storeDb.exec("PRAGMA journal_mode=DELETE");
store.createProjectInstance({ projectId: "p-rp92", state: "error", convertedAt: Date.now() });
resumptionRestartGrace(); // ops mark and CBASE_DOCKER_BIN from the environment; the tick is small (CBASE_PROJECT_DESIRED_MS)
const holders = new DatabaseSync(path.join(dir, "automater.db"));
holders.exec("BEGIN EXCLUSIVE"); // from now on every read throws "database is locked"
resumptionCatchUpRemember("p-rp92", "main");
const until = () => { const x = resumptionStatus(); return x.tickRounds >= 1 && x.tickScheduled; };
while (!until()) await new Promise((res) => setImmediate(res)); // a round is through AND the next tick is scheduled
holders.exec("ROLLBACK");
const x = resumptionStatus();
stopResumption("Kind");
console.log(JSON.stringify({ alive: true, catchUp: x.catchUp, tickScheduled: x.tickScheduled }));
process.exit(0);
`;

test("(7c) If store.projectInstance throws in the tick (database locked), the round does not reject: the process lives, the entry stays, the next tick is scheduled", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-rp92-"));
  try {
    const script = path.join(dir, "child.mjs");
    fs.writeFileSync(script, KIND_RP92);
    const env = { ...process.env, CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: "/bin/true", CBASE_DB_BUSY_MS: "50", CBASE_PROJECT_DESIRED_MS: "20" };
    delete env.NODE_TEST_CONTEXT;
    const subprocess = spawn(process.execPath, [script, dir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    subprocess.stdout.on("data", (d) => { out += d; });
    subprocess.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r) => subprocess.once("close", r));
    assert.equal(code, 0, `the child process died of the rejected round (exit ${code}):\n${err.split("\n").filter((z) => !/ExperimentalWarning|trace-warnings/.test(z)).join("\n")}`);
    const row = out.split("\n").map((z) => { try { return JSON.parse(z); } catch { return null; } }).find((z) => z && z.alive);
    assert.ok(row, `no answer: ${out}`);
    assert.deepEqual(row.catchUp, ["p-rp92/main"], "the entry fell out of the look-up instead of staying for the next tick");
    assert.equal(row.tickScheduled, true);
    assert.match(err, /desired tick: look-up p-rp92\/main — .*database is locked/, err);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("(7d) The mark of a FAILED stop expires: a later manual stop of the still running container is a resumption again; that of a successful one never; within the deadline it holds", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        // (a) the seam: deadline, succeeded, failed.
        const id = dx(fd, "run", "-d", "--name", "rp93-a", "--label", "cbase.project=rp93", "img");
        await docker(["stop", "-t", "30", "rp93-a"]); // succeeds
        await assert.rejects(docker(["rm", "rp93-b"])); // fails (does not exist)
        const now = Date.now();
        assert.equal(expireSelfStopped(["rp93-a", "rp93-b"], now + SELF_DEADLINE_MS - 5_000), 0, "within the deadline nothing expires");
        assert.equal(expireSelfStopped(["rp93-a", "rp93-b"], now + SELF_DEADLINE_MS + 5_000), 1, "only that of the failed call");
        assert.notEqual(selfStoppedSince("rp93-a"), null, "the mark of a successful stop did not stay");
        assert.equal(selfStoppedSince("rp93-b"), null);
        forgetSelfStopped(["rp93-a", id]);

        // (b) the observer: `docker rm` (without -f) of a RUNNING container fails, the container keeps running.
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, cid } = projectRunning(fd, s);
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
        await assert.rejects(docker(["rm", name]), /running/i);
        assert.notEqual(selfStoppedSince(name), null);
        // Within the deadline: the tick does not take it back.
        await desiredTickRound();
        assert.notEqual(selfStoppedSince(name), null, "the mark expired within the deadline");
        // After the deadline the tick takes it back (a RUNNING container).
        advanceSelfClock(SELF_DEADLINE_MS + 5_000);
        await desiredTickRound();
        assert.equal(selfStoppedSince(name), null, "the mark of the failed stop never expired");
        const mark = fd.calls().length;
        dx(fd, "stop", name); // a human
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die"), "the die is at the observer");
        await resumptionQuiet();
        assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["end"]);
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1);
        assert.equal(store.projectInstance(s.projectId).state, "ready");
        assert.deepEqual(hostStarts(fd, mark), [["start", cid]]);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(7e) The copy path: the copy row beside the main row — a manual stop of the copy restores exactly this instance (docker start on cbase-k-…), the main keeps its stateSince; the reconcile after a restart of the stream brings back a silently ended copy; the tick sees the copy", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const main = projectRunning(fd, s);
        const copy = projectRunning(fd, s, { instance: "copy-x" });
        assert.equal(copy.name, `cbase-k-${s.projectId}-x`);
        await waitForTruthy(() => verdictsOf(copy.name).some((u) => u.action === "start") && verdictsOf(main.name).some((u) => u.action === "start"), "the start of both seedings is at the observer");
        const mainSince = store.projectInstance(s.projectId, "main").stateSince;
        const copySince = store.projectInstance(s.projectId, "copy-x").stateSince;
        const mark = fd.calls().length;
        dx(fd, "stop", copy.name);
        await waitForTruthy(() => verdictsOf(copy.name).some((u) => u.action === "die"), "the die of the copy is at the observer");
        await resumptionQuiet();
        assert.deepEqual(verdictsOf(copy.name).filter((u) => u.action === "die").map((u) => u.reason), ["end"]);
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1);
        const k = store.projectInstance(s.projectId, "copy-x");
        assert.equal(k.state, "ready", JSON.stringify(k));
        assert.ok(k.stateSince > copySince, "the copy row did not move");
        assert.equal(store.projectInstance(s.projectId, "main").stateSince, mainSince, "the main moved");
        assert.deepEqual(hostStarts(fd, mark), [["start", copy.cid]], "docker start on the copy");
        assert.deepEqual(startedSince(fd, copy.name, copy.idOf, mark), ["a-app-1", "a-db-1"]);
        assert.deepEqual(verdictsOf(main.name).filter((u) => u.action === "die"), []);

        // Reconcile: the copy ends WITHOUT an event (silently), the stream is restarted — the reconcile brings it back (like (4a);
        // an earlier version stopped by hand here and the resumption came from the event again — a reconcile that left out copies
        // would have stayed green).
        const n1 = resumptionStatus().resumptions;
        const reconcilePrior = verdictsOf(copy.name).filter((u) => u.action === "reconcile").length;
        const thePrior = verdictsOf(copy.name).filter((u) => u.action === "die").length;
        const mainSince2 = store.projectInstance(s.projectId, "main").stateSince;
        const ab2 = fd.calls().length;
        fd.crash(copy.name, { silent: true });
        await streamNew(fd); // waits for the reconcile and every triggered resumption
        assert.equal(resumptionStatus().resumptions - n1, 1, `no resumption from the reconcile: ${JSON.stringify(verdictsOf(copy.name))}`);
        // Via `--since` at most the die of the first stop arrives once more (stale) — none triggers anything.
        assert.deepEqual(verdictsOf(copy.name).filter((u) => u.action === "die").slice(thePrior).filter((u) => u.yes), [], "a die triggered the resumption, not the reconcile");
        assert.deepEqual(verdictsOf(copy.name).filter((u) => u.action === "reconcile").slice(reconcilePrior).map((u) => [u.yes, u.reason]), [[true, "exited"]]);
        assert.deepEqual(hostStarts(fd, ab2), [["start", copy.cid]], "docker start on the copy from the reconcile");
        assert.equal(store.projectInstance(s.projectId, "copy-x").state, "ready");
        assert.equal(store.projectInstance(s.projectId, "main").stateSince, mainSince2, "the main moved in the reconcile");

        // Tick: the copy row gets its desired state (one stack container less), the main stays untouched.
        dx(fd, "exec", copy.name, "docker", "stop", "a-app-1");
        const r = await desiredTickRound();
        const kk = store.instanceIdentifier(s.projectId, "copy-x");
        assert.equal(r[kk], "written", JSON.stringify(r));
        assert.deepEqual(states(store.projectInstance(s.projectId, "copy-x").desired), { ...DESIRED_TOP, "a-app-1": "exited" });
        assert.deepEqual(states(store.projectInstance(s.projectId, "main").desired), DESIRED_TOP);
      });
    } finally {
      cleanUpRows();
      for (const z of store.projectInstances()) if (z.instance !== "main") { try { store.deleteProjectInstance(z.projectId, z.instance); } catch { /* gone */ } }
      fd.cleanUp();
    }
  });
});

// ── (8) to (10): server end during a restore, foreign mark, confirmed life ──────────────────────────────────────────

test("(8) Server end during a restore: (a) in the middle of the start sequence (phase \"services\") the stop chain stops the project container — no second pass, no docker start, the row ends in error; (b) if it already stands, it is not started in the ending server; (c) if the daemon restarts it itself, the start sequence still does not run again", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        // (a) The main container runs with its stack; the restore (here the way of the Git waker) reaches the starter of the native
        // services — there the server end begins: the mark, then the stop chain (docker stop through docker(), as
        // projectbox/serverEnd.js). Without the repair the start sequence runs through once more and starts it (`ready`, runs).
        const { name, cid } = projectRunning(fd, s);
        const z0 = store.projectInstance(s.projectId);
        store.changeProjectInstance(s.projectId, "main", { desired: { ...z0.desired, services: [7] } }); // otherwise the start sequence does not call the starter
        const mark = fd.calls().length;
        let calls = 0;
        setNativeServicesStarter(async () => {
          calls += 1;
          if (calls === 1) { serverEndMarkerForTest(true); await docker(["stop", "-t", "30", name]); }
          return { error: [] };
        });
        let z;
        try { z = await restoreInstance(s.projectId, "main", { reason: "Git view: container is stopped" }); }
        finally { setNativeServicesStarter(null); serverEndMarkerForTest(false); }
        assert.equal(calls, 1, "the start sequence ran through a second time in the ending server");
        assert.deepEqual(hostStarts(fd, mark), [], "docker start of the project container in the ending server");
        assert.equal(z?.state, "error", JSON.stringify(z));
        assert.match(z.error, /the server is ending/);
        assert.equal(fd.state().container[cid]?.status === "running", false, "the project container runs again — the stop chain no longer sees it");

        // (b) The server end has begun and the container already stands; a path that restores now does not start it.
        setInstanceState(s.projectId, "main", "ready", { phase: "", error: "" });
        const ab2 = fd.calls().length;
        serverEndMarkerForTest(true);
        let z2;
        try { z2 = await restoreInstance(s.projectId, "main", { reason: "Git view: container is stopped" }); }
        finally { serverEndMarkerForTest(false); }
        assert.deepEqual(hostStarts(fd, ab2), [], "docker start of a standing project container in the ending server");
        assert.equal(z2?.state, "error", JSON.stringify(z2));
        assert.match(z2.error, /the server is ending/);

        // (c) Like (a), but the daemon restarts it itself after a crash (so it runs): even then no second pass of the start sequence
        // in the ending server — it would get stages, services and `ready` with the desired state from the fresh dockerd.
        dx(fd, "start", cid);
        setInstanceState(s.projectId, "main", "ready", { phase: "", error: "" });
        let calls3 = 0;
        setNativeServicesStarter(async () => {
          calls3 += 1;
          if (calls3 === 1) { serverEndMarkerForTest(true); fd.crash(name, { restart: true }); }
          return { error: [] };
        });
        let z3;
        try { z3 = await restoreInstance(s.projectId, "main", { reason: "Git view: container is stopped" }); }
        finally { setNativeServicesStarter(null); serverEndMarkerForTest(false); }
        assert.equal(calls3, 1, "the start sequence ran through a second time in the ending server (container restarted by the daemon)");
        assert.equal(z3?.state, "error", JSON.stringify(z3));
        assert.match(z3.error, /restarted or stood still during the start sequence.*no second pass: the server is ending/);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// The FOREIGN mark b-ends (the gateway, server/gateway/containers.js stop of the project containers) in a B that lives on afterwards
// (`rm -f` failed, or the gateway restarted in the window). The script stops behind docker() — no mark "cbase stops itself" —, the
// `die` is `serverEnd`. When the mark expires, the tick brings the container back.
test("(9) The foreign mark b-ends in a B that lives on: a die with the reason serverEnd is remembered; while the mark holds, the tick triggers nothing; after its expiry the project container starts again — exactly one docker start", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true }); // the stop takes the inner stack along (like a real dockerd)
    const marker = path.join(s.root, B_ENDS_MARKER);
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name, cid, idOf } = projectRunning(fd, s);
        const identifier = store.instanceIdentifier(s.projectId, "main");
        // The mark like the gateway (`exec -u root`: 0644 in a 0755 directory); the owner in the test is the own uid.
        fs.chmodSync(path.dirname(marker), 0o755);
        fs.writeFileSync(marker, `${Date.now()}\n`);
        fs.chmodSync(marker, 0o644);
        bEndsOwnerForTest(process.getuid());
        assert.equal(serverEnds(), true, "the foreign mark holds");
        const mark = fd.calls().length;
        dx(fd, "stop", "-t", "30", name); // the gateway's script: behind the backend's docker()
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "die"), "the die is at the observer");
        assert.deepEqual(verdictsOf(name).filter((u) => u.action === "die").map((u) => u.reason), ["serverEnd"]);
        assert.deepEqual(resumptionStatus().catchUp, [identifier], "the die with reason serverEnd is not remembered");
        // The mark still holds: the tick does not run.
        await desiredTickRound();
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions, prior.resumptions);
        assert.deepEqual(hostStarts(fd, mark), []);
        // The mark expires (older than B_ENDS_AGE_MS) — B lives on.
        const old = new Date(Date.now() - B_ENDS_AGE_MS - 60_000);
        fs.utimesSync(marker, old, old);
        assert.equal(serverEnds(), false, "the expired mark no longer holds");
        await desiredTickRound();
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions - prior.resumptions, 1, "no resumption after the mark expired");
        assert.deepEqual(resumptionStatus().catchUp, []);
        assert.deepEqual(hostStarts(fd, mark).map((a) => a.at(-1)), [cid], "exactly one docker start of the project container");
        assert.equal(fd.state().container[cid]?.status, "running");
        assert.equal(store.projectInstance(s.projectId).state, "ready");
        assert.deepEqual(startedSince(fd, name, idOf, mark), ["a-app-1", "a-db-1"]);
      });
    } finally {
      bEndsOwnerForTest(0);
      fs.rmSync(marker, { force: true });
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// The same situation as (7a), but the restore does NOT come from the observer (Git waker, "new attempt", recreate, restart): the
// unmarked die of the crash stands in the look-up with event time, the second pass confirms the new life (checkLiveness) and writes
// `ready` — the next tick must not restore it once more.
test("(10) Crash with restart in a restore the observer did not trigger: after the confirmed ready the tick triggers no second resumption — stateSince stays, the look-up is empty", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs, stopsInside: true });
    try {
      await inOps(fd, s, async () => {
        await observerOn(fd);
        const prior = resumptionStatus();
        const { name } = projectRunning(fd, s);
        const identifier = store.instanceIdentifier(s.projectId, "main");
        const z0 = store.projectInstance(s.projectId);
        store.changeProjectInstance(s.projectId, "main", { desired: { ...z0.desired, services: [7] } }); // otherwise the start sequence does not call the starter
        await waitForTruthy(() => verdictsOf(name).some((u) => u.action === "start"), "the start of the seeding is at the observer");
        const dies = () => verdictsOf(name).filter((u) => u.action === "die");
        let calls = 0;
        setNativeServicesStarter(async () => {
          calls += 1;
          if (calls === 1) {
            const n = dies().length;
            fd.crash(name, { restart: true });
            // Go on only when the observer has seen the die — so it surely falls into the living procedure.
            await waitForTruthy(() => dies().length > n, "the die of the crash is at the observer");
          }
          return { error: [] };
        });
        let z;
        try { z = await restoreInstance(s.projectId, "main", { reason: "Git view: container is stopped" }); }
        finally { setNativeServicesStarter(null); }
        assert.equal(z?.state, "ready", JSON.stringify(z));
        assert.equal(calls, 2, "the second pass of the start sequence is missing");
        assert.deepEqual(dies().map((u) => u.reason), ["state-start"]);
        assert.deepEqual(resumptionStatus().catchUp, [identifier], "precondition: the die stands in the look-up with event time");
        await desiredTickRound();
        await resumptionQuiet();
        assert.equal(resumptionStatus().resumptions, prior.resumptions, `a second resumption: ${JSON.stringify(verdictsOf(name))}`);
        assert.deepEqual(resumptionStatus().catchUp, []);
        const z2 = store.projectInstance(s.projectId);
        assert.equal(z2.state, "ready");
        assert.equal(z2.stateSince, z.stateSince, "the row went through start once more");
        assert.deepEqual(states(z2.desired), DESIRED_TOP);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (11) The route of the snapshot for the gateway ──────────────────────────────────────────────────────────────────
// POST /api/projectbox/desired-snapshot is ONE pass of the desired tick (desiredTickRound): without the ops mark 404, in ops it
// writes the desired state of a ready row from the running inside. The gateway calls it in destroy before the stop (see
// server/gateway/containers.test.js). COUNTER-PROBE: relocation/routes.js without the route branch ⇒ red (404 in ops).
test("(11) POST /api/projectbox/desired-snapshot: without the ops mark 404; in ops it writes the desired state of a ready row", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const post = () => fetch(`${ctx.base}/api/projectbox/desired-snapshot`, { method: "POST", headers: { connection: "close" } });
    try {
      const without = await post();
      assert.equal(without.status, 404);
      await without.text();
      await inOps(fd, s, async () => {
        const oldDesired = { time: 1, container: [{ name: "x-1", id: "e".repeat(64), service: "x", project: "x", state: "running", exitCode: 0, dependsOn: "" }], services: [] };
        projectRunning(fd, s, { desired: oldDesired });
        await observerOn(fd); // a fresh run — the stop of the previous test left its `off` standing (desiredTickRound would abort)
        const r = await post();
        const j = await r.json();
        assert.equal(r.status, 200, JSON.stringify(j));
        assert.equal(j.result[store.instanceIdentifier(s.projectId, "main")], "written", JSON.stringify(j));
        assert.deepEqual(states(store.projectInstance(s.projectId).desired), { "a-db-1": "running", "a-migrate-1": "exited", "a-app-1": "running" });
      }, { CBASE_PROJECTBOX_CREATION_MS: "2000" });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});
