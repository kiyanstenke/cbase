// The restore of the project containers after every start of B (projectbox/restore.js).
//
// What holds here:
//   (1)  dependsOnFrom: the spec form (`service:condition:restart,…`) TOLERANT (spaces, missing parts, empty members, the JSON form,
//        an unknown condition with a notice) — the format of Compose v5.3.1 on a real container is unmeasured.
//   (2)  startStages as a table: the GEO form (db/redis/minio → migrate → ingest/transform/persist/serve), a cycle and an unknown
//        service ⇒ last stage with a notice (also what depends on it), a container without labels ⇒ stage 0, two compose projects with
//        the same service names stay separate, several containers of one service.
//   (3)  targetReached and desiredAfterRestore as tables; plus the mark "failed": `notArrived` carries ids AND names (a container the
//        restore created NEW carries a new id), and `carryForwardDesired` (snapshot at server end) keeps the mark of a failed, not
//        running service.
//   (4)  Stages through the fake docker: `inspect` reports healthy only after a gate file per container — stage k starts only after
//        healthy (or exit 0) of k−1; the instance becomes `ready`, the snapshot new.
//   (5)  An unhealthy service appears in the event `project/instance`; the instance becomes `ready` anyway, the next stage starts.
//   (6)  Cap per stage: a service whose gate never opens, plus the clock seam (advanceStagesCap) ⇒ `ready`, `busy` falls, the event
//        names the service.
//   (7)  Status file `phase=error` ⇒ `error` with the reason from the file and the recreate request; `phase=ended` ⇒ `error` without
//        a request; no inner container started.
//   (8)  Without a valid mark of the network separation: `error`, and NO docker call.
//   (9)  `earmarkRestore` (startServer, BEFORE listening) sets every converted row in `ready`/`error`/`start` to `start` — without
//        docker, without procedure; the restart hook synchronously enters the procedure for every row in `start` and hands an orphaned
//        `recreate` to the hook (setRecreateRestartGrace); rows without `converted_at` and in other states stay; a row in `error` is
//        tried again and becomes `ready`; without the ops mark nothing — empty log.
//  (10)  The hooks: atReady (asynchronous, after the transition, a throwing callback is only logged), the starter of the native
//        services (with their ids; without it the finding names them). The RETURN value of the starter is read — every entry in
//        `error` stands as "native service <id>: <reason>" in the finding and in the event, a throwing starter as "native services:
//        …", paths shortened in both cases; numeric ids from `desired.services` reach the starter.
//  (11)  Order: restart with a running dynamic workflow in a converted project and a channel with an unread message ⇒ the row is
//        `start` right after the restart (earmarked), every restart consumer sees it so, and after the chain its procedure lives (the
//        restore stands BEFORE "project-instances"); the workflow continues after `ready`, without a failed agent; the channel turn
//        starts only afterwards (no `exec` into the project container before its `start`). In the test process instead of `childProcess: true`:
//        the restart is `ctx.restart()` (same registry, same data folder), the restart hook `fireHooks("restartGrace")` as in
//        dynworkflows-resume.test.js — so `observeHooks` sees the state of the row EXACTLY where every consumer begins.
//        The main turn must be OVER before the channel message arises (gate end-<tag>, then `runs: 0`): its end with open background
//        work fires "turnEnd", which delivers unread messages to the free chat — the message would then run BEFORE the restart. After
//        the restart "unread" is a precondition that turns red instead of waiting without limit.
//  (12)  The window: after the restart in ops mode, BEFORE the restart hook, a message to a chat of the project waits (`queued`,
//        `locked`, no docker) and runs only after `ready` in the project container.
//  (13)  If the project container is missing ("No such container"), the row is `error` AND the recreate request goes out; a foreign
//        label and a broken `exec` stay `error` WITHOUT a request.
//  (14)  The snapshot at server end ONLY from `ready` — a row in the middle of the restore (at the gate of a stage) and one in `error`
//        with running containers keep their `desired`; a `ready` row writes.
//  (15)  A one-shot container the restore created NEW (new id) that ends with exit 1 stays `running` + `failed` in the desired —
//        after the restore AND after the server end; the next restore starts it again.
//  (16)  `carryForwardServiceDesired` during a stage — the services phase starts the NEW set, `ready` writes it; a snapshot at server
//        end that runs during a start writes the services of NOW (not those from the start of the snapshot).
//  (17)  `restoreInstance` next to a foreign occupancy or a living procedure ⇒ OCCUPIED (409), the row stays as it is (no `start`),
//        no docker call.
//  (18)  The project container stands in the middle of a stage ⇒ `error` "the project container stands (stage k/n)", without waiting
//        for the stage cap and without a flood of warnings.
//  (20)  The bridge prefix (creation.js BRIDGE_PREFIX): a RUNNING project container whose hostname or project network
//        bridge is not the derived `cbp-<n>` (one of an older release — entry.sh guards only `-i cbp-+`) is stopped AT ONCE, never
//        started, the row `error` AND the recreate request; a stopped one of that kind is not started. Built-in counter-test: hostname
//        and bridge `cbp-<n>` ⇒ `ready`, no stop.
//  (19)  A message or a workflow agent to a converted project in `error` triggers ONE new attempt (the row goes to `start`, the
//        message waits and runs after `ready`, a second message triggers no second one); if it fails again the waiting turn gets the
//        error; within the check-back beat (since `stateSince`) it stays today's error without an attempt; without the ops mark
//        nothing.
//
// Wait only for events: gates of the fake docker (gateReached — a mark the product sets when it looks), states (`waitForTruthy`
// without deadline), the clock seam of the stage cap. The cap is set high (an hour).
//
// COUNTER-PROBES (one sabotage at a time, the whole file run, each red WITHOUT a hang):
//   restore.js: runStages runs ONE stage with everything                    ⇒ (4) "stage 0 — and nothing after it", (6), (11) red
//   restore.js: the stage cap never registers and never expires               ⇒ (6) red ("no running stage cap")
//   restore.js: phase=error treated like ready                                ⇒ (7) red (ready instead of error, no request)
//   restore.js: the check of the mark removed                                 ⇒ (8) red (docker inspect/start in the log)
//   server.js: earmarkRestore removed                                         ⇒ (11) and (12) red (the row stands `ready`)
//   server.js: "project-restore" registered BEHIND "project-instances"        ⇒ (11) red (first the others, then error)
//   server.js: "project-restore" registered BEHIND "dyn-workflows"            ⇒ (11) red (dyn-workflows sees `ready`)
//   restore.js: desiredAfterRestore without `notArrived`                      ⇒ (3) red
//   restore.js: the recreate request INSIDE the procedure                     ⇒ (7) red (occupancy held)
//   restore.js: the missing container without `recreate: true`                ⇒ (13) red ("missing: []")
//   restore.js: return value of the starter discarded                         ⇒ (10) red ("the finding is silent about the service")
//   restore.js: services phase reads the desired from the start               ⇒ (16) red ("started the old list")
//   restore.js: `ready` writes `services` from the start                      ⇒ (16) red
//   serverEnd.js: snapshot with `services` from the start                     ⇒ (16) red ("overwrote the start of service 9")
//   restore.js: desiredServiceIds takes only strings                          ⇒ (16) red (numeric ids fell silently)
//   serverEnd.js: snapshot for every row with a container                     ⇒ (14) red ("the half state … as the intention")
//   serverEnd.js: snapshot without `carryForwardDesired`                      ⇒ (15) red ("as exited")
//   restore.js: the OCCUPIED check removed                                    ⇒ (17) red (row without procedure in `start`)
//   restore.js: `notArrived` only ids                                         ⇒ (15) red ("with a new id was forgotten")
//   restore.js: CONTAINER_STANDS never recognised                             ⇒ (18) red ("start held until the cap")
//   server.js: setErrorAttempt removed                                        ⇒ (19) red ("ended at the old error")
//   recreate.js: recreateErrorAttempt without the deadline                    ⇒ (19) red ("a new attempt within the deadline")
//   restore.js: the call of namingDeviation struck                            ⇒ (20) red ("the old container kept running")
//   the three lines "gate end-w reached, open, wait for runs: 0" moved BEHIND addChannelMessage ⇒ (11) red at the precondition
//     ("went out BEFORE the restart"), no hang; the same move WITHOUT the precondition would hang the gate ("woken — 0 chat(s)").
// Not counter-probed: "at most one attempt at a time" in recreateErrorAttempt — the row stands in `start` synchronously and
// restoreInstance rejects next to a living procedure (17), so the check is doubly secured and a sabotage of it alone stays green;
// likewise the single warning per stage (18) for an inspect error other than "stands".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { procedureAlive, setInstanceState, withProcedure } from "../electron/server/projectbox/instances.js";
import { withProjectOccupancy, projectOccupied } from "../electron/server/projectbox/instance.js";
import { projectboxServerEnd, desiredFromInspect, carryForwardDesired } from "../electron/server/projectbox/serverEnd.js";
// the services snapshot during a restore, the new attempt from `error` at the lock
import { carryForwardServiceDesired } from "../electron/server/projectbox/services.js";
import { projectLock } from "../electron/server/projectbox/idle.js";
import {
  atReady, dependsOnFrom, setNativeServicesStarter, setRecreateRequest, desiredAfterRestore, startStages,
  restoreInstance, advanceStagesCap, restoreRestartGrace, targetReached,
} from "../electron/server/projectbox/restore.js";
// Earmarking before listening, the hook of the recreate to the restart.
import { setRecreateRestartGrace, earmarkRestore } from "../electron/server/projectbox/restore.js";
import { recreateRequest, recreateRestartGraceSeam } from "../electron/server/projectbox/recreate.js";
import { observeHooks, fireHooks } from "../electron/server/runs/hooks.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { readJsonl } from "./jsonl.mjs";
import { withOps, scenario } from "./projectbox-scenario.mjs";
import { GLOBAL } from "./quiet.mjs";

// ── (1) dependsOnFrom ────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) dependsOnFrom: the spec form, tolerant — spaces, missing parts, empty members, JSON, unknown condition", () => {
  const only = (raw) => dependsOnFrom(raw).deps.map((d) => `${d.service}|${d.condition}|${d.restart}`);
  assert.deepEqual(only("db:service_healthy:false,redis:service_started:true"), ["db|service_healthy|false", "redis|service_started|true"]);
  assert.deepEqual(only(" db : service_healthy : false , , minio:service_completed_successfully "), ["db|service_healthy|false", "minio|service_completed_successfully|false"]);
  assert.deepEqual(only("db"), ["db|service_started|false"], "only the service ⇒ service_started");
  assert.deepEqual(only("db::"), ["db|service_started|false"]);
  assert.deepEqual(only('{"db":{"condition":"service_healthy","restart":true},"redis":{}}'), ["db|service_healthy|true", "redis|service_started|false"]);
  for (const empty of ["", null, undefined, "  ", ","]) assert.deepEqual(only(empty), [], JSON.stringify(empty));
  const u = dependsOnFrom("db:service_bogus:false");
  assert.deepEqual(u.deps.map((d) => d.condition), ["service_started"]);
  assert.match(u.notices.join(), /unknown condition "service_bogus" for "db"/);
  assert.match(dependsOnFrom("{broken").notices.join(), /not readable/);
  assert.match(dependsOnFrom(":service_healthy").notices.join(), /without a service/);
});

// ── (2) startStages ─────────────────────────────────────────────────────────────────────────────────────────────────

const k = (name, service, dependsOn = "", project = "geo") => ({ name, id: `id-${name}`, service, project, dependsOn });
const names = (r) => r.stages.map((s) => s.map((c) => c.name));
// The GEO form: data storage → migrate (one-shot container) → the services.
const GEO = [
  k("geo-serve-1", "serve", "migrate:service_completed_successfully:false,db:service_healthy:false"),
  k("geo-db-1", "db"),
  k("geo-migrate-1", "migrate", "db:service_healthy:false,redis:service_started:false,minio:service_healthy:false"),
  k("geo-redis-1", "redis"),
  k("geo-ingest-1", "ingest", "migrate:service_completed_successfully:false,redis:service_started:false"),
  k("geo-minio-1", "minio"),
  k("geo-transform-1", "transform", "migrate:service_completed_successfully:false"),
  k("geo-persist-1", "persist", "migrate:service_completed_successfully:false,minio:service_healthy:false"),
];

test("(2) startStages: GEO form in three stages, migrate as a required one-shot container", () => {
  const r = startStages(GEO);
  assert.deepEqual(names(r), [
    ["geo-db-1", "geo-minio-1", "geo-redis-1"],
    ["geo-migrate-1"],
    ["geo-ingest-1", "geo-persist-1", "geo-serve-1", "geo-transform-1"],
  ]);
  assert.deepEqual(r.notices, []);
  const finished = r.stages.flat().filter((c) => c.finishedRequired).map((c) => c.name);
  assert.deepEqual(finished, ["geo-migrate-1"], "only migrate must end with 0");
  assert.equal(GEO[2].finishedRequired, undefined, "the input stays unchanged");
});

test("(2) startStages: cycle and unknown service ⇒ last stage with a notice, together with everything that depends on it", () => {
  const r = startStages([
    k("a", "a", "b"), k("b", "b", "a"), k("c", "c", "a"), // cycle a ↔ b, c hangs on it
    k("x", "x", "doesnotexist:service_healthy"),           // unknown
    k("y", "y", "x"),                                       // hangs on the unknown
    k("free", "free"),
  ]);
  assert.deepEqual(names(r), [["free"], ["a", "b", "c", "x", "y"]]);
  const m = r.notices.join("\n");
  assert.match(m, /cycle in depends_on: a, b — last stage/);
  assert.match(m, /x: depends on unknown service "doesnotexist"/);
  assert.match(m, /c: depends on a service of the last stage/);
  assert.match(m, /y: depends on a service of the last stage/);
});

test("(2) startStages: without labels stage 0; two compose projects with the same names stay separate; one service with two containers", () => {
  const without = { name: "manually-started", id: "id-h", service: "", project: "", dependsOn: "" };
  const r = startStages([
    without,
    k("p1-db", "db", "", "p1"), k("p1-app", "app", "db:service_healthy", "p1"),
    k("p2-app", "app", "db:service_healthy", "p2"), // p2 has no db ⇒ unknown, NOT the db of p1
    k("w-1", "worker", "db", "p1"), k("w-2", "worker", "db", "p1"),
  ]);
  assert.deepEqual(names(r), [["manually-started", "p1-db"], ["p1-app", "w-1", "w-2"], ["p2-app"]]);
  assert.match(r.notices.join(), /p2-app: depends on unknown service "db"/);
  assert.deepEqual(names(startStages([])), []);
  assert.deepEqual(names(startStages(null)), []);
});

// ── (3) targetReached, desiredAfterRestore ──────────────────────────────────────────────────────────────────────────

test("(3) targetReached: running · healthy · finished per state", () => {
  const s = (Status, ExitCode = 0, Health) => ({ State: { Status, ExitCode, ...(Health ? { Health: { Status: Health } } : {}) } });
  const table = [
    [s("running"), "running", "yes"], [s("created"), "running", "no"], [s("restarting"), "running", "no"], [s("exited", 1), "running", "failed"],
    [s("running", 0, "healthy"), "healthy", "yes"], [s("running", 0, "starting"), "healthy", "no"], [s("running", 0, "unhealthy"), "healthy", "failed"],
    [s("exited", 0, "healthy"), "healthy", "failed"],
    [s("exited", 0), "finished", "yes"], [s("exited", 2), "finished", "failed"], [s("running"), "finished", "no"], [s("dead", 137), "finished", "failed"],
  ];
  for (const [insp, target, state] of table) assert.equal(targetReached(insp, target).outcome, state, `${JSON.stringify(insp)} ${target}`);
  assert.match(targetReached(s("running", 0, "unhealthy"), "healthy").reason, /unhealthy/);
  assert.match(targetReached(s("exited", 2), "finished").reason, /exit 2/);
});

test("(3) desiredAfterRestore: the state of now — a failed one stays running, a finished one-shot container exited", () => {
  const insp = (name, Status, ExitCode = 0) => ({ Id: `id-${name}`, Name: `/${name}`, Config: { Labels: {} }, State: { Status, ExitCode } });
  const old = { time: 1, container: ["db", "migrate", "app", "old"].map((n) => ({ name: n, id: `id-${n}`, state: "running" })), services: [{ id: "svc-1" }] };
  const fresh = desiredAfterRestore(old, [insp("db", "running"), insp("migrate", "exited", 0), insp("app", "exited", 1), insp("fresh", "exited", 0)], { time: 2, notArrived: ["id-app"] });
  assert.equal(fresh.time, 2);
  assert.deepEqual(fresh.services, [{ id: "svc-1" }], "the native services travel along");
  assert.deepEqual(Object.fromEntries(fresh.container.map((c) => [c.name, c.state])), { app: "running", db: "running", migrate: "exited", fresh: "exited" });
  assert.deepEqual(desiredAfterRestore(null, [insp("db", "running")], { time: 3 }).container.map((c) => c.state), ["running"]);
});

test("(3) mark \"failed\": desiredAfterRestore sets it, also via the NAME; carryForwardDesired carries it as long as the container does not run", () => {
  const insp = (name, Status, ExitCode = 0, id = `id-${name}`) => ({ Id: id, Name: `/${name}`, Config: { Labels: {} }, State: { Status, ExitCode } });
  const view = (desired) => Object.fromEntries(desired.container.map((c) => [c.name, `${c.state}${c.failed ? "+failed" : ""}`]));
  const old = { time: 1, container: [{ name: "db", id: "id-old-db", state: "running" }, { name: "app", id: "id-app", state: "running" }], services: [7] };
  // db was recreated after the snapshot (new id) — the stages found it via the name, it failed.
  const after = desiredAfterRestore(old, [insp("db", "exited", 1, "id-new-db"), insp("app", "running")], { time: 2, notArrived: ["id-new-db", "db"] });
  assert.deepEqual(view(after), { app: "running", db: "running+failed" });
  // Server end and recreate write from the actual state: the mark stays while it does not run; if it runs, it falls.
  assert.deepEqual(view(carryForwardDesired(after, [insp("db", "exited", 1, "id-new-db"), insp("app", "exited", 0)], { time: 3 })), { app: "exited", db: "running+failed" });
  assert.deepEqual(view(carryForwardDesired(after, [insp("db", "running", 0, "id-new-db"), insp("app", "running")], { time: 4 })), { app: "running", db: "running" });
  assert.deepEqual(carryForwardDesired(after, [], { time: 5 }).services, [7], "the native services travel along");
  // The restore itself carries no old mark: a one-shot container that now ended with 0 as required.
  assert.deepEqual(view(desiredAfterRestore({ container: [{ name: "migrate", id: "id-m", state: "running", failed: true }] }, [insp("migrate", "exited", 0, "id-m")])), { migrate: "exited" });
});

// ── Shared parts of the integration ─────────────────────────────────────────────────────────────────────────────────

// The environment of a test in ops mode: the marks of projectbox-scenario.mjs (beat small, wait cap large, hosts file), plus the
// stage cap set high and the root of the network mark (for the hook that gets no options). Further names in `values` (the homes of
// the CLIs, say) are set and restored by inOps itself — withOps knows only its own.
async function inOps(fd, s, fn, values = {}) {
  const desired = { CBASE_PROJECT_STAGE_MS: "3600000", CBASE_NETWORK_ROOT: s?.root, ...values };
  const saved = Object.fromEntries(Object.keys(desired).map((x) => [x, process.env[x]]));
  try {
    for (const [x, v] of Object.entries(desired)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
    return await withOps(fd, async () => {
      try { return await fn(); } finally { await carryOut(fd); }
    }, values);
  } finally {
    for (const [x, v] of Object.entries(saved)) { if (v === undefined) delete process.env[x]; else process.env[x] = v; }
  }
}

// After the body, STILL in ops mode: if a restore is still alive (a failure in the middle of it, or a counter-probe), it is carried
// to its end — every gate the fake docker waits at opens, and every stage cap expires through the clock seam. Outside ops mode the
// docker seam would reject every call and the procedure would wait for its cap (an hour in the test): the test process would not
// end. Without a failure none is alive and it is one glance. Not a criterion of the test — cleanup only.
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

const dx = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
const projectContainer = (pid) => `cbase-p-${pid}`;

// A converted project with project container and inner stack in the fake docker; `stack` per container { name, service, dependsOn,
// healthy, ends }. The snapshot `desired` is made from the running stack (as at server end), then stack and container stop — the
// state after the stop chain.
function projectWithStack(ctx, fd, s, stack, { desired: desiredExtra = {}, state = "ready" } = {}) {
  const name = projectContainer(s.projectId);
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
  for (const c of stack) {
    const args = ["exec", name, "docker", "run", "-d", "--name", c.name, "--label", "com.docker.compose.project=geo", "--label", `com.docker.compose.service=${c.service}`];
    if (c.dependsOn) args.push("--label", `com.docker.compose.depends_on=${c.dependsOn}`);
    if (c.healthy) args.push("--health-cmd", "true");
    if (c.ends !== undefined) args.push("--label", `cbase.test.ends=${c.ends}`);
    dx(fd, ...args, "img");
  }
  const ids = dx(fd, "exec", name, "docker", "ps", "-aq", "--no-trunc").split("\n").filter(Boolean);
  const inspect = ids.length ? JSON.parse(dx(fd, "exec", name, "docker", "inspect", ...ids)) : [];
  const desired = { ...desiredFromInspect(inspect), ...desiredExtra };
  store.createProjectInstance({ projectId: s.projectId, state, convertedAt: Date.now(), containerId: cid, desired });
  if (ids.length) dx(fd, "exec", name, "docker", "stop", ...ids);
  dx(fd, "stop", name);
  // The `.waiting` marks the check-back set while seeding do not count: a gate is reached only when the product itself looks.
  for (const f of fs.readdirSync(path.join(fd.dir, "gates"))) if (f.endsWith(".waiting")) fs.rmSync(path.join(fd.dir, "gates", f));
  return { name, cid, idOf: Object.fromEntries(inspect.map((c) => [c.Name.replace(/^\//, ""), c.Id])) };
}

// Which inner containers the product has started so far (`docker start` INSIDE the project container), by name.
function started(fd, name, idOf) {
  const byId = Object.fromEntries(Object.entries(idOf).map(([n, id]) => [id, n]));
  return fd.calls({ daemon: name }).filter((a) => a.args[0] === "start").flatMap((a) => a.args.slice(1)).map((id) => byId[id] || id).sort();
}

// A reader of the global stream (/api/events) — shape of project-instances.test.js.
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

// Cleanup per test: a still-working row to `ready` — otherwise the harness quiet would wait for it forever after a failure
// (`projectWork`) instead of reporting the failure (pattern project-lock.test.js).
function cleanUpRows() {
  for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) {
    try { setInstanceState(z.projectId, z.instance, "ready"); } catch (e) { console.warn(`[restore] cleanup ${z.identifier}: ${e?.message || e}`); }
  }
}

const STACK_GEO = [
  { name: "geo-db-1", service: "db", healthy: true },
  { name: "geo-redis-1", service: "redis" },
  { name: "geo-minio-1", service: "minio", healthy: true },
  { name: "geo-migrate-1", service: "migrate", ends: 0, dependsOn: "db:service_healthy:false,redis:service_started:false,minio:service_healthy:false" },
  { name: "geo-ingest-1", service: "ingest", dependsOn: "migrate:service_completed_successfully:false,redis:service_started:false" },
  { name: "geo-transform-1", service: "transform", dependsOn: "migrate:service_completed_successfully:false" },
  { name: "geo-persist-1", service: "persist", dependsOn: "migrate:service_completed_successfully:false,minio:service_healthy:false" },
  { name: "geo-serve-1", service: "serve", healthy: true, dependsOn: "migrate:service_completed_successfully:false,db:service_healthy:false" },
];

// ── (4) Stages through the fake docker ──────────────────────────────────────────────────────────────────────────────

test("(4) stages: stage k starts only after healthy or exit 0 of k−1; then ready with a new snapshot", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name, idOf } = projectWithStack(ctx, fd, s, STACK_GEO);
      const desiredPrior = store.projectInstance(s.projectId).desired;
      await inOps(fd, s, async () => {
        const p = restoreInstance(s.projectId, "main", { reason: "Test" });
        assert.equal(store.projectInstance(s.projectId).state, "start", "synchronously in start");
        assert.equal(procedureAlive(s.projectId, "main"), true, "the procedure is entered");

        await fd.gateReached("healthy-geo-db-1");
        await fd.gateReached("healthy-geo-minio-1");
        assert.deepEqual(started(fd, name, idOf), ["geo-db-1", "geo-minio-1", "geo-redis-1"], "stage 0 — and nothing after it");
        assert.equal(store.projectInstance(s.projectId).phase, "stage 1/3");
        fd.openGate("healthy-geo-db-1");
        fd.openGate("healthy-geo-minio-1");

        await fd.gateReached("finished-geo-migrate-1");
        assert.deepEqual(started(fd, name, idOf), ["geo-db-1", "geo-migrate-1", "geo-minio-1", "geo-redis-1"], "stage 1 only after healthy of stage 0");
        fd.openGate("finished-geo-migrate-1");

        await fd.gateReached("healthy-geo-serve-1");
        assert.deepEqual(started(fd, name, idOf), Object.keys(idOf).sort(), "stage 2 only after exit 0 of migrate");
        fd.openGate("healthy-geo-serve-1");

        const row = await p;
        assert.equal(row.state, "ready");
        assert.equal(row.error, "", row.error);
        assert.equal(row.phase, "");
        assert.equal(procedureAlive(s.projectId, "main"), false);
        // Exactly one `start` of the project container, by id; no inner one twice.
        const host = fd.calls({ daemon: "host" }).map((a) => a.args);
        assert.deepEqual(host.filter((a) => a[0] === "start"), [["start", store.projectInstance(s.projectId).containerId]]);
        const all = fd.calls({ daemon: name }).filter((a) => a.args[0] === "start").flatMap((a) => a.args.slice(1));
        assert.equal(new Set(all).size, all.length, "an inner container started twice");
        // The new snapshot: younger, migrate is finished as required (exited), everything else runs.
        assert.ok(row.desired.time >= desiredPrior.time);
        assert.deepEqual(Object.fromEntries(row.desired.container.map((c) => [c.name, c.state])),
          Object.fromEntries(STACK_GEO.map((c) => [c.name, c.name === "geo-migrate-1" ? "exited" : "running"])));
      });
    } finally {
      for (const t of ["healthy-geo-db-1", "healthy-geo-minio-1", "finished-geo-migrate-1", "healthy-geo-serve-1"]) fd.openGate(t);
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(4c) restart: if the `start` of a stage breaks off after the first container, the beat starts the rest one by one — ready without a finding", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    // ORBIT after a deploy: the cap of the `docker start` broke off, the rest of the stage stayed as the stop chain left it.
    const fd = await fakeDocker({ programs: s.programs, startAbort: { [`^${projectContainer(s.projectId)}$`]: 1 } });
    try {
      const stack = [{ name: "a-db-1", service: "db" }, { name: "a-redis-1", service: "redis" }, { name: "a-weaviate-1", service: "weaviate" }];
      const { name, idOf } = projectWithStack(ctx, fd, s, stack);
      await inOps(fd, s, async () => {
        const row = await restoreInstance(s.projectId);
        assert.equal(row.state, "ready", row.error);
        assert.equal(row.error || "", "", "no finding — all three arrived");
        const byId = Object.fromEntries(Object.entries(idOf).map(([n, id]) => [id, n]));
        const running = JSON.parse(dx(fd, "exec", name, "docker", "inspect", ...Object.values(idOf))).filter((c) => c.State.Status === "running").map((c) => byId[c.Id]).sort();
        assert.deepEqual(running, ["a-db-1", "a-redis-1", "a-weaviate-1"], "all three run");
        const calls = fd.calls({ daemon: name }).filter((a) => a.args[0] === "start").map((a) => a.args.slice(1).map((id) => byId[id] || id));
        assert.equal(calls[0].length, 3, "first ONE start over the whole stage");
        assert.deepEqual(calls.slice(1).flat().sort(), ["a-redis-1", "a-weaviate-1"], "then one by one, what the abort left lying");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(4) one-shot containers with desired `exited` stay, a container that did not run before never starts", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const stack = [{ name: "a-db-1", service: "db" }, { name: "a-migrate-1", service: "migrate", dependsOn: "db" }, { name: "a-app-1", service: "app", dependsOn: "migrate:service_completed_successfully" }, { name: "a-old-1", service: "old" }];
      const { name, idOf } = projectWithStack(ctx, fd, s, stack);
      // Desired: migrate was finished (exited 0), "old" did not run (missing from the desired entirely), "foreign" is in the desired but does not exist.
      const desired = store.projectInstance(s.projectId).desired;
      desired.container = desired.container.filter((c) => c.name !== "a-old-1").map((c) => (c.name === "a-migrate-1" ? { ...c, state: "exited", exitCode: 0 } : c));
      desired.container.push({ name: "foreign", id: "f".repeat(64), service: "foreign", project: "geo", state: "running", exitCode: 0, dependsOn: "" });
      store.changeProjectInstance(s.projectId, "main", { desired });
      const prior = fd.calls({ daemon: name }).length;
      await inOps(fd, s, async () => {
        const row = await restoreInstance(s.projectId);
        assert.equal(row.state, "ready", row.error);
        const starts = fd.calls({ daemon: name }).slice(prior).filter((a) => a.args[0] === "start").flatMap((a) => a.args.slice(1));
        const byId = Object.fromEntries(Object.entries(idOf).map(([n, id]) => [id, n]));
        assert.deepEqual(starts.map((id) => byId[id] || id).sort(), ["a-app-1", "a-db-1"], "neither migrate (desired exited) nor old (not in the desired) nor foreign");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (5) unhealthy ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(5) an unhealthy service appears in the event project/instance; the next stage starts, the instance becomes ready anyway", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const reader = await globalReaderFor(ctx.base);
    try {
      const { name, idOf } = projectWithStack(ctx, fd, s, [{ name: "u-db-1", service: "db", healthy: true }, { name: "u-app-1", service: "app", dependsOn: "db:service_healthy" }]);
      fd.openGate("unhealthy-u-db-1");
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await ctx.barrier(reader, GLOBAL);
      await inOps(fd, s, async () => {
        const row = await restoreInstance(s.projectId);
        assert.equal(row.state, "ready");
        assert.match(row.error, /u-db-1 \(unhealthy\)/);
        assert.deepEqual(started(fd, name, idOf), ["u-app-1", "u-db-1"], "the next stage starts anyway");
      });
      const until = await ctx.barrier(reader, GLOBAL);
      const ev = reader.events.slice(bar, until).filter((e) => e.type === "project/instance" && e.projectId === s.projectId);
      assert.ok(ev.some((e) => e.state === "start" && /u-db-1 \(unhealthy\)/.test(e.error)), `no event during start names the service: ${JSON.stringify(ev)}`);
      const last = ev.at(-1);
      assert.equal(last.state, "ready");
      assert.match(last.error, /service\(s\) failed: u-db-1 \(unhealthy\)/);
      assert.ok(!ev.some((e) => JSON.stringify(e).includes(s.path)), "no path in the event");
    } finally {
      await reader.shutdown();
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (6) Cap per stage ───────────────────────────────────────────────────────────────────────────────────────────────

test("(6) cap per stage: a service that never becomes healthy does not hold start — clock seam ⇒ ready, busy falls, the event names it", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const reader = await globalReaderFor(ctx.base);
    try {
      const { name, idOf } = projectWithStack(ctx, fd, s, [{ name: "d-db-1", service: "db", healthy: true }, { name: "d-app-1", service: "app", dependsOn: "db:service_healthy" }]);
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await ctx.barrier(reader, GLOBAL);
      await inOps(fd, s, async () => {
        const p = restoreInstance(s.projectId);
        await fd.gateReached("healthy-d-db-1");
        assert.equal((await json(`${ctx.base}/api/runs/active`)).busy, true, "start holds busy");
        assert.deepEqual(started(fd, name, idOf), ["d-db-1"]);
        // The clock seam: the cap (an hour, set high) expires now. Without a cap there would be none — then 0, red.
        assert.ok(advanceStagesCap() >= 1, "no running stage cap — start would hang on this service forever");
        const row = await p;
        assert.equal(row.state, "ready");
        assert.match(row.error, /d-db-1 \(not arrived — stage cap of 3600000 ms hit\)/);
        assert.deepEqual(started(fd, name, idOf), ["d-app-1", "d-db-1"], "after the cap the next stage");
        assert.equal((await json(`${ctx.base}/api/runs/active`)).busy, false, "busy falls");
      });
      const until = await ctx.barrier(reader, GLOBAL);
      const ev = reader.events.slice(bar, until).filter((e) => e.type === "project/instance" && e.projectId === s.projectId);
      assert.ok(ev.some((e) => /d-db-1/.test(e.error) && /stage cap/.test(e.error)), JSON.stringify(ev));
    } finally {
      fd.openGate("healthy-d-db-1");
      await reader.shutdown();
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (7) phase=error ─────────────────────────────────────────────────────────────────────────────────────────────────

test("(7) phase=error ⇒ error with the reason from the status file and the recreate request; phase=ended ⇒ error without a request", async () => {
  await withAgentsServer(async (ctx) => {
    const requests = [];
    // The request comes AFTER the restore: occupancy and procedure are free — recreate creates from it, and with a held occupancy
    // "restore" its creation would get OCCUPIED (409).
    const free = [];
    setRecreateRequest((a) => { requests.push(a); free.push({ occupied: projectOccupied(a.projectId), alive: procedureAlive(a.projectId, a.instance) }); });
    const open = [];
    try {
      for (const [status, reason, request] of [
        ["phase=error\nnotice=cgroup: EBUSY while writing cgroup.subtree_control\n", /the entrypoint reports phase=error: cgroup: EBUSY while writing/, true],
        ["phase=ended\nnotice=dockerd exited with 1\n", /the entrypoint reports phase=ended: dockerd exited with 1/, false],
      ]) {
        const s = scenario(ctx, { status });
        const fd = await fakeDocker({ programs: s.programs });
        open.push(fd);
        const { name } = projectWithStack(ctx, fd, s, [{ name: "c-db-1", service: "db" }]);
        requests.length = 0;
        free.length = 0;
        await inOps(fd, s, async () => {
          const row = await restoreInstance(s.projectId);
          assert.equal(row.state, "error");
          assert.match(row.error, reason);
          assert.deepEqual(fd.calls({ daemon: name }).filter((a) => a.args[0] === "start"), [], "no inner container started");
        });
        await new Promise((r) => setImmediate(r));
        if (request) {
          assert.equal(requests.length, 1, JSON.stringify(requests));
          assert.deepEqual(Object.keys(requests[0]).sort(), ["instance", "projectId", "reason"]);
          assert.equal(requests[0].projectId, s.projectId);
          assert.equal(requests[0].instance, "main");
          assert.match(requests[0].reason, reason);
          assert.deepEqual(free, [{ occupied: null, alive: false }], "the request came while the restore still held the project");
        } else assert.deepEqual(requests, [], "ended is no case for recreate");
      }
      // Without a hook (default): error, nothing more — no throw.
      setRecreateRequest(null);
      const s = scenario(ctx, { status: "phase=error\nnotice=dnat: iptables missing\n" });
      const fd = await fakeDocker({ programs: s.programs });
      open.push(fd);
      projectWithStack(ctx, fd, s, []);
      await inOps(fd, s, async () => {
        const row = await restoreInstance(s.projectId);
        assert.equal(row.state, "error");
        assert.match(row.error, /dnat: iptables missing/);
      });
    } finally {
      setRecreateRequest(null);
      cleanUpRows();
      for (const fd of open) fd.cleanUp();
    }
  });
});

// ── (8) mark ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(8) without a valid mark of the network separation: error, and no docker call — neither start nor inspect", async () => {
  await withAgentsServer(async (ctx) => {
    const open = [];
    try {
      for (const [marker, reason] of [[null, /marker missing/], ["4100\n", /marker foreign-start/]]) {
        const s = scenario(ctx, { marker });
        const fd = await fakeDocker({ programs: s.programs });
        open.push(fd);
        projectWithStack(ctx, fd, s, [{ name: "m-db-1", service: "db" }]);
        const prior = fd.calls().length;
        await inOps(fd, s, async () => {
          const row = await restoreInstance(s.projectId);
          assert.equal(row.state, "error");
          assert.match(row.error, /network separation is missing/);
          assert.match(row.error, reason);
        });
        assert.deepEqual(fd.calls().slice(prior), [], "without a mark no docker");
      }
    } finally {
      cleanUpRows();
      for (const fd of open) fd.cleanUp();
    }
  });
});

// ── (9) The restart hook ────────────────────────────────────────────────────────────────────────────────────────────

test("(9) earmarking before listening and restart: start for converted rows in ready/error/start (without docker); the restart enters their procedure synchronously, hands orphaned recreates to the hook; others stay; without ops nothing", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const f = scenario(ctx);
    const a = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      projectWithStack(ctx, fd, s, []);
      projectWithStack(ctx, fd, f, [], { state: "error" });
      setInstanceState(f.projectId, "main", "error", { error: "from the last start" });
      // a row that a crash left on `start` in the middle of a restore.
      projectWithStack(ctx, fd, a, [], { state: "start" });
      // Not converted (without converted_at) and a row in `relocation`: neither belongs to the restore. Plus an orphaned recreate:
      // it goes to the hook, not to the restore.
      store.createProjectInstance({ projectId: "p-without-conversion", state: "ready" });
      store.createProjectInstance({ projectId: "p-in-relocation", state: "relocation", convertedAt: Date.now() });
      store.createProjectInstance({ projectId: "p-recreate-orphaned", state: "recreate", phase: "stop", convertedAt: Date.now() });
      const state = (pid) => store.projectInstance(pid).state;
      const three = () => [state(s.projectId), state(f.projectId), state(a.projectId)];

      // Without the ops mark nothing — no state, no docker.
      const prior = fd.calls().length;
      assert.equal(earmarkRestore(), 0);
      assert.equal(restoreRestartGrace(), undefined);
      assert.deepEqual(three(), ["ready", "error", "start"]);
      assert.deepEqual(fd.calls().slice(prior), []);

      await inOps(fd, s, async () => {
        const resumed = [];
        setRecreateRestartGrace({ resume: (request) => { resumed.push({ ...request, state: state(request.projectId) }); return Promise.resolve(null); } });
        try {
          // Earmarking (startServer, before listening): all three converted ones to start, without docker and without procedure.
          assert.equal(earmarkRestore(), 3);
          assert.deepEqual(three(), ["start", "start", "start"]);
          assert.equal(store.projectInstance(f.projectId).error, "", "the old reason does not stand next to start");
          assert.ok(![s, f, a].some((x) => procedureAlive(x.projectId, "main")), "earmarked means: no procedure yet");
          assert.deepEqual(fd.calls().slice(prior), [], "earmarking is without docker");
          assert.deepEqual([state("p-without-conversion"), state("p-in-relocation"), state("p-recreate-orphaned")], ["ready", "relocation", "recreate"]);

          const p = restoreRestartGrace();
          // SYNCHRONOUSLY, right after the call: every procedure lives ("project-instances" thus leaves the rows alone), the
          // orphaned recreate is at the hook.
          assert.ok([s, f, a].every((x) => procedureAlive(x.projectId, "main")), "the restart did not enter every procedure synchronously");
          assert.deepEqual(resumed, [{ projectId: "p-recreate-orphaned", instance: "main", reason: "restart grace: resume recreate", state: "recreate" }]);
          assert.deepEqual([state("p-without-conversion"), state("p-in-relocation")], ["ready", "relocation"]);
          await p;
          assert.deepEqual(three(), ["ready", "ready", "ready"], "error and the rest of a crash ⇒ a new attempt");
        } finally {
          setRecreateRestartGrace(recreateRestartGraceSeam);
        }
      });
    } finally {
      store.deleteProjectInstance("p-without-conversion");
      store.deleteProjectInstance("p-in-relocation");
      store.deleteProjectInstance("p-recreate-orphaned");
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(9) restoreInstance throws only before the procedure: without ops, without a converted row, unknown state", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      projectWithStack(ctx, fd, s, []);
      await assert.rejects(restoreInstance(s.projectId), (e) => e.code === "NO_OPS" && e.status === 404);
      await inOps(fd, s, async () => {
        await assert.rejects(restoreInstance("exists-not"), (e) => e.code === "NO_INSTANCE");
        await assert.rejects(restoreInstance(s.projectId, "main", { state: "ready" }), TypeError);
      });
      assert.equal(store.projectInstance(s.projectId).state, "ready", "the row stayed");
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (10) Hooks ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(10) atReady after the transition (asynchronous, a throw only logged); native services with a starter and without", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const t = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const called = [];
    const starter = [];
    const ab1 = atReady(() => { throw new Error("callback throws on purpose"); });
    const ab2 = atReady(({ projectId, instance, row }) => {
      called.push({ projectId, instance, state: row.state, now: store.projectInstance(projectId).state, occupied: projectOccupied(projectId), alive: procedureAlive(projectId, instance) });
    });
    try {
      projectWithStack(ctx, fd, s, [], { desired: { services: [{ id: "svc-1" }, "svc-2"] } });
      projectWithStack(ctx, fd, t, [], { desired: { services: [{ id: "svc-3" }] } });
      await inOps(fd, s, async () => {
        setNativeServicesStarter(async (projectId, ids) => { starter.push({ projectId, ids }); });
        const row = await restoreInstance(s.projectId);
        assert.equal(row.state, "ready", row.error);
        assert.equal(row.error, "");
        assert.deepEqual(starter, [{ projectId: s.projectId, ids: ["svc-1", "svc-2"] }]);
        assert.deepEqual(called, [], "atReady runs AFTER the transition, not in it");
        await waitForTruthy(() => called.length === 1, "atReady");
        // After the transition AND after the restore: occupancy and procedure are free (a callback may occupy the project).
        assert.deepEqual(called[0], { projectId: s.projectId, instance: "main", state: "ready", now: "ready", occupied: null, alive: false });

        setNativeServicesStarter(null);
        const z2 = await restoreInstance(t.projectId);
        assert.equal(z2.state, "ready");
        assert.match(z2.error, /native services not started \(no starter attached\): svc-3/);
        await waitForTruthy(() => called.length === 2, "atReady (zweite)");

        // The starter NEVER throws (services.js startDesiredServices) — it reports `{ started, error, alreadyRunning }`. Every entry
        // in `error` stands in the finding of the row and in the event project/instance, without paths; a throw likewise.
        const reader = await globalReaderFor(ctx.base);
        try {
          await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
          const bar = await ctx.barrier(reader, GLOBAL);
          setNativeServicesStarter(async (projectId, ids) => {
            starter.push({ projectId, ids });
            return { started: [9], alreadyRunning: [], error: [{ id: 7, reason: "Port 3000 is already in use" }, { id: 11, reason: "spawn /home/agent/secret/start.sh ENOENT" }] };
          });
          const z3 = await restoreInstance(s.projectId);
          assert.equal(z3.state, "ready", "a failed service does not hold the instance (ready with a finding)");
          assert.match(z3.error, /native service 7: Port 3000 is already in use/, `the finding is silent about the service: ${JSON.stringify(z3.error)}`);
          assert.match(z3.error, /native service 11: spawn … ENOENT/);
          assert.ok(!z3.error.includes("/home/agent"), `a path in the finding: ${z3.error}`);
          const until = await ctx.barrier(reader, GLOBAL);
          const ev = reader.events.slice(bar, until).filter((e) => e.type === "project/instance" && e.projectId === s.projectId);
          assert.ok(ev.some((e) => e.state === "ready" && /native service 7: Port 3000/.test(e.error)), `the event does not name the service: ${JSON.stringify(ev)}`);
          setNativeServicesStarter(async () => { throw new Error("broken in /data/x"); });
          const z4 = await restoreInstance(s.projectId);
          assert.match(z4.error, /native services: broken in …/);
        } finally { await reader.shutdown(); }
        await waitForTruthy(() => called.length === 4, "atReady (vierte)");
      });
    } finally {
      ab1(); ab2();
      setNativeServicesStarter(null);
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// ── (11) Order ──────────────────────────────────────────────────────────────────────────────────────────────────────

// The main agent writes one line per turn to main.jsonl; "WF[tag]:{json}" calls cbase_dynamic_workflow (result under wf-<tag>) and
// then holds at gate end-<tag>, BEFORE its answer and its result — the end of this turn is an event the test triggers itself (see
// (11) in the header). A workflow agent: {TAG:x} names it (every spawn appends an "x" to sub-start-<tag>), {GATE:x} holds it at gate
// x-<spawn count>. (Shape of project-lock.test.js — a test file imports no other.)
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ turn, text }) + "\\n");
  const wf = text.indexOf("WF[");
  if (wf >= 0 && !text.includes("<task-notification>")) {
    const tag = text.slice(wf + 3, text.indexOf("]:", wf));
    const args = JSON.parse(text.slice(text.indexOf("]:", wf) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".part", t); fs.renameSync(z + ".part", z); } // atomic: the test waits only for existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    await gate("end-" + tag);
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Answer " + turn }] } });
  finished();
  say({ type: "result", result: "Answer " + turn, session_id: "main-session" });`;
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.appendFileSync(path.join(LOCATION, "sub-start-" + tag), "x");
    const nr = fs.readFileSync(path.join(LOCATION, "sub-start-" + tag), "utf8").length;
    say({ type: "assistant", message: { id: "s-" + tag + nr, content: [{ type: "text", text: "working " + tag }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0] + "-" + nr);
    finished();
    say({ type: "result", result: "Finding " + tag + " #" + nr, session_id: "sub-" + tag + nr });`;
const CLAUDE_ORDER = fakeClaude({ main: MAIN, sub: SUB });
const turns = (root) => readJsonl(path.join(root, "main.jsonl"));
const spawns = (root, tag) => { const f = path.join(root, `sub-start-${tag}`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").length : 0; };
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });

// Without an account (shape of project-lock.test.js): waking a wait row checks the limit — without this the server would read the
// keychain and ask the usage endpoint of the REAL account. Plus `npx` as idle (with a redirected HOME every server would load the
// Playwright MCP over the network).
async function withoutAccount(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-restore-account-"));
  const prior = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, NPX_BIN: process.env.NPX_BIN };
  try {
    const shim = path.join(root, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "security"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(shim, "npx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const d of ["home", "codex-home"]) fs.mkdirSync(path.join(root, d));
    process.env.HOME = path.join(root, "home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    process.env.PATH = `${shim}:${process.env.PATH}`;
    process.env.NPX_BIN = path.join(shim, "npx");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn(`Cleanup of ${root}: ${e.code || e.message}`); }
  }
}

test("(11) order: after the restart the row is start BEFORE dyn-workflows and channel-restart-grace fire; the workflow agent waits instead of failing, the channel turn runs only after ready", async () => {
  const priorStagger = process.env.CBASE_DYNWF_STAGGER_MS;
  process.env.CBASE_DYNWF_STAGGER_MS = "0";
  let fd = null;
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ programs: s.programs });
      const chatId = ctx.chat.id;
      try {
        await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: s.projectId }) });
        await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });

        // A dynamic workflow in the project, its agent holds at the gate. No instance row yet — it starts in B.
        const script = [
          "export const meta = { name: 'again', description: 'Restore', phases: [{ title: 'One' }] }",
          "const a = await agent('A {TAG:a} {GATE:a}', { label: 'a' });",
          "return { a };",
        ].join("\n");
        await post(`${ctx.base}/api/chats/${chatId}/message`, { text: `WF[w]:${JSON.stringify({ script })}` });
        await waitForTruthy(() => fs.existsSync(path.join(ctx.root, "wf-w")), "tool result");
        const r = JSON.parse(fs.readFileSync(path.join(ctx.root, "wf-w"), "utf8"));
        assert.equal(r.status, "started", JSON.stringify(r));
        await ctx.gate.reached("a-1");
        // The main turn must be OVER before the channel message arises (see the header, (11)): its end fires "turnEnd" with open
        // background work, and that delivers unread messages to the free chat — the message would then run before the restart
        // instead of waiting for it. `runs: 0` means "turnEnd" has already fired (runs/do-run.js finally: running.delete and the
        // end of the work without an await in between).
        await ctx.gate.reached("end-w");
        ctx.gate.open("end-w");
        await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "main turn over");

        // The project is converted (row `ready` with snapshot); its stack stands as after the stop chain. Plus an open channel with
        // an unread message to this chat.
        const { name, idOf } = projectWithStack(ctx, fd, s, [
          { name: "k-db-1", service: "db", healthy: true },
          { name: "k-app-1", service: "app", dependsOn: "db:service_healthy:false" },
        ]);
        const channel = store.createChannel({ id: `channel-${s.projectId}`, workspaceId: ctx.ws.id, name: "Recovery" });
        store.addChannelParticipants(channel.id, { chatId });
        store.addChannelMessage({ channelId: channel.id, senderKind: "system", text: "CHANNEL-JOB" });

        const seen = [];
        await inOps(fd, s, async () => {
          // The restart IN ops mode — startServer earmarks the converted row BEFORE listening (earmarkRestore), without docker and
          // without procedure; the restart hook then takes it in `start`.
          await ctx.restart({ withBackground: true });
          assert.equal(store.projectInstance(s.projectId).state, "start", "startServer did not earmark the row before listening");
          assert.ok(!procedureAlive(s.projectId, "main"), "earmarked means: no procedure yet");
          assert.equal(store.readDynRun(r.runId).status, "interrupted");
          // The precondition of the channel restart: the message is still UNREAD at the restart. Without this line a broken order
          // above would hang without limit at "channel turn after ready" instead of turning red here.
          assert.equal(store.channelUnread(channel.id, chatId), 1, "the channel message went out BEFORE the restart — the main turn was still open when it arose");
          const journalPrior = store.readDynJournal(r.runId).length;
          const turnsPrior = turns(ctx.root).length;

          observeHooks((info) => {
            if (info.kind === "restartGrace" && info.phase === "start") seen.push({ name: info.name, index: info.index, state: store.projectInstance(s.projectId)?.state });
          });
          try { await fireHooks("restartGrace", {}); } finally { observeHooks(null); }

          // The order: the restore first, and every later consumer sees the row in `start`.
          const at = (n) => seen.find((g) => g.name === n);
          // Before it only "project-thaw" (a paused container gets unpause instead of start) — and before that "project-layout": the
          // lock of the open layout jobs stands before any path lets turns start again (synchronous, touching no rows).
          assert.equal(seen[0]?.name, "project-layout", `the layout is not the first restart consumer: ${JSON.stringify(seen)}`);
          assert.equal(seen[1]?.name, "project-thaw", `the thaw is not the second restart consumer: ${JSON.stringify(seen)}`);
          assert.equal(seen[2]?.name, "project-restore", `not registered first after the thaw: ${JSON.stringify(seen)}`);
          for (const n of ["project-restore", "agent-orphaned", "channel-restart-grace", "dyn-workflows", "project-instances"]) {
            assert.equal(at(n)?.state, "start", `"${n}" did not see the row in start: ${JSON.stringify(seen)}`);
          }
          // Right after the chain: the row stands `start`, and its procedure LIVES — the restore entered it synchronously before
          // "project-instances" looked for working rows without a procedure (else it would stand on `error` here).
          assert.equal(store.projectInstance(s.projectId).state, "start", `after the chain: ${JSON.stringify(store.projectInstance(s.projectId))}`);
          assert.ok(procedureAlive(s.projectId, "main"), "after the chain no restore procedure lives");

          // The instance hangs in stage 1 (db becomes healthy only with the gate). The resumed workflow agent waits at the lock — no
          // spawn, no failure — and the channel turn does not run.
          await fd.gateReached("healthy-k-db-1");
          const fresh = await waitForTruthy(() => store.readDynJournal(r.runId).slice(journalPrior).find((e) => e.kind !== "launched") || null, "state of the resumed agent");
          assert.equal(fresh.kind, "waiting", `the agent does not wait: ${JSON.stringify(fresh)}`);
          assert.equal(fresh.reason, "project");
          assert.equal(spawns(ctx.root, "a"), 1, "no spawn while the instance starts");
          assert.equal((await json(`${ctx.base}/api/runs/active`)).runs, 0, "no turn while the instance starts");
          assert.equal(turns(ctx.root).length, turnsPrior, "the channel turn ran before ready");
          assert.equal(store.projectInstance(s.projectId).state, "start");

          fd.openGate("healthy-k-db-1");
          await ctx.gate.reached("a-2");
          assert.equal(store.projectInstance(s.projectId).state, "ready", "the agent started before ready");
          ctx.gate.open("a-2");
          const run = await waitForTruthy(() => (store.readDynRun(r.runId)?.status !== "running" ? store.readDynRun(r.runId) : null), "run over");
          assert.equal(run.status, "finished", JSON.stringify(run));
          assert.ok(!store.readDynJournal(r.runId).some((e) => e.kind === "failed"), JSON.stringify(store.readDynJournal(r.runId).filter((e) => e.kind === "failed")));
          await waitForTruthy(() => turns(ctx.root).slice(turnsPrior).some((t) => String(t.text).includes("CHANNEL-JOB")), "channel turn after ready");
          await ctx.waitForQuiet();

          // In the fake docker's log: every start of the CLI (workflow agent, channel turn) comes AFTER the start of the project
          // container and after the start of the last inner service.
          const all = fd.calls();
          const hostStart = all.findIndex((a) => a.daemon === "host" && a.args[0] === "start");
          const insideStarts = all.map((a, i) => (a.daemon === name && a.args[0] === "start" ? i : -1)).filter((i) => i >= 0);
          const cli = all.map((a, i) => (a.daemon === "host" && a.args[0] === "exec" && a.args.includes(process.env.CLAUDE_BIN) ? i : -1)).filter((i) => i >= 0);
          assert.ok(hostStart >= 0 && insideStarts.length === 2, `starts: host ${hostStart}, inside ${insideStarts}`);
          assert.ok(cli.length >= 2, `the CLI did not run in the project container: ${cli.length}`);
          assert.ok(cli[0] > Math.max(hostStart, ...insideStarts), `a run before the restore (CLI ${cli[0]}, host ${hostStart}, inside ${insideStarts})`);
          assert.deepEqual(started(fd, name, idOf), ["k-app-1", "k-db-1"]);
        }, {
          CBASE_IN_PROJECT_ESCALATION_MS: "200",
          CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
        });
      } finally {
        fd.openGate("healthy-k-db-1");
        cleanUpRows();
      }
    }, { claude: CLAUDE_ORDER }));
  } finally {
    if (priorStagger === undefined) delete process.env.CBASE_DYNWF_STAGGER_MS; else process.env.CBASE_DYNWF_STAGGER_MS = priorStagger;
    fd?.cleanUp();
  }
});

// ── (12) The window between listening and restart ───────────────────────────────────────────────────────────────────

test("(12) window: a message after the restart, BEFORE the restart hook, waits (queued) and runs only after ready in the project container", async () => {
  let fd = null;
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ programs: s.programs });
      const chatId = ctx.chat.id;
      try {
        await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: s.projectId }) });
        const { name, idOf } = projectWithStack(ctx, fd, s, [{ name: "f-db-1", service: "db", healthy: true }]);
        await inOps(fd, s, async () => {
          await ctx.restart();
          const prior = fd.calls().length;
          const turnsPrior = turns(ctx.root).length;
          // The window: the server listens, the restart hook (restartMs after listening) has not fired yet. The message waits at the
          // lock — otherwise it would go to the stopped container through inProject (the row would stand `ready`).
          const a = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "IM-WINDOW" });
          assert.equal(a.queued, true, `the message in the window did not wait: ${JSON.stringify(a)}`);
          assert.equal(a.locked, true, JSON.stringify(a));
          assert.equal(store.projectInstance(s.projectId).state, "start");
          assert.deepEqual(fd.calls().slice(prior), [], "no docker in the window");

          await fireHooks("restartGrace", {});
          // The restore hangs in stage 0 (db becomes healthy only with the gate): no turn yet.
          await fd.gateReached("healthy-f-db-1");
          assert.equal(turns(ctx.root).length, turnsPrior, "the turn ran before ready");
          assert.equal((await json(`${ctx.base}/api/runs/active`)).runs, 0);
          fd.openGate("healthy-f-db-1");
          await waitForTruthy(() => turns(ctx.root).slice(turnsPrior).some((t) => String(t.text).includes("IM-WINDOW")), "turn after ready");
          await ctx.waitForQuiet();

          // In the log: the CLI ran in the project container, and only after its start and the start of the inner service.
          const all = fd.calls();
          const hostStart = all.findIndex((x, i) => i >= prior && x.daemon === "host" && x.args[0] === "start");
          const inside = all.findIndex((x, i) => i >= prior && x.daemon === name && x.args[0] === "start");
          const cli = all.findIndex((x, i) => i >= prior && x.daemon === "host" && x.args[0] === "exec" && x.args.includes(process.env.CLAUDE_BIN));
          assert.ok(hostStart >= 0 && inside >= 0 && cli >= 0, `starts: host ${hostStart}, inside ${inside}, CLI ${cli}`);
          assert.ok(cli > Math.max(hostStart, inside), `the CLI ran before the restore (CLI ${cli}, host ${hostStart}, inside ${inside})`);
          assert.deepEqual(started(fd, name, idOf), ["f-db-1"]);
          assert.equal(store.projectInstance(s.projectId).state, "ready");
        }, {
          CBASE_IN_PROJECT_ESCALATION_MS: "200",
          CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
        });
      } finally {
        fd.openGate("healthy-f-db-1");
        cleanUpRows();
      }
    }, { claude: CLAUDE_ORDER }));
  } finally {
    fd?.cleanUp();
  }
});

// ── (13) The missing container ──────────────────────────────────────────────────────────────────────────────────────

// A project container without inner stack, stopped, with a converted row — without `exec` (projectWithStack reads the stack via
// exec; with "exec broken" that would not work). `label` is the label cbase.project it carries.
function projectWithoutStack(fd, s, label = s.projectId) {
  const name = projectContainer(s.projectId);
  const cid = dx(fd, "run", "-d", "--name", name, "--label", `cbase.project=${label}`, "cbase-projectbox:latest");
  store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, desired: desiredFromInspect([]) });
  dx(fd, "stop", name);
  return name;
}

test("(13) container missing ⇒ error AND the recreate request; a foreign label and a broken exec stay error WITHOUT a request", async () => {
  await withAgentsServer(async (ctx) => {
    const requests = [];
    setRecreateRequest((a) => { requests.push(a); });
    const open = [];
    try {
      for (const [fall, reason, request] of [
        ["missing", /the project container cbase-p-\S+ is missing/, true],
        ["foreign label", /does not carry the label of this project \(cbase\.project=p-foreign\)/, false],
        ["exec broken", /does not answer after \d+ attempt\(s\) — cap/, false],
      ]) {
        const s = scenario(ctx);
        const name = projectContainer(s.projectId);
        const fd = await fakeDocker({ programs: s.programs, execBroken: fall === "exec broken" ? [name] : [] });
        open.push(fd);
        projectWithoutStack(fd, s, fall === "foreign label" ? "p-foreign" : s.projectId);
        if (fall === "missing") dx(fd, "rm", name);
        requests.length = 0;
        // The cap of the creation (same way as waitForInside) small ONLY in the case "exec broken": the container never answers
        // there, and the cap is the exit the product has for it — not a criterion of the test.
        await inOps(fd, s, async () => {
          const row = await restoreInstance(s.projectId, "main", { reason: `Test ${fall}` });
          assert.equal(row.state, "error", `${fall}: ${JSON.stringify(row)}`);
          assert.match(row.error, reason, fall);
        }, fall === "exec broken" ? { CBASE_PROJECTBOX_CREATION_MS: "200" } : {});
        await new Promise((r) => setImmediate(r));
        if (request) {
          assert.equal(requests.length, 1, `${fall}: ${JSON.stringify(requests)}`);
          assert.deepEqual(Object.keys(requests[0]).sort(), ["instance", "projectId", "reason"]);
          assert.equal(requests[0].projectId, s.projectId);
          assert.equal(requests[0].instance, "main");
          assert.match(requests[0].reason, reason);
          assert.equal(fd.calls({ daemon: "host" }).filter((x) => ["start", "run"].includes(x.args[0])).length, 1, "only the seeding created — the restore does NOT create itself");
        } else assert.deepEqual(requests, [], `${fall} is no case for recreate`);
      }
    } finally {
      setRecreateRequest(recreateRequest);
      cleanUpRows();
      for (const fd of open) fd.cleanUp();
    }
  });
});

// ── (14)–(19) Further guards ────────────────────────────────────────────────────────────────────────────────────────

test("(14) the server end writes `desired` only for a row in ready — in the middle of a restore and in error with a running container the last one counts", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name } = projectWithStack(ctx, fd, s, [{ name: "e-db-1", service: "db", healthy: true }, { name: "e-app-1", service: "app", dependsOn: "db:service_healthy" }]);
      const prior = store.projectInstance(s.projectId).desired;
      await inOps(fd, s, async () => {
        // (a) Stage 1 waits for healthy of db, app is not started yet — a half state, not the intention.
        const p = restoreInstance(s.projectId, "main", { reason: "Test" });
        await fd.gateReached("healthy-e-db-1");
        assert.equal(store.projectInstance(s.projectId).state, "start");
        await projectboxServerEnd();
        assert.deepEqual(store.projectInstance(s.projectId).desired, prior, "the server end wrote the half state of a restore as the intention");
        await carryOut(fd); // the stop chain stopped the project container — the restore ends (how, (18) checks)
        await p;
        // (b) error, but project container and inner dockerd run (phase=error with a running dockerd): db runs, app does not.
        setInstanceState(s.projectId, "main", "error", { error: "Test: entrypoint reports phase=error" });
        dx(fd, "start", name);
        dx(fd, "exec", name, "docker", "start", "e-db-1");
        await projectboxServerEnd();
        assert.deepEqual(store.projectInstance(s.projectId).desired, prior, "the server end wrote the broken state of a row in error as the intention");
        // (c) ready: written as before.
        setInstanceState(s.projectId, "main", "ready");
        dx(fd, "start", name);
        const r = await projectboxServerEnd();
        assert.equal(r.snapshots, 1);
        assert.deepEqual(Object.fromEntries(store.projectInstance(s.projectId).desired.container.map((c) => [c.name, c.state])),
          { "e-app-1": "exited", "e-db-1": "running" }, "no new snapshot in ready");
      });
    } finally {
      fd.openGate("healthy-e-db-1");
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(15) a desired container that did not arrive stays running with a mark — also via its name (new id) and across the server end; the next start tries it again", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      const { name, idOf } = projectWithStack(ctx, fd, s, [{ name: "m-db-1", service: "db" }, { name: "m-job-1", service: "job", ends: 1 }]);
      // job was recreated after the snapshot — the desired holds an old id, it is found via the name.
      const desired = store.projectInstance(s.projectId).desired;
      desired.container = desired.container.map((c) => (c.name === "m-job-1" ? { ...c, id: "f".repeat(64) } : c));
      store.changeProjectInstance(s.projectId, "main", { desired });
      fd.openGate("finished-m-job-1"); // started, it ends at once with exit 1
      const stateOf = (n) => {
        const c = store.projectInstance(s.projectId).desired.container.find((x) => x.name === n);
        return c && `${c.state}${c.failed ? "+failed" : ""}`;
      };
      const jobStarts = () => started(fd, name, idOf).filter((n) => n === "m-job-1").length;
      await inOps(fd, s, async () => {
        const z1 = await restoreInstance(s.projectId);
        assert.equal(z1.state, "ready", z1.error);
        assert.match(z1.error, /m-job-1 \(ended \(exit 1\)\)/);
        assert.equal(jobStarts(), 1);
        assert.equal(stateOf("m-job-1"), "running+failed", "the failed desired container with a new id was forgotten");
        assert.equal(stateOf("m-db-1"), "running");
        // The server end writes from the actual state (job stands exited) — the mark stays.
        await projectboxServerEnd();
        assert.equal(stateOf("m-job-1"), "running+failed", "the server end wrote the failed container as exited");
        const z2 = await restoreInstance(s.projectId);
        assert.equal(z2.state, "ready");
        assert.equal(jobStarts(), 2, "the next start did not try the failed container again");
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(16) desired.services fresh at write time — a start/stop through cbase during the stages or during the server-end snapshot is not lost; the services phase starts the fresh list", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const t = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const fd2 = await fakeDocker({ programs: t.programs, inspectGate: "snapshot" });
    const starter = [];
    try {
      projectWithStack(ctx, fd, s, [{ name: "r-db-1", service: "db", healthy: true }], { desired: { services: [7] } });
      await inOps(fd, s, async () => {
        setNativeServicesStarter(async (projectId, ids) => { starter.push(ids); return { started: ids.map(Number), error: [], alreadyRunning: [] }; });
        const p = restoreInstance(s.projectId);
        await fd.gateReached("healthy-r-db-1");
        // In the middle of stage 1: the human stops service 7 and starts service 9 (same way as services.js, the route is not
        // locked in `start`).
        carryForwardServiceDesired(s.projectId, 7, false);
        carryForwardServiceDesired(s.projectId, 9, true);
        fd.openGate("healthy-r-db-1");
        const z = await p;
        assert.equal(z.state, "ready", z.error);
        assert.deepEqual(z.desired.services, [9], "the old state of the services overwrote the start/stop during the stages");
        assert.deepEqual(starter, [["9"]], "the services phase started the old list");
      });
      // The server end: the snapshot hangs at `inspect` (gate), in between service 9 starts.
      fd2.openGate("snapshot");
      const { name } = projectWithStack(ctx, fd2, t, [{ name: "q-db-1", service: "db" }], { desired: { services: [7] } });
      fd2.closeGate("snapshot");
      dx(fd2, "start", name);
      await inOps(fd2, t, async () => {
        const end = projectboxServerEnd();
        await fd2.gateReached("snapshot");
        carryForwardServiceDesired(t.projectId, 9, true);
        fd2.openGate("snapshot");
        const r = await end;
        // The row of s also stands on ready, but its container lives in the other fake docker — its exec fails, the last one
        // counts; exactly that of t is written.
        assert.equal(r.snapshots, 1, JSON.stringify(r));
        assert.deepEqual(store.projectInstance(t.projectId).desired.services, [7, 9], "the snapshot at server end overwrote the start of service 9");
      }, { CBASE_SNAPSHOT_MS: "3600000" });
    } finally {
      setNativeServicesStarter(null);
      fd.openGate("healthy-r-db-1");
      fd2.openGate("snapshot");
      cleanUpRows();
      fd.cleanUp();
      fd2.cleanUp();
    }
  });
});

test("(17) OCCUPIED comes WITHOUT touching the row — next to an occupancy (erase) and next to a living procedure; when free it works", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    try {
      projectWithStack(ctx, fd, s, []);
      await inOps(fd, s, async () => {
        const prior = store.projectInstance(s.projectId);
        for (const [kind, hold] of [
          ["occupancy \"erase\"", (gate) => withProjectOccupancy(s.projectId, "erase", () => gate)],
          ["living procedure", (gate) => withProcedure(s.projectId, "main", () => gate)],
        ]) {
          let go;
          const gate = new Promise((r) => { go = r; });
          const holders = hold(gate);
          try {
            const beforeCalls = fd.calls().length;
            await assert.rejects(restoreInstance(s.projectId, "main", { reason: "Git wake-up" }), (e) => e.code === "OCCUPIED" && e.status === 409, kind);
            const now = store.projectInstance(s.projectId);
            assert.deepEqual([now.state, now.phase], [prior.state, prior.phase], `${kind}: the row stayed in another state without a living procedure`);
            assert.deepEqual(fd.calls().slice(beforeCalls), [], `${kind}: docker called`);
          } finally {
            go();
            await holders;
          }
        }
        const z = await restoreInstance(s.projectId);
        assert.equal(z.state, "ready", z.error);
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// The restore runs under the occupancy of the INSTANCE — main and copy of the same project come up side by side at restart.
// COUNTER-PROBE: restore.js with a project-wide occupancy around the restore ⇒ red (the copy hits OCCUPIED, the restart sets it
// to `error`).
test("(17b) main and copy of the same project at the restart ⇒ both ready, each container started (instance occupancy)", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const kname = `cbase-k-${s.projectId}-k1`;
    try {
      const { cid } = projectWithStack(ctx, fd, s, []);
      const kid = dx(fd, "run", "-d", "--name", kname, "--label", `cbase.project=${s.projectId}`, "--label", "cbase.instance=copy-k1", "--label", "cbase.chat=c1", "cbase-projectbox:latest");
      store.createProjectInstance({ projectId: s.projectId, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: kid, chatId: "c1", copyName: "k1", desired: desiredFromInspect([]) });
      dx(fd, "stop", kname);
      await inOps(fd, s, async () => {
        setRecreateRestartGrace({ resume: () => Promise.resolve(null) });
        try {
          assert.equal(earmarkRestore(), 2);
          const p = restoreRestartGrace();
          assert.ok(procedureAlive(s.projectId, "main") && procedureAlive(s.projectId, "copy-k1"), "the restart did not enter both procedures synchronously");
          await p;
          const main = store.projectInstance(s.projectId, "main");
          const copy = store.projectInstance(s.projectId, "copy-k1");
          assert.deepEqual([main.state, main.error], ["ready", ""]);
          assert.deepEqual([copy.state, copy.error], ["ready", ""], "the copy did not come up next to its main");
          const starts = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "start").map((a) => a.args[1]);
          assert.deepEqual(starts.sort(), [cid, kid].sort(), "one docker start per instance, by id");
        } finally {
          setRecreateRestartGrace(recreateRestartGraceSeam);
        }
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

// The same case through the REAL path — restart (earmarkRestore at startup sets both rows to `start`) and the whole hook chain
// "restartGrace" (the restore first of its kind, "project-instances" synchronously later in the same chain). Right after the chain
// EVERY procedure lives and no row stands on `error`; then both `ready`. COUNTER-PROBES: restore.js restoring an instance under a
// project-wide occupancy ⇒ red (the copy hits OCCUPIED, then error); the copy only behind the promise of the main ⇒ red
// ("project-instances" sets it to error).
test("(17c) main and copy after the restart through the whole hook chain \"restartGrace\" ⇒ both procedures live right after the chain, no row on error, then both ready", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const kname = `cbase-k-${s.projectId}-k1`;
    const inst = ["main", "copy-k1"];
    const states = () => inst.map((i) => store.projectInstance(s.projectId, i)?.state);
    try {
      const { cid } = projectWithStack(ctx, fd, s, []);
      const kid = dx(fd, "run", "-d", "--name", kname, "--label", `cbase.project=${s.projectId}`, "--label", "cbase.instance=copy-k1", "--label", "cbase.chat=c1", "cbase-projectbox:latest");
      store.createProjectInstance({ projectId: s.projectId, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: kid, chatId: "c1", copyName: "k1", desired: desiredFromInspect([]) });
      dx(fd, "stop", kname);
      await inOps(fd, s, async () => {
        setRecreateRestartGrace({ resume: () => Promise.resolve(null) });
        try {
          await ctx.restart();
          assert.deepEqual(states(), ["start", "start"], "not earmarked at startup");
          await fireHooks("restartGrace", {});
          for (const i of inst) assert.ok(procedureAlive(s.projectId, i), `${i}: no procedure right after the chain (${states()})`);
          assert.ok(!states().includes("error"), `on error right after the chain: ${states()} — ${store.projectInstance(s.projectId, "copy-k1")?.error}`);
          await waitForTruthy(() => inst.every((i) => !procedureAlive(s.projectId, i)), "both restores done");
          assert.deepEqual(states(), ["ready", "ready"], `the copy did not come up next to its main: ${store.projectInstance(s.projectId, "copy-k1")?.error}`);
          const starts = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "start").map((a) => a.args[1]);
          assert.deepEqual(starts.sort(), [cid, kid].sort(), "one docker start per instance, by id");
        } finally {
          setRecreateRestartGrace(recreateRestartGraceSeam);
        }
      });
    } finally {
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(18) if the project container stands in the middle of a stage, the row is error at once — no waiting for the cap, no warning per beat", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx);
    const fd = await fakeDocker({ programs: s.programs });
    const warnings = [];
    const warnPrior = console.warn;
    console.warn = (...a) => {
      const text = a.map(String).join(" ");
      if (/restore .*: inspect \(stage/.test(text)) warnings.push(text);
      warnPrior(...a);
    };
    try {
      const { name } = projectWithStack(ctx, fd, s, [{ name: "h-db-1", service: "db", healthy: true }]);
      await inOps(fd, s, async () => {
        const p = restoreInstance(s.projectId);
        await fd.gateReached("healthy-h-db-1");
        dx(fd, "stop", name); // the project container ends (OOM, crash) in the middle of stage 1
        // Wait for an event: the row leaves `start` — or a warning arrives (a version that does not recognise the standing
        // container but warns once per stage gives EXACTLY one — waiting for a second would hang until the cap there). With the
        // repair `throwIfContainerStands` throws BEFORE any warning: zero warnings.
        await waitForTruthy(() => store.projectInstance(s.projectId).state !== "start" || warnings.length >= 1, "error or a warning");
        const z = store.projectInstance(s.projectId);
        assert.equal(z.state, "error", `start held until the cap (${warnings.length} warnings): ${JSON.stringify(z)}`);
        assert.match(z.error, /the project container stands \(stage 1\/1\)/);
        assert.deepEqual(warnings, [], "warnings instead of error");
        assert.equal((await p).state, "error");
      });
    } finally {
      console.warn = warnPrior;
      fd.openGate("healthy-h-db-1");
      cleanUpRows();
      fd.cleanUp();
    }
  });
});

test("(19) a turn in a project on error (older than the beat) triggers ONE new attempt, waits and runs after ready; an agent likewise; if the attempt fails, the turn ends visibly; within the deadline today's error; without ops nothing", async () => {
  let fd = null;
  try {
    await withoutAccount(() => withAgentsServer(async (ctx) => {
      const s = scenario(ctx);
      fd = await fakeDocker({ programs: s.programs });
      const chatId = ctx.chat.id;
      const pid = s.projectId;
      const statusFile = path.join(s.inside, "run", "cbase-projectbox.status");
      // Older than the beat: two hours ago (the beat stands at an hour below — set high, not a criterion of the clock).
      const onError = (reason) => store.changeProjectInstance(pid, "main", { state: "error", error: reason, now: Date.now() - 2 * 3_600_000 });
      const hints = () => store.listMessages(chatId).filter((m) => m.role === "hint").map((m) => m.text);
      const hostStarts = () => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "start").length;
      try {
        await json(`${ctx.base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ projectId: pid }) });
        const { name, idOf } = projectWithStack(ctx, fd, s, [{ name: "v-db-1", service: "db", healthy: true }]);
        onError("from the last start");
        // Without the ops mark no verdict, no attempt, no docker.
        const beforeG1 = fd.calls().length;
        assert.equal(projectLock(chatId, "turn"), null);
        assert.equal(store.projectInstance(pid).state, "error");
        assert.deepEqual(fd.calls().slice(beforeG1), []);
        await inOps(fd, s, async () => {
          // (a) ONE new attempt: the message waits (queued, locked), the row stands in start synchronously, its procedure lives.
          const turnsA = turns(ctx.root).length;
          const startsA = hostStarts();
          const a = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "NEW-ATTEMPT" });
          assert.equal(a.queued, true, `no new attempt — the message ended at the old error: ${JSON.stringify(a)}`);
          assert.equal(a.locked, true, JSON.stringify(a));
          assert.equal(store.projectInstance(pid).state, "start");
          assert.ok(procedureAlive(pid, "main"), "no living procedure");
          await fd.gateReached("healthy-v-db-1");
          // At most one at a time: a second message waits too (the row stands in start), without a second attempt.
          const b = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "SECOND" });
          assert.equal(b.queued, true, JSON.stringify(b));
          assert.equal(turns(ctx.root).length, turnsA, "a turn ran before ready");
          fd.openGate("healthy-v-db-1");
          await waitForTruthy(() => ["NEW-ATTEMPT", "SECOND"].every((x) => turns(ctx.root).slice(turnsA).some((u) => String(u.text).includes(x))), "both turns after ready");
          await ctx.waitForQuiet();
          assert.equal(store.projectInstance(pid).state, "ready");
          assert.equal(hostStarts() - startsA, 1, "exactly ONE attempt (one docker start of the project container)");
          assert.deepEqual(started(fd, name, idOf), ["v-db-1"]);

          // (b) an agent (a workflow agent too asks with the purpose "agent") triggers likewise and waits as at `start`.
          dx(fd, "stop", name);
          onError("from the last start");
          const u = projectLock(chatId, "agent");
          assert.equal(u?.kind, "wait", JSON.stringify(u));
          assert.equal(u.reason, "start");
          await waitForTruthy(() => !procedureAlive(pid, "main"), "the attempt of the agent");
          assert.equal(store.projectInstance(pid).state, "ready");

          // (c) if the attempt fails (entrypoint phase=ended), the waiting turn ends visibly — with the fresh reason.
          dx(fd, "stop", name);
          fs.writeFileSync(statusFile, "phase=ended\nnotice=dockerd exited with 1\n");
          onError("from the last start");
          const turnsC = turns(ctx.root).length;
          const startsC = hostStarts();
          const c = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "AFTER-FAIL" });
          assert.equal(c.queued, true, JSON.stringify(c));
          await waitForTruthy(() => hints().some((x) => /Projekt-Container nicht bereit: the entrypoint reports phase=ended/.test(x)), "the waiting turn ends visibly");
          await ctx.waitForQuiet();
          assert.equal(store.projectInstance(pid).state, "error");
          assert.equal(turns(ctx.root).length, turnsC, "a turn ran in a project on error");
          assert.equal(hostStarts() - startsC, 1, "exactly ONE attempt");

          // (d) within the deadline (the row just went to error): no attempt, today's error — at once.
          const since = store.projectInstance(pid).stateSince;
          const startsD = hostStarts();
          const d = await post(`${ctx.base}/api/chats/${chatId}/message`, { text: "IN-THE-DEADLINE" });
          assert.equal(d.queued, false, `a new attempt within the deadline: ${JSON.stringify(d)}`);
          await waitForTruthy(() => hints().filter((x) => /phase=ended/.test(x)).length >= 2, "the second hint");
          await ctx.waitForQuiet();
          assert.equal(store.projectInstance(pid).stateSince, since, "the row moved");
          assert.equal(hostStarts(), startsD);
          assert.equal(projectLock(chatId, "agent")?.kind, "error", "an agent within the deadline: today's error");
        }, {
          CBASE_RECREATE_CHECK_BACK_MS: "3600000",
          CBASE_IN_PROJECT_ESCALATION_MS: "200",
          CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex"),
        });
      } finally {
        fd.openGate("healthy-v-db-1");
        cleanUpRows();
      }
    }, { claude: CLAUDE_ORDER }));
  } finally {
    fd?.cleanUp();
  }
});

// ── (20) The bridge prefix ──────────────────────────────────────────────────────────────────────────────────────────────

test("(20) a project container with the old hostname or on an old bridge is stopped at once, not started, error AND recreate request; cbp-<n> on both ⇒ ready", async () => {
  const OLD = "hx" + "p-";
  await withAgentsServer(async (ctx) => {
    const requests = [];
    setRecreateRequest((a) => { requests.push(a); });
    const open = [];
    try {
      for (const [fall, { hostname, bridge, running }, reason] of [
        ["old hostname, running", { hostname: `${OLD}7`, bridge: `${OLD}7`, running: true }, new RegExp(`hostname “${OLD}7” instead of cbp-7`)],
        ["old bridge, hostname right, running", { hostname: "cbp-7", bridge: `${OLD}7`, running: true }, new RegExp(`bridge “${OLD}7” instead of cbp-7`)],
        ["old hostname, stopped", { hostname: `${OLD}7`, bridge: `${OLD}7`, running: false }, new RegExp(`hostname “${OLD}7” instead of cbp-7`)],
        ["both cbp-7", { hostname: "cbp-7", bridge: "cbp-7", running: true }, null],
      ]) {
        const s = scenario(ctx);
        const name = projectContainer(s.projectId);
        const network = `cbase-pn-${s.projectId}`;
        const fd = await fakeDocker({ programs: s.programs });
        open.push(fd);
        dx(fd, "network", "create", "--driver", "bridge", "--subnet", "10.230.7.0/24", "--gateway", "10.230.7.1", "-o", `com.docker.network.bridge.name=${bridge}`,
          "--label", `cbase.project=${s.projectId}`, "--label", "cbase.instance=main", network);
        const cid = dx(fd, "run", "-d", "--name", name, "--hostname", hostname, "--network", network, "--ip", "10.230.7.2", "--label", `cbase.project=${s.projectId}`, "cbase-projectbox:latest");
        store.createProjectInstance({ projectId: s.projectId, state: "ready", convertedAt: Date.now(), containerId: cid, network, subnet: "10.230.7.0/24", bridge: "cbp-7",
          ip: "10.230.7.2", gateway: "10.230.7.1", hostname: "cbp-7", desired: desiredFromInspect([]) });
        if (!running) dx(fd, "stop", name);
        requests.length = 0;
        const mark = fd.calls({ daemon: "host" }).length;
        await inOps(fd, s, async () => {
          const row = await restoreInstance(s.projectId, "main", { reason: `Test ${fall}` });
          if (!reason) { assert.equal(row.state, "ready", `${fall}: ${row.error}`); return; }
          assert.equal(row.state, "error", `${fall}: ${JSON.stringify(row)}`);
          assert.match(row.error, reason, fall);
          assert.match(row.error, /stopped, recreated in the next idle/, fall);
        });
        await new Promise((r) => setImmediate(r));
        const calls = fd.calls({ daemon: "host" }).slice(mark).map((x) => x.args);
        const c = Object.values(fd.state().container).find((x) => x.name === name);
        if (!reason) {
          assert.equal(c.status, "running", `${fall}: stopped although hostname and bridge are right`);
          assert.deepEqual(requests, [], `${fall}: a recreate request`);
          continue;
        }
        assert.notEqual(c.status, "running", `${fall}: the old container kept running — its bridge stands outside the separation`);
        assert.equal(calls.some((a) => a[0] === "start"), false, `${fall}: started`);
        assert.equal(calls.some((a) => a[0] === "stop" && a.includes(cid)), running, `${fall}: stop by id ${running ? "missing" : "although it was not running"}`);
        assert.equal(calls.some((a) => a[0] === "exec"), false, `${fall}: an exec into the old container`);
        assert.equal(requests.length, 1, `${fall}: ${JSON.stringify(requests)}`);
        assert.equal(requests[0].projectId, s.projectId);
        assert.match(requests[0].reason, reason);
      }
    } finally {
      setRecreateRequest(recreateRequest);
      cleanUpRows();
      for (const fd of open) fd.cleanUp();
    }
  });
});
