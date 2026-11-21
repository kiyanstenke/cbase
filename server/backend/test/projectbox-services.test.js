// Guard of the services in the project container, and of the rule that the local docker stays for projects that are not
// converted. Real server (withAgentsServer) with the operation mark and a fake docker (fake-docker.mjs) — it imitates
// `exec -d` with the REAL wrapper (server/backend/cbase-wrapper): the service runs locally as leader of a session of its own,
// the wrapper writes the pgid and exit file into the runtime folder.
//
// The promises, each with the way that breaks it:
//   (1) START IN THE CONTAINER. The simple start of a converted project is `docker exec -d -u agent -w <project folder>
//       <cbase-p-…> /usr/sbin/cbase-wrapper --pgid-file <processes>/… --log <service-logs>/main_<svc>.log --exit
//       <processes>/… -- sh -lc <start command>` (no value behind `-e`), the service is leader of its group, its log is in the
//       file, the status is "running" (`kill -0` in the container), the entry in service-runs.json carries `instance` and `pgid`
//       and NO `pid`, `desired.services` names it. Counter-test: services.js before the change — the start runs in B (the
//       call is missing in the log), red at "no docker exec -d".
//   (2) STOP. `kill -TERM -- -<pgid>` in the container ends the service with its grandchild; no failNotice (the exit file 143
//       comes after the stop), both files gone, `desired.services` empty.
//   (3) EXIT FILE => failNotice. Exit 1 of the wrapper => the bell "Start fehlgeschlagen" with code and log end (waited for over
//       the global stream, closed with the stream barrier). Twice: only through fs.watch (poll in the opposite direction, one
//       hour) and only through the poll (`CBASE_SERVICE_FSWATCH=0`, the clock seam `serviceQueryNow` finds exactly the two files
//       of the run — without the poll it would find 0, red instead of a hang).
//   (4) COUNTER-CHECKS: without an instance row (with the operation mark) and without the operation mark (with an instance row)
//       the same service starts in B — `spawn` of the login shell, the call log of the fake docker stays EMPTY, the entry
//       carries `pid`.
//   (5) THE GUARD: an instance entry with a (planted) `pid` never reaches `process.kill(-pid)`; an entry from the container
//       carries none anyway. Counter-test: the guard removed => the group dies, red.
//   (6) ORPHANED: after a restart of the project container the entry no longer counts (State.StartedAt after `startedAt`) —
//       status "not running", the stop sends NO `kill` to the old pgid. Counter-test: runValid always true => the kill is in the
//       log, red.
//   (7) CONTAINER SERVICES AND RESOURCES through the inner daemon or `docker stats … cbase-p-<id>`; the LOCAL docker (a stub on
//       the PATH) is never called for a converted project, for a non-converted one it is.
//   (8) START CHECK ON THE INSTANCE: a listener on the IP of the instance makes the port "occupied" (409) and a port service
//       "running"; the same listener does not count in B (there the way asks 127.0.0.1).
//   (9) startDesiredServices: starts like the button, reports unknown and commandless services as errors, a running one as
//       already running; without an instance nothing.
//  (10) desired: only `services` changes, `container` and `time` of the last snapshot stay (projectbox/services.js).
//  (12) STOP AT THE PORT PER INSTANCE (the stop route of a service with a port, without a run entry — the port part of
//       stopInInstance): `lsof` and `kill` run in the project container, the listener on the instance IP falls. Counter-test:
//       without the per-instance branch `lsof` asks in B — no exec in the log, red.
//  (11) THE CALL (runtime/inProject.js, unit): `service: { log }` makes `exec -d` with `--log`/`--exit` behind the pgid file in
//       the same runtime folder; without `log` a TypeError (the wrapper would have no file for the output); without `service`
//       it stays today's call (`-i`, no exit file).
//  (13) NO VERDICT "ORPHANED" FROM THE CACHE: a status glance with a stopped container remembers `running:false`; after the
//       restart and a NEW start the fresh run counts as running, its entry stays, and the stop hits its group. The validity of
//       the state is set to one hour for this (`CBASE_SERVICE_STATUS_MS`), so the guard does not depend on the speed of the
//       test. Counter-test: services.js before the repair — "the fresh run counts as orphaned", red. Two measures carry it,
//       each alone suffices for this path: `running:false` is read fresh before the verdict, and startSimple forgets the state.
//  (14) NO DOUBLE START OF A BOOTING SERVICE: startDesiredServices counts a living run in the container as "already running",
//       even if its port is still closed — right after the start (still without pgid) and afterwards (with pgid). Counter-test:
//       before the repair two `exec -d`, red.
//  (15) SERVICE FILES IN THE RUNTIME FOLDER: a link at the place of the log file (to a file of B) is neither read — log route,
//       `hasLog`, the log end of the bell "Start fehlgeschlagen" — nor written (the stamp of the start); likewise a link at the
//       place of the log FOLDER. The start goes on (the container writes its log itself). Counter-test: the state before the
//       fix — the log route delivers the file of B, red.
//  (16) IDENTITY OF THE GROUP: with the operation mark an entry whose start time is wrong (after a restart of B the pid belongs
//       to someone else) or missing (from before the change) reaches neither nativeRuns nor `process.kill(-pid)` on the
//       RELOCATION PATH (step 4); the own one does. Status and stop of a service ask the group of the entry
//       (`groupOfTheEntry`): foreign start time => "not running", entry gone, no signal; without a start time as before.
//       Without the operation mark also in the relocation path as before. In (4) also: the entry carries `pidStart` in EVERY
//       mode (counter-test: without the operation mark the field is missing, red).
//       Sabotage: ownGroupAlive without comparison => red. Counter-test of the stop part: services.js with the identity at the
//       operation mark instead of the relocation path — "running" wrong, no signal, red.
//  (18) THE VERDICT BEFORE THE FIRST SIGNAL HOLDS FOR TERM AND KILL: a service whose leader dies on TERM and whose member ignores
//       TERM (`sh -c 'trap "" TERM; …; exec sleep …' & wait`) is completely gone after the stop — stopService sends TERM AND
//       KILL to the group, with the operation mark exactly as without; endNativeRuns (relocation step 4) sends KILL after the
//       grace because the GROUP still lives (not its leader), and reports it under `hard`. Judged by the recorded signals
//       (process.kill wrapped), not by a clock; afterwards the end of the member is awaited. Counter-test: services.js with a
//       second look at the leader before the KILL — no KILL, red.
//  (17) SERVICES WITHOUT A PROCESS GROUP: unclearNativeRuns names agent services with an open port and without a port, not
//       the one with a closed port; endNativeRuns (step 4) empties RUNS around the dead ones and leaves the open ones (`open`).
//       Counter-test: the old state does not know unclearNativeRuns, and the dead entry stays.
//  (19) START PROTECTION: a second simple start of a service whose run lives but does not listen on the registered port does NOT
//       overwrite the entry — the route answers 409, the entry (pid and pidStart or instance) stays, no second process, no second
//       `exec -d`; after the stop the same service starts again (restart = stop, then start). In B with and without the operation
//       mark, in the project container. Unit: with the operation mark only the OWN group (start time matches) holds the start —
//       an entry with a foreign start time is replaced; without the operation mark (local) the living pid suffices.
//       Counter-test: the state before the fix — 202 and a second process, the entry carries its pid, red. Also, each in the
//       same run:
//       state = start protection: as long as the start is held, the state reports `holdsStart: true` (route /services AND
//       /api/project-services of the apps page), the clients offer "Stop" on it; the 409 carries `code: "SERVICE_RUNNING"`;
//       after the stop `holdsStart: false`. Counter-test: the field is missing, red.
//       also the agent start: `mode: "agent"` over a living run is 409, the entry stays, no chat in the project. Counter-test:
//       202, recordAgentRun replaces the entry (pid null), red.
//       identity without the operation mark (unit): without the operation mark only the OWN group (start time matches) holds
//       the start — an entry with a foreign or missing start time (after a restart of the Mac the pid belongs to someone else) is
//       replaced. Counter-test: 409 "already running", red.
//  (20) STATE WITH A FOREIGN pid: a port service with a closed port whose stored pid lives but carries another start time counts
//       as dead — serviceStatus removes the entry (`holdsStart:false`), and a stop afterwards does not hit the foreign group. In
//       both modes. Counter-test: the entry stays, the stop sends TERM to the foreign group, red.
//  (21) NO START DURING THE RELOCATION: as long as the project is locked (reason "relocation"), a relocation journal is open or
//       the instance is in the state "relocation", POST …/start answers 409 `code: "RELOCATION"` — simple as by agent, without a
//       process, without an entry, without a chat; afterwards the same service starts. Counter-test: 202, the service runs in B
//       and would be ended again by the relocation in step 4, red.
//
// Services PER INSTANCE:
//  (22) TWO INSTANCES, THE SAME SERVICE: the start with `?instance=<project>/copy-k1` is `exec -d … cbase-k-<id>-k1 …`, its
//       entry stands under `<id>:<svc>@copy-k1` (the main one stays `<id>:<svc>`), its log is called `copy-k1_<svc>.log`, only the
//       `desired` of the copy changes; state and log per instance. The start in the main one is not held by the living run of
//       the copy (start protection per instance), a second start in the copy is 409 SERVICE_RUNNING, the agent start of a copy
//       409 COPY_AGENT (not built — the message does not promise it), the stop of the copy hits only its group, its `desired`,
//       its entry. The choice: unknown copy 404, an identifier of another project or without form 400, `<project>/main` = no
//       statement. Counter-test: services.js and projects/routes.js before the change — `instance` is ignored, the start runs in
//       the main one (no `exec -d` in cbase-k-…), red. The 409 COPY_AGENT must not promise the agent start any more: the old
//       sentence instead of the correction => (22) red.
//  (23) BELL, MONITOR, RESOURCES PER INSTANCE: a failed start in the copy is called "Start failed: <service> (copy k1)"
//       and carries `instance`; the monitor checks every port service additionally in every copy (key `project:<id>@copy-k1`, on
//       ITS IP) — its failure reports with the name of the copy, the main one stays quiet; `/api/project-resources` counts the
//       containers of both instances and names them in `instances` (without a copy the field is missing). Counter-test:
//       services.js before the change — no event for the copy, red.
//  (24) FENCE: from a project network, log, start and stop set `instance` to the identifier OF the token — with the token of a
//       copy `?instance=<project>/main` is 403, without a statement the copy is added. Counter-test: the pinning of the three
//       lines removed, red.
//  (25) THE PAUSE: state and stop of a service without a port in a FROZEN main one wait at the barrier — no verdict during the
//       pause, the entry stays; after the thaw "running" or stopped with group, entry and `desired`. A pause that cbase does NOT
//       hold (`docker pause` from outside): "is paused" is unknown — the state does not delete the entry, the stop answers
//       `stopped: false` with a message and leaves entry, `desired` and group standing; after the `unpause` the same stop stops.
//       Counter-test: services.js and projectbox/docker.js before the change — the state judges during the pause (entry gone), red.
//  (26) WHICH NATIVE SERVICES RUN (projectbox/services.js nativeServicesStatus, asked by the freeze of a copy and by the clear-away):
//       "native" is decided by the RUN, not the registration. A service with a start command whose registered compose container
//       does NOT run, but whose port on the instance is open, runs natively (the frontend through `npm run dev` next to a compose
//       entry — the scanner registered the compose container, `npm run dev` was started, and the copy did not start the
//       frontend). A service whose container runs is NOT a native one (the container's desired carries it), even if its port is
//       open; one with a container that runs neither as a container nor natively is not in the list; a service without a container
//       is in it as before, even if it does not run. Counter-test: projectbox/services.js with the filter `!d.container` — the
//       frontend is missing, red. Sabotage: the container glance removed (every service with a start command through the port) —
//       the database, whose container runs, would be in as natively running, red.
// (26b) if the state of the inner docker is unknown, nativeServicesStatus fails — a container service with an open port then does
//       not count as natively running; with a readable daemon its container carries it.
// (27)–(32) and RP9-8 stand further down at their tests.
//
// No clock as a criterion: waiting is on marks, files and events; the poll in the tick is set small (it speeds up, decides
// nothing), except in (3), where it stands in the opposite direction.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { WRAPPER_PATH, inProjectCall, setInProjectSeam } from "../electron/server/runtime/inProject.js";
import {
  endNativeRuns, checkNow, serviceQueryNow, getMonitorEvents, initServices, nativeRuns, openServiceObservations, processStart, recordAgentRun, serviceStatus, setServicesSeam,
  startDesiredServices, startSimple, stopService, unclearNativeRuns,
} from "../electron/server/services.js";
import { carryForwardServiceDesired, nativeServicesStatus } from "../electron/server/projectbox/services.js";
import { FENCE_TABLE } from "../electron/server/projectbox/fence-table.js";
import { checkScope } from "../electron/server/projectbox/fence.js";
import { projectLocks } from "../electron/server/projectbox/idle.js";
import { isFrozen, pause, thawOut, waitingForThaw } from "../electron/server/projectbox/docker.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";
import { GLOBAL } from "./quiet.mjs";
import { groupAlive, processAlive } from "./process-group.mjs";

// ── Helpers (a test file never imports another — pattern from in-project-start-places.test.js) ─────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
// The LOCAL docker: a stub on the PATH that logs every call and fails — the test machine needs no Docker, and a call past
// the fake daemon becomes visible.
function localDockerStub(root) {
  const bin = path.join(root, "local-bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "local-docker.log");
  fs.writeFileSync(path.join(bin, "docker"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`);
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  return { path: `${bin}:${process.env.PATH}`, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}
const ops = (fd, local, extra = {}) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVICE_QUERY_MS: "20",
  SHELL: "/bin/sh", PATH: local.path, ...extra,
});
const withoutOps = (fd, local) => ({ ...ops(fd, local), CBASE_CONTAINER: undefined, CBASE_DIND: undefined });

// A project with a running project container (`cbase-p-<id>` in the fake docker) and — with `converted` — its instance row.
// `ip` is the address of the instance: in the fake docker "the container" runs locally.
async function project(ctx, fd, { converted = true, ip = "127.0.0.1", name = "Till" } = {}) {
  const projPath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name, path: projPath });
  const container = `cbase-p-${p.id}`;
  // With an address like the real project container: the lsof of the fake docker sees only the listeners on it (inNetworkOfTheContainer).
  execFileSync(fd.bin, ["run", "-d", "--name", container, "--network", "bridge", "--ip", ip, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: converted ? Date.now() : null, containerId: container, ip });
  const data = path.join(ctx.dataRoot, "data");
  return {
    p, projPath, container,
    processes: path.join(data, "projects", p.id, "processes"),
    serviceLogs: path.join(data, "projects", p.id, "service-logs"),
    runsFile: path.join(data, "service-runs.json"),
  };
}
const createService = (ctx, p, fields) => json(`${ctx.base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId: p.id, ...fields }) });
async function startAt(ctx, p, service, body = {}) {
  const r = await fetch(`${ctx.base}/api/projects/${p.id}/services/${service.id}/start`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const stop2 = (ctx, p, service) => json(`${ctx.base}/api/projects/${p.id}/services/${service.id}/stop`, { method: "POST" });
async function statusOf(ctx, p, service) {
  const r = await json(`${ctx.base}/api/projects/${p.id}/services`);
  return r.services.find((s) => s.id === service.id).status;
}
const entry = (runsFile, p, service) => JSON.parse(fs.readFileSync(runsFile, "utf8")).find((r) => r.key === `${p.id}:${service.id}`) || null;
// The mark "pid pgid" of the service's shell, written atomically.
const markerCommand = (root, name) => `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${root}/${name}.tmp' && mv '${root}/${name}.tmp' '${root}/${name}.marker'`;
const markerExists = (root, name) => fs.existsSync(path.join(root, `${name}.marker`));
const readMarker = (root, name) => { const [pid, pgid] = fs.readFileSync(path.join(root, `${name}.marker`), "utf8").trim().split(/\s+/).map(Number); return { pid, pgid }; };
const hostExecs = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec");
const serviceExecs = (fd, container) => hostExecs(fd).filter((a) => a.args[1] === "-d" && a.args.includes(container) && a.args.includes(WRAPPER_PATH));
const valueValue = (args, flag) => args[args.indexOf(flag) + 1];
const kill = (groups) => { for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } } };

// The global stream (/api/events), closed in the finally.
async function globalStreamFor(base) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  const events = [];
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
  await waitForTruthy(() => events.length > 0, "first event on /api/events");
  return { events, async shutdown() { ac.abort(); await pump; } };
}
const failedStarts = (events, name) => events.filter((e) => e.type === "notice" && String(e.notice?.title || "").includes(`: ${name}`));

// ── (1) + (2) start, state, log, desired, stop ────────────────────────────────────────────────────────────────────────────
test("(1)(2) simple start of a converted project in the project container: exec -d with the wrapper, state, log, entry without pid, desired — stop through the group with its grandchild, without a failed start", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const stream = await globalStreamFor(ctx.base);
        try {
          const grandchild = path.join(ctx.root, "grandchild.pid");
          const service = await createService(ctx, o.p, { name: "web", startCommand: `echo SERVICE-LOG; sleep 100000 & echo $! > '${grandchild}'; ${markerCommand(ctx.root, "service")}; wait` });
          const r = await startAt(ctx, o.p, service, { mode: "simple" });
          assert.equal(r.status, 202, `${r.status}: ${JSON.stringify(r.body)} — the simple start of a converted project`);

          // First the mark (the service ran — somewhere), then the log: the fake docker writes it BEFORE it starts the command.
          // A start in B would write the mark too — and the log would stay empty (red, no hang).
          await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service");
          // The call: exec -d, as agent, in the project folder, the wrapper with pgid, log and exit file, behind it sh -lc.
          const execs = serviceExecs(fd, o.container);
          assert.equal(execs.length, 1, `no "docker exec -d … ${o.container} ${WRAPPER_PATH} …" in the log — the start bypassed the instance (execs: ${JSON.stringify(hostExecs(fd).map((a) => a.args)).slice(0, 600)})`);
          const a = execs[0].args;
          assert.equal(valueValue(a, "-u"), "agent");
          assert.equal(valueValue(a, "-w"), o.projPath, "-w: the project folder");
          for (let i = 0; i < a.length; i++) if (a[i] === "-e") assert.ok(!a[i + 1].includes("="), `a value in argv behind -e: ${a[i + 1]}`);
          assert.equal(path.dirname(valueValue(a, "--pgid-file")), o.processes, "pgid file in the runtime folder (processes/)");
          assert.equal(path.dirname(valueValue(a, "--exit")), o.processes, "exit file in the runtime folder (processes/)");
          assert.equal(valueValue(a, "--log"), path.join(o.serviceLogs, `main_${service.id}.log`), "log file in the runtime folder");
          assert.deepEqual(a.slice(a.indexOf("--") + 1), ["sh", "-lc", service.startCommand], "the start command unchanged behind sh -lc");
          assert.deepEqual(local.calls(), [], "the local docker was called");

          const m = readMarker(ctx.root, "service");
          groups.push(m.pgid);
          assert.equal(m.pgid, m.pid, `the service is not leader of its group (pid ${m.pid}, pgid ${m.pgid})`);
          await waitForTruthy(() => fs.existsSync(grandchild) && fs.readFileSync(grandchild, "utf8").trim(), "pid of the grandchild");
          const grandchildPid = Number(fs.readFileSync(grandchild, "utf8").trim());
          assert.ok(processAlive(grandchildPid));

          // The entry: instance and pgid, NEVER pid.
          await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === m.pgid, "pgid in the entry");
          const e = entry(o.runsFile, o.p, service);
          assert.equal(e.instance, `${o.p.id}/main`);
          assert.equal("pid" in e, false, `the entry carries a pid: ${JSON.stringify(e)}`);

          // State and log.
          assert.equal((await statusOf(ctx, o.p, service)).running, true, "status: running");
          assert.ok(hostExecs(fd).some((x) => x.args.includes(o.container) && x.args.includes("kill") && x.args.includes("-0")), "status without kill -0 in the container");
          await waitForTruthy(async () => (await json(`${ctx.base}/api/projects/${o.p.id}/services/${service.id}/log`)).log.includes("SERVICE-LOG"), "log line of the service");
          assert.match(fs.readFileSync(valueValue(a, "--log"), "utf8"), /einfacher Start/, "the stamp stands before the output");
          assert.deepEqual(store.projectInstance(o.p.id, "main").desired.services, [service.id], "desired.services after the start");

          // (2) Stop: kill -TERM to the group in the container, the service and its grandchild are gone.
          const s = await stop2(ctx, o.p, service);
          assert.equal(s.stopped, true, JSON.stringify(s));
          assert.ok(hostExecs(fd).some((x) => x.args.includes(o.container) && x.args.includes("kill") && x.args.includes("-TERM") && x.args.includes(`-${m.pgid}`)),
            "no \"kill -TERM -- -<pgid>\" in the container");
          await waitForTruthy(() => !groupAlive(m.pgid), "group of the service ended");
          assert.equal(processAlive(grandchildPid), false, "the grandchild lives");
          // The wrapper writes its exit file (143) after the stop — the observer removes it, without a failed start.
          await waitForTruthy(() => !fs.existsSync(valueValue(a, "--exit")) && !fs.existsSync(valueValue(a, "--pgid-file")) && openServiceObservations() === 0, "pgid and exit file gone");
          await ctx.barrier(stream.events, GLOBAL);
          assert.deepEqual(failedStarts(stream.events, "web"), [], "a stop reported a failed start");
          assert.deepEqual(store.projectInstance(o.p.id, "main").desired.services, [], "desired.services after the stop");
          assert.equal(entry(o.runsFile, o.p, service), null, "the entry is gone after the stop");
          assert.deepEqual(local.calls(), [], "the local docker was called");
        } finally {
          await stream.shutdown();
        }
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (3) exit file => failNotice ─────────────────────────────────────────────────────────────────────────────────────────
async function failedStartCase(slider, { query }) {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local, slider), async () => {
        const o = await project(ctx, fd);
        const stream = await globalStreamFor(ctx.base);
        try {
          const service = await createService(ctx, o.p, { name: "broken", startCommand: `${markerCommand(ctx.root, "broken")}; echo BROKEN-ROW; exit 1` });
          assert.equal((await startAt(ctx, o.p, service)).status, 202);
          await waitForTruthy(() => markerExists(ctx.root, "broken"), "mark of the service");
          const [ex] = serviceExecs(fd, o.container);
          assert.ok(ex, "no docker exec -d in the log");
          const exitFile = valueValue(ex.args, "--exit");
          if (query) {
            // Without fs.watch: the wrapper has written (the file stands), nothing is reported yet — the clock seam of the poll
            // finds exactly the two files of this run, pgid and exit. Without the poll it would find 0: red, no hang.
            await waitForTruthy(() => fs.existsSync(exitFile), "exit file of the wrapper");
            await ctx.barrier(stream.events, GLOBAL);
            assert.deepEqual(failedStarts(stream.events, "broken"), [], "reported before anyone looked — was a watcher running after all?");
            assert.equal(serviceQueryNow(), 2, "the poll did not find the pgid and exit file");
          }
          // Watch only (the beat at 1 h): FSEvents (macOS) misses events in the first moments of a new stream, and under load the exit
          // file can fall into that window — then nothing looks again (the gate hung that way once). A nudge file in the same folder
          // on every look gives the watcher later events; still only the watcher finds the exit file (the beat stays off).
          const nudge = path.join(path.dirname(exitFile), ".nudge-watch");
          await waitForTruthy(() => {
            if (!query) { try { fs.writeFileSync(nudge, String(Date.now())); } catch { /* folder gone: the bell decides */ } }
            return failedStarts(stream.events, "broken").length > 0;
          }, "bell \"Start fehlgeschlagen\"");
          fs.rmSync(nudge, { force: true });
          await ctx.barrier(stream.events, GLOBAL);
          const [n] = failedStarts(stream.events, "broken");
          assert.equal(failedStarts(stream.events, "broken").length, 1, "exactly one bell");
          assert.match(n.notice.title, /Start fehlgeschlagen: broken/);
          assert.match(n.notice.body, /Code 1/, n.notice.body);
          assert.match(n.notice.body, /BROKEN-ROW/, "the log end is missing in the bell");
          assert.equal(n.notice.projectId, o.p.id);
          assert.equal(entry(o.runsFile, o.p, service), null, "the entry still stands after the failed start");
          await waitForTruthy(() => !fs.existsSync(exitFile) && openServiceObservations() === 0, "exit file removed");
        } finally {
          await stream.shutdown();
        }
      });
    });
  } finally {
    fd.cleanUp();
  }
}

test("(3a) exit 1 of the wrapper => failNotice through fs.watch (the poll stands in the opposite direction)", async () => {
  await failedStartCase({ CBASE_SERVICE_QUERY_MS: "3600000" }, { query: false });
});

test("(3b) exit 1 of the wrapper => failNotice through the poll alone (fs.watch off — the clock seam finds pgid and exit file)", async () => {
  await failedStartCase({ CBASE_SERVICE_QUERY_MS: "3600000", CBASE_SERVICE_FSWATCH: "0" }, { query: true });
});

// ── (4) counter-checks ───────────────────────────────────────────────────────────────────────────────────────────────
for (const fall of [
  { name: "with operation mark, without instance row", converted: false, environment: ops },
  { name: "without operation mark, with instance row", converted: true, environment: withoutOps },
]) {
  test(`(4) counter-check ${fall.name}: spawn of the login shell in B, no docker call, the entry carries pid`, async () => {
    const fd = await fakeDocker();
    const groups = [];
    try {
      await withAgentsServer(async (ctx) => {
        const local = localDockerStub(ctx.root);
        await withEnvironment(fall.environment(fd, local), async () => {
          const o = await project(ctx, fd, { converted: fall.converted });
          const prior = fd.calls().length; // the `run` of the project container (test seed)
          const service = await createService(ctx, o.p, { name: "b", startCommand: `${markerCommand(ctx.root, "b")}; exec sleep 100000` });
          const r = await startAt(ctx, o.p, service);
          assert.equal(r.status, 202, JSON.stringify(r.body));
          assert.equal(typeof r.body.pid, "number", "the answer names the pid of the child in B");
          await waitForTruthy(() => markerExists(ctx.root, "b"), "mark of the service in B");
          const m = readMarker(ctx.root, "b");
          groups.push(m.pgid);
          assert.equal(m.pgid, r.body.pid, "the group of the service is that of the child in B (detached)");
          const e = entry(o.runsFile, o.p, service);
          assert.equal(e.pid, r.body.pid);
          assert.equal("instance" in e, false, `an entry in B carries instance: ${JSON.stringify(e)}`);
          // the start time of the group in EVERY mode (the start protection asks it).
          assert.equal(e.pidStart, processStart(r.body.pid), `pidStart is missing or wrong: ${JSON.stringify(e)}`);
          assert.equal((await statusOf(ctx, o.p, service)).running, true);
          const s = await stop2(ctx, o.p, service);
          assert.equal(s.stopped, true, JSON.stringify(s));
          await waitForTruthy(() => !groupAlive(m.pgid), "group in B ended");
          assert.deepEqual(fd.calls().slice(prior), [], "the fake docker was called");
          assert.equal(store.projectInstance(o.p.id, "main").desired, null, "desired was carried forward without an instance");
        });
      });
    } finally {
      kill(groups);
      fd.cleanUp();
    }
  });
}

// ── (5) The guard before process.kill(-pid) ──────────────────────────────────────────────────────────────────────────────
test("(5) an instance entry with a planted pid never reaches process.kill(-pid) — the foreign group lives", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-watchdog-"));
  const foreign = spawn("sleep", ["100000"], { detached: true, stdio: "ignore" });
  try {
    await new Promise((r) => foreign.once("spawn", r));
    foreign.unref();
    // Without operation mark and without seam: the way of B (stopService, branch killGroup) — exactly that of an old state.
    fs.writeFileSync(path.join(dir, "service-runs.json"), JSON.stringify([{
      key: "P1:7", projectId: "P1", serviceId: 7, instance: "P1/main", pgid: 4242, pid: foreign.pid, port: null, mode: "simple",
      logFile: path.join(dir, "log"), startCommand: "x", startedAt: Date.now(),
    }]));
    await withEnvironment({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined }, async () => {
      initServices({ dataDir: dir, logFile: (p, s) => path.join(dir, "logs", `${p}_${s}.log`) });
      const r = await stopService({ projectId: "P1", serviceId: 7 });
      assert.deepEqual(r.killed, [], `the stop hit ${JSON.stringify(r.killed)}`);
    });
    assert.equal(groupAlive(foreign.pid), true, "the foreign group is dead — an instance entry reached process.kill(-pid)");
  } finally {
    try { process.kill(-foreign.pid, "SIGKILL"); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (6) Orphaned after a restart of the project container ─────────────────────────────────────────────────────────────
test("(6) after a restart of the project container the entry is orphaned: not running, the stop sends no kill to the old pgid", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const service = await createService(ctx, o.p, { name: "old", startCommand: `${markerCommand(ctx.root, "old")}; exec sleep 100000` });
        assert.equal((await startAt(ctx, o.p, service)).status, 202);
        await waitForTruthy(() => markerExists(ctx.root, "old"), "mark of the service");
        const m = readMarker(ctx.root, "old");
        groups.push(m.pgid);
        await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === m.pgid, "pgid in the entry");
        // The restart: in a real container the service would die with it, and its number might afterwards belong to a foreign
        // group. In the fake docker it lives on locally — which is how the test sees whether a kill would hit it.
        execFileSync(fd.bin, ["stop", o.container], { env: { ...process.env, ...fd.env } });
        execFileSync(fd.bin, ["start", o.container], { env: { ...process.env, ...fd.env } });
        const prior = hostExecs(fd).length;
        assert.equal((await statusOf(ctx, o.p, service)).running, false, "an orphaned entry counts as running");
        const s = await stop2(ctx, o.p, service);
        assert.equal(s.killed.length, 0, JSON.stringify(s));
        assert.ok(!hostExecs(fd).slice(prior).some((x) => x.args.includes("kill") && x.args.includes(`-${m.pgid}`) && !x.args.includes("-0")),
          "a kill went to the pgid from the earlier run of the container");
        assert.equal(groupAlive(m.pgid), true, "the (here still local) group was hit");
        assert.equal(openServiceObservations(), 0, "the observer waits for an entry that will never be written");
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (13) No verdict "orphaned" from the cache ──────────────────────────────────────────────────────────────────
test("(13) a remembered \"container stopped\" does not make a FRESH run after the restart an orphan: it runs, its entry stays, the stop hits it", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local, { CBASE_SERVICE_STATUS_MS: "3600000" }), async () => {
        const o = await project(ctx, fd);
        const service = await createService(ctx, o.p, { name: "fresh", startCommand: `${markerCommand(ctx.root, "fresh")}; exec sleep 100000` });
        assert.equal((await startAt(ctx, o.p, service)).status, 202);
        await waitForTruthy(() => markerExists(ctx.root, "fresh"), "mark of the first run");
        groups.push(readMarker(ctx.root, "fresh").pgid);
        fs.rmSync(path.join(ctx.root, "fresh.marker"));
        // The container is stopped, a status glance (e.g. the polling of the UI) remembers that.
        execFileSync(fd.bin, ["stop", o.container], { env: { ...process.env, ...fd.env } });
        assert.equal((await statusOf(ctx, o.p, service)).running, false, "a service in a stopped container counts as running");
        // Restart (restore) and a new start within the validity of the remembered state.
        execFileSync(fd.bin, ["start", o.container], { env: { ...process.env, ...fd.env } });
        assert.equal((await startAt(ctx, o.p, service)).status, 202);
        await waitForTruthy(() => markerExists(ctx.root, "fresh"), "mark of the second run");
        const m = readMarker(ctx.root, "fresh");
        groups.push(m.pgid);
        await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === m.pgid, "pgid of the second run in the entry");
        assert.equal((await statusOf(ctx, o.p, service)).running, true, "the fresh run counts as orphaned");
        assert.equal(entry(o.runsFile, o.p, service)?.pgid, m.pgid, "the entry of the fresh run is gone");
        const s = await stop2(ctx, o.p, service);
        assert.ok(s.killed.includes(m.pgid), `the stop did not hit the group of the fresh run: ${JSON.stringify(s)}`);
        await waitForTruthy(() => !groupAlive(m.pgid), "the group of the fresh run ends");
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (7) Container services, resources and the local docker ──────────────────────────────────────────────────────
test("(7) container service of a converted project through the inner daemon (state, log, stop), resources through docker stats cbase-p-<id> — the local docker only without an instance", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { name: "Stack" });
        // A compose container in the inner daemon, with the labels of its project.
        execFileSync(fd.bin, ["exec", "-u", "agent", o.container, "docker", "run", "-d", "--name", "stack-db-1",
          "--label", "com.docker.compose.service=db", "--label", `com.docker.compose.project.working_dir=${o.projPath}`, "postgres:16"], { env: { ...process.env, ...fd.env } });
        const service = await createService(ctx, o.p, { name: "db", container: "db" });
        assert.equal((await statusOf(ctx, o.p, service)).running, true, "the container service runs (inner daemon)");
        assert.ok(fd.calls({ daemon: o.container }).some((a) => a.args[0] === "ps" && a.args.includes("-a")), "no docker ps in the inner daemon");
        assert.equal(typeof (await json(`${ctx.base}/api/projects/${o.p.id}/services/${service.id}/log`)).log, "string");
        assert.ok(fd.calls({ daemon: o.container }).some((a) => a.args[0] === "logs" && a.args.includes("stack-db-1")), "no docker logs in the inner daemon");

        const res = await json(`${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`);
        const row = res.resources.find((x) => x.projectId === o.p.id);
        assert.deepEqual([row.dockerUp, row.containers, row.cpu, row.memBytes], [true, 1, 1.5, 64 * 1024 ** 2], JSON.stringify(row));
        // Bundled since (33): the name stands SOMEWHERE among the arguments (with several projects not last) — intended, named.
        assert.ok(fd.calls({ daemon: "host" }).some((a) => a.args[0] === "stats" && a.args.includes("--no-stream") && a.args.includes(o.container)),
          "no docker stats --no-stream cbase-p-<id> in B");

        const s = await stop2(ctx, o.p, service);
        assert.deepEqual([s.stopped, s.killed], [true, ["stack-db-1"]], JSON.stringify(s));
        assert.ok(fd.calls({ daemon: o.container }).some((a) => a.args[0] === "stop" && a.args.includes("stack-db-1")), "no docker stop in the inner daemon");
        assert.equal(fd.state(o.container).container[Object.keys(fd.state(o.container).container)[0]].status, "exited");
        assert.deepEqual(local.calls(), [], "the local docker was called for a converted project");

        // Without an instance row: the same way goes to the LOCAL docker, the seam stays silent.
        const prior = fd.calls().length;
        store.changeProjectInstance(o.p.id, "main", { convertedAt: null });
        const localPrior = local.calls().length;
        assert.equal((await statusOf(ctx, o.p, service)).running, false);
        await json(`${ctx.base}/api/projects/${o.p.id}/services/${service.id}/log`);
        assert.ok(local.calls().slice(localPrior).some((z) => z.startsWith("ps -a")), "without an instance the state does not ask the local docker");
        assert.deepEqual(fd.calls().slice(prior), [], "without an instance a call went through the seam");
      });
    });
  } finally {
    fd.cleanUp();
  }
});

// ── (8) Start check and state of a port service on the instance ──────────────────────────────────────────────────────
test("(8) a listener on the IP of the instance: port service \"running\", start 409 \"occupied\" — in B the same listener does not count", async () => {
  const fd = await fakeDocker();
  const ip = await secondLoopback();
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, ip, r));
  const port = srv.address().port;
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { ip });
        const service = await createService(ctx, o.p, { name: "api", port, startCommand: `${markerCommand(ctx.root, "api")}; exec sleep 100000` });
        assert.equal((await statusOf(ctx, o.p, service)).running, true, "the listener on the instance IP does not count");
        const r = await startAt(ctx, o.p, service);
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.match(r.body.error, /läuft bereits/);
        // Not converted: the listener on the instance IP is not the port in B.
        store.changeProjectInstance(o.p.id, "main", { convertedAt: null });
        assert.equal((await statusOf(ctx, o.p, service)).running, false, "in B the listener of the instance IP counted");
        const free = await startAt(ctx, o.p, service);
        assert.equal(free.status, 202, JSON.stringify(free.body));
        await waitForTruthy(() => markerExists(ctx.root, "api"), "mark of the service in B");
        groups.push(readMarker(ctx.root, "api").pgid);
      });
    });
  } finally {
    kill(groups);
    await new Promise((r) => srv.close(r));
    fd.cleanUp();
  }
});

// ── (12) Stop at the port per instance ────────────────────────────────────────────────────────────────────────────────────────
test("(12) stop at the port per instance (route, without a run entry): lsof and kill in the project container, the listener on the instance IP falls", async () => {
  const fd = await fakeDocker();
  const ip = await secondLoopback();
  // The listener "in the container" (in the fake docker its processes run locally): a child of its own, never the test process.
  // Plus a "foreign" listener OUTSIDE the instance on the same port number, but 127.0.0.1 — the local lsof of the fake docker
  // saw it too, and the stop ended a real process of the Mac that happened to hold this port number. It must survive the
  // stop (fake-docker-stat.mjs inNetworkOfTheContainer). First the foreign one (port 0), then the listener on the same number
  // at the instance IP — if it is occupied there, a new attempt.
  const listen = (host, port) => spawn(process.execPath, ["-e", `const s = require("net").createServer(); s.on("error", () => console.log("occupied")); s.listen(${port}, ${JSON.stringify(host)}, () => console.log(s.address().port));`], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const row = (k) => new Promise((resolve) => k.stdout.once("data", (b) => resolve(String(b).trim())));
  const children = [];
  let listener = null;
  let foreign = null;
  let port = 0;
  for (let attempt = 0; attempt < 5 && !listener; attempt++) {
    const f = listen("127.0.0.1", 0);
    children.push(f);
    port = Number(await row(f));
    const l = listen(ip, port);
    children.push(l);
    if ((await row(l)) === "occupied") continue;
    [listener, foreign] = [l, f];
  }
  try {
    assert.ok(listener, "no free port at the instance IP in five attempts");
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { ip });
        const service = await createService(ctx, o.p, { name: "listener", port });
        const r = await stop2(ctx, o.p, service);
        assert.deepEqual([r.killed, r.stopped], [[listener.pid], true], JSON.stringify(r));
        const ex = hostExecs(fd).filter((a) => a.args.includes(o.container));
        assert.ok(ex.some((a) => a.args.includes("lsof") && a.args.includes(`tcp:${port}`)), "no lsof in the project container");
        assert.ok(ex.some((a) => a.args.includes("kill") && a.args.includes("-TERM") && a.args.includes(String(listener.pid))), "no kill -TERM in the project container");
        await waitForTruthy(() => !processAlive(listener.pid), "listener ended");
        assert.ok(processAlive(foreign.pid), "the foreign listener on 127.0.0.1 (same port number, outside the instance) fell with it");
      });
    });
  } finally {
    for (const k of children) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* gone */ } }
    fd.cleanUp();
  }
});

// ── (9) startDesiredServices and (10) desired ─────────────────────────────────────────────────────────────────────────
test("(9)(10) startDesiredServices starts like the button and reports the rest; desired changes only services", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        // A snapshot from the server end already stands: its containers and its time stay.
        const old = { time: 1234, container: [{ name: "till-db-1", id: "c1", service: "db", project: "till", state: "running", exitCode: 0, dependsOn: "" }], services: [] };
        store.changeProjectInstance(o.p.id, "main", { desired: old });
        const a = await createService(ctx, o.p, { name: "a", startCommand: `${markerCommand(ctx.root, "a")}; exec sleep 100000` });
        const without = await createService(ctx, o.p, { name: "without" });
        const r = await startDesiredServices(o.p.id, [a.id, without.id, 999999]);
        assert.deepEqual(r.started, [a.id]);
        assert.deepEqual(r.alreadyRunning, []);
        assert.deepEqual(r.error.map((f) => f.id), [without.id, 999999]);
        assert.match(r.error[0].reason, /Startbefehl/);
        assert.match(r.error[1].reason, /unbekannt/);
        await waitForTruthy(() => markerExists(ctx.root, "a"), "mark of the service");
        assert.equal(serviceExecs(fd, o.container).length, 1, "the start did not run in the project container");
        groups.push(readMarker(ctx.root, "a").pgid);
        const desired = store.projectInstance(o.p.id, "main").desired;
        assert.deepEqual(desired, { ...old, services: [a.id] }, "desired: only services changed");
        // Once more: it is running already.
        const two = await startDesiredServices(o.p.id, [a.id]);
        assert.deepEqual([two.started, two.alreadyRunning, two.error], [[], [a.id], []]);
        assert.equal(serviceExecs(fd, o.container).length, 1, "a running service was started twice");
        // Unchanged, carryForwardServiceDesired does not write; without an instance row it does nothing.
        store.changeProjectInstance(o.p.id, "main", { desired, now: 1 }); // the stamp as witness of a write
        assert.deepEqual(carryForwardServiceDesired(o.p.id, a.id, true), desired);
        assert.equal(store.projectInstance(o.p.id, "main").updatedAt, 1, "unchanged and yet written");
        assert.equal(carryForwardServiceDesired("exists-not", a.id, true), null);
        await stop2(ctx, o.p, a);
        assert.deepEqual(store.projectInstance(o.p.id, "main").desired, { ...old, services: [] });
        // Without an instance: nothing starts, every service is an error with a reason.
        store.changeProjectInstance(o.p.id, "main", { convertedAt: null });
        const withoutInstance = await startDesiredServices(o.p.id, [a.id]);
        assert.deepEqual([withoutInstance.started, withoutInstance.error.map((f) => f.id)], [[], [a.id]]);
        assert.match(withoutInstance.error[0].reason, /kein umgestelltes Projekt/);
        assert.equal(serviceExecs(fd, o.container).length, 1);
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (14) No double start of a booting service ───────────────────────────────────────────────────────────
test("(14) startDesiredServices does not start a living run with a still closed port again — before and after its pgid", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        // Lives but never listens: port 1 on the instance IP stays closed — a service that is still booting.
        const api = await createService(ctx, o.p, { name: "api", port: 1, startCommand: `${markerCommand(ctx.root, "api")}; exec sleep 100000` });
        const one = await startDesiredServices(o.p.id, [api.id]);
        assert.deepEqual([one.started, one.alreadyRunning, one.error], [[api.id], [], []]);
        const two = await startDesiredServices(o.p.id, [api.id]); // right after: the wrapper may not have written a pgid yet
        assert.deepEqual([two.started, two.alreadyRunning, two.error], [[], [api.id], []], "a booting service was started twice (without pgid)");
        await waitForTruthy(() => markerExists(ctx.root, "api"), "mark of the service");
        const m = readMarker(ctx.root, "api");
        groups.push(m.pgid);
        await waitForTruthy(() => entry(o.runsFile, o.p, api)?.pgid === m.pgid, "pgid in the entry");
        const three = await startDesiredServices(o.p.id, [api.id]);
        assert.deepEqual([three.started, three.alreadyRunning, three.error], [[], [api.id], []], "a booting service was started twice (with pgid)");
        assert.equal(serviceExecs(fd, o.container).length, 1, "more than one docker exec -d for the same service");
        const s = await stop2(ctx, o.p, api);
        assert.ok(s.killed.includes(m.pgid), JSON.stringify(s));
        await waitForTruthy(() => !groupAlive(m.pgid), "the group of the service ends");
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (11) The call with `service` (unit, without a server) ───────────────────────────────────────────────────────────────────
test("(11) inProjectCall with service: exec -d, --log and --exit beside the pgid file; without log a TypeError; without service as before", () => {
  const location = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-call-"));
  const inst = { identifier: "p1/main", projectId: "p1", instance: "main" };
  try {
    setInProjectSeam({ kind: () => { throw new Error("no start in the unit test"); }, program: () => "docker", processLocation: () => location, container: () => "cbase-p-p1" });
    const a = inProjectCall(inst, "sh", ["-lc", "npm run dev"], { cwd: "/work/p1", env: process.env, service: { log: "/data/main_7.log" } });
    assert.deepEqual(a.args.slice(0, 6), ["exec", "-d", "-u", "agent", "-w", "/work/p1"]);
    const h = a.args.indexOf(WRAPPER_PATH);
    assert.equal(a.args[h - 1], "cbase-p-p1");
    assert.deepEqual(a.args.slice(h + 1), ["--pgid-file", a.pgidFile, "--log", "/data/main_7.log", "--exit", a.exitFile, "--", "sh", "-lc", "npm run dev"]);
    assert.equal(path.dirname(a.pgidFile), location);
    assert.equal(a.exitFile, a.pgidFile.replace(/\.pgid$/, ".exit"), "pgid and exit file share the same stem");
    assert.equal(a.log, "/data/main_7.log");
    assert.throws(() => inProjectCall(inst, "sh", [], { service: {} }), TypeError);
    const b = inProjectCall(inst, "sh", [], {});
    assert.equal(b.args[1], "-i");
    assert.equal(b.exitFile, undefined);
    assert.ok(!b.args.includes("--exit") && !b.args.includes("--log") && !b.args.includes("-d"), b.args.join(" "));
  } finally {
    setInProjectSeam(null);
    fs.rmSync(location, { recursive: true, force: true });
  }
});

// ── (15) Service files in the runtime folder: no link is read or written ───────────────────────────
test("(15) service files in the runtime folder: a link as log (or as log folder) is neither read (log route, hasLog, bell) nor written (stamp)", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const stream = await globalStreamFor(ctx.base);
        try {
          // A file of B outside every mount (standing in for login, database, ~/.bashrc).
          const secret = path.join(ctx.root, "secret.txt");
          fs.writeFileSync(secret, "SECRET-4711\n");
          const unchanged = () => assert.equal(fs.readFileSync(secret, "utf8"), "SECRET-4711\n", "B wrote through the link");
          fs.mkdirSync(o.serviceLogs, { recursive: true });

          // (a) The log file is a link: log route empty, hasLog false, the start goes on, without a stamp through the link.
          const web = await createService(ctx, o.p, { name: "web", startCommand: `${markerCommand(ctx.root, "web")}; exec sleep 100000` });
          const webLog = path.join(o.serviceLogs, `main_${web.id}.log`);
          fs.symlinkSync(secret, webLog);
          const log = await json(`${ctx.base}/api/projects/${o.p.id}/services/${web.id}/log`);
          assert.ok(!String(log.log).includes("SECRET"), `the log route read through the link: ${log.log}`);
          assert.equal((await statusOf(ctx, o.p, web)).hasLog, false, "hasLog followed the link");
          assert.equal((await startAt(ctx, o.p, web)).status, 202, "the start of a converted project failed at the link");
          await waitForTruthy(() => markerExists(ctx.root, "web"), "mark of the service");
          groups.push(readMarker(ctx.root, "web").pgid);
          unchanged();
          assert.ok(fs.lstatSync(webLog).isSymbolicLink(), "the link was replaced");
          await stop2(ctx, o.p, web);

          // (b) A failed start reads the log end for the bell — never through the link.
          const broken = await createService(ctx, o.p, { name: "broken", startCommand: `${markerCommand(ctx.root, "broken")}; exit 1` });
          fs.symlinkSync(secret, path.join(o.serviceLogs, `main_${broken.id}.log`));
          assert.equal((await startAt(ctx, o.p, broken)).status, 202);
          await waitForTruthy(() => failedStarts(stream.events, "broken").length > 0, "bell \"Start fehlgeschlagen\"");
          const [n] = failedStarts(stream.events, "broken");
          assert.ok(!String(n.notice.body).includes("SECRET"), `the bell carries the file of B: ${n.notice.body}`);
          unchanged();

          // (c) The log FOLDER is a link to a folder of B: B reads and writes nothing there.
          const outside = path.join(ctx.root, "b-folder");
          fs.mkdirSync(outside);
          const three = await createService(ctx, o.p, { name: "three", startCommand: `${markerCommand(ctx.root, "three")}; exec sleep 100000` });
          const outsideLog = path.join(outside, `main_${three.id}.log`);
          fs.writeFileSync(outsideLog, "SECRET-FOLDER\n");
          await waitForTruthy(() => openServiceObservations() === 0, "no observation left in the log folder");
          fs.rmSync(o.serviceLogs, { recursive: true, force: true });
          fs.symlinkSync(outside, o.serviceLogs);
          const log3 = await json(`${ctx.base}/api/projects/${o.p.id}/services/${three.id}/log`);
          assert.ok(!String(log3.log).includes("SECRET"), `the log route read through the folder link: ${log3.log}`);
          assert.equal((await statusOf(ctx, o.p, three)).hasLog, false, "hasLog followed the folder link");
          assert.equal((await startAt(ctx, o.p, three)).status, 202);
          await waitForTruthy(() => markerExists(ctx.root, "three"), "mark of the service");
          groups.push(readMarker(ctx.root, "three").pgid);
          assert.equal(fs.readFileSync(outsideLog, "utf8"), "SECRET-FOLDER\n", "B wrote through the folder link");
          await stop2(ctx, o.p, three);
        } finally {
          await stream.shutdown();
        }
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// An entry in service-runs.json for the unit tests (16)/(17).
const runsEntry = (dir, projectId, serviceId, fields) => ({
  key: `${projectId}:${serviceId}`, projectId, serviceId, port: null, mode: "simple", logFile: path.join(dir, `${serviceId}.log`),
  startCommand: "x", startedAt: Date.now(), ...fields,
});
const writeRuns = (dir, entries) => fs.writeFileSync(path.join(dir, "service-runs.json"), JSON.stringify(entries));
// Only the entries of the unit tests: initServices loads into the same table that earlier tests with servers filled.
const readRuns = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "service-runs.json"), "utf8")).filter((e) => /^P\d$/.test(e.projectId));
const MARKER_ON = { CBASE_CONTAINER: "1", CBASE_DIND: "1" };
const MARKER_FROM = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };

// ── (16) The identity of the group before every signal ────────────────────────────────────────────────────────────────
test("(16) with the operation mark an entry with a foreign or missing start time reaches neither nativeRuns nor process.kill(-pid) on the relocation path, the own one does; state and stop likewise — without the operation mark on the relocation path as before", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-identity-"));
  const foreign = spawn("sleep", ["100000"], { detached: true, stdio: "ignore" });
  const own = spawn("sleep", ["100000"], { detached: true, stdio: "ignore" });
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  try {
    await Promise.all([foreign, own].map((k) => new Promise((r) => k.once("spawn", r))));
    foreign.unref();
    own.unref();
    await withEnvironment(MARKER_ON, async () => {
      const start = processStart(own.pid);
      assert.match(String(start), /^(proc|ps):./, `the start time is not readable: ${start}`);
      // 7: the number now belongs to someone else (start time wrong); 8: old entry without a start time; 9: the own one.
      writeRuns(dir, [
        runsEntry(dir, "P1", 7, { pid: foreign.pid, pidStart: "proc:1" }),
        runsEntry(dir, "P1", 8, { pid: foreign.pid }),
        runsEntry(dir, "P1", 9, { pid: own.pid, pidStart: start }),
      ]);
      initServices({ dataDir: dir, logFile });
      assert.deepEqual(nativeRuns("P1"), [{ serviceId: 9, pid: own.pid }], "nativeRuns names a foreign group");
      const r = await endNativeRuns("P1", [7, 8, 9], { graceMs: 0 });
      assert.deepEqual([r.ended, r.open], [[9], []]);
      await waitForTruthy(() => !groupAlive(own.pid), "the own group ends");
      assert.equal(groupAlive(foreign.pid), true, "the foreign group got a signal (relocation step 4)");
      assert.deepEqual(readRuns(dir), [], "RUNS is not empty after step 4 (the foreign entries are dead and fall)");

      // State and stop: they also ask the group of the entry (`groupOfTheEntry`): 7 (foreign start time) counts as dead —
      // running false, the entry falls, the stop sends NO signal to the foreign group; 8 (without a start time, legacy) counts as
      // own and is stopped as before.
      for (const [sid, fields, own] of [[7, { pidStart: "proc:1" }, false], [8, {}, true]]) {
        const victim = spawn("sleep", ["100000"], { detached: true, stdio: "ignore" });
        await new Promise((r) => victim.once("spawn", r));
        victim.unref();
        try {
          const create = () => { writeRuns(dir, [runsEntry(dir, "P1", sid, { pid: victim.pid, ...fields })]); initServices({ dataDir: dir, logFile }); };
          if (own) {
            create();
            assert.equal((await serviceStatus("P1", sid)).running, true, `state of ${sid}`);
            const s = await stopService({ projectId: "P1", serviceId: sid });
            assert.deepEqual(s.killed, [victim.pid], `the stop of ${sid} did not hit the own group: ${JSON.stringify(s)}`);
            await waitForTruthy(() => !groupAlive(victim.pid), `group of ${sid} ended`);
          } else {
            // The stop first (the state would otherwise remove the foreign entry beforehand, and the stop would see none), then the state.
            create();
            const s = await stopService({ projectId: "P1", serviceId: sid });
            assert.deepEqual(s.killed, [], `the stop of ${sid} sent a signal to the foreign group: ${JSON.stringify(s)}`);
            assert.equal(groupAlive(victim.pid), true, `the foreign group of ${sid} no longer lives`);
            create();
            assert.equal((await serviceStatus("P1", sid)).running, false, `state of ${sid} with a foreign start time`);
            assert.deepEqual(readRuns(dir), [], `the entry of ${sid} with a foreign start time stayed`);
          }
        } finally { try { process.kill(-victim.pid, "SIGKILL"); } catch { /* gone */ } }
      }
      assert.equal(groupAlive(foreign.pid), true, "the foreign group got a signal");
    });
    // Without the operation mark (the local server): as before — no comparison.
    await withEnvironment(MARKER_FROM, async () => {
      writeRuns(dir, [runsEntry(dir, "P1", 7, { pid: foreign.pid, pidStart: "proc:1" })]);
      initServices({ dataDir: dir, logFile });
      assert.deepEqual(nativeRuns("P1"), [{ serviceId: 7, pid: foreign.pid }], "without the operation mark nativeRuns changed");
    });
  } finally {
    for (const k of [foreign, own]) { try { process.kill(-k.pid, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (17) Services without a process group ───────────────────────────────────────────────────────────────────────────────
test("(17) unclearNativeRuns names agent services with an open port and without a port; endNativeRuns empties RUNS around the dead ones and leaves the open ones", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-without-group-"));
  const listener = net.createServer();
  const free = net.createServer();
  try {
    await new Promise((r) => listener.listen(0, "127.0.0.1", r));
    await new Promise((r) => free.listen(0, "127.0.0.1", r));
    const open = listener.address().port;
    const closed = free.address().port;
    await new Promise((r) => free.close(r)); // a port on which nobody listens any more
    await withEnvironment(MARKER_ON, async () => {
      writeRuns(dir, [
        runsEntry(dir, "P1", 1, { pid: null, port: open, mode: "agent", chatId: "c1" }),
        runsEntry(dir, "P1", 2, { pid: null, port: null, mode: "agent", chatId: "c1" }),
        runsEntry(dir, "P1", 3, { pid: null, port: closed, mode: "agent", chatId: "c1" }),
        runsEntry(dir, "P2", 4, { pid: null, port: open, mode: "agent", chatId: "c2" }),
      ]);
      initServices({ dataDir: dir, logFile: (p, s) => path.join(dir, "logs", `${p}_${s}.log`) });
      assert.deepEqual(await unclearNativeRuns("P1"), [
        { serviceId: 1, port: open, reason: "port-open" },
        { serviceId: 2, port: null, reason: "without-port" },
      ]);
      const r = await endNativeRuns("P1", []);
      assert.deepEqual([r.ended, r.open], [[], [1, 2]]);
      assert.deepEqual(readRuns(dir).map((e) => e.key).sort(), ["P1:1", "P1:2", "P2:4"], "the dead agent service stayed in RUNS, or a foreign project lost its own");
    });
  } finally {
    await new Promise((r) => listener.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (18) The verdict before the first signal holds for TERM and KILL ────────────────────────────────────────
// The leader (the login shell) dies on TERM, the member ignores it and writes its pid into `marker` beforehand.
const trapCommand = (marker) => `sh -c 'trap "" TERM; echo $$ > ${marker}.tmp && mv ${marker}.tmp ${marker}; exec sleep 100000' & wait`;
// process.kill wrapped: every signal (except the probe 0) to a group is recorded.
async function withSignals(fn) {
  const real = process.kill;
  const signals = [];
  process.kill = function (pid, sig) { if (sig !== 0) signals.push([pid, sig]); return real.call(process, pid, sig); };
  try { return await fn(signals); } finally { process.kill = real; }
}
async function trapService(dir, projectId, id) {
  const marker = path.join(dir, `mitglied-${projectId}-${id}`);
  const run = startSimple({ projectId, service: { id, name: `t${id}`, startCommand: trapCommand(marker) }, cwd: dir });
  await waitForTruthy(() => fs.existsSync(marker), `member of service ${id} stands`);
  const member = Number(fs.readFileSync(marker, "utf8").trim());
  assert.ok(member > 1 && member !== run.pid, `no member of its own: ${member}`);
  return { run, member };
}

test("(18) a member that ignores TERM is gone after the stop: stopService sends TERM and KILL (with the operation mark as without), endNativeRuns KILL after the grace", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-trap-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const members = [];
  try {
    setServicesSeam({}); // without an instance (the seam of an earlier server of this file does not count)
    // The stop: with and without the operation mark the same sequence — TERM and KILL to the group, decided before the TERM.
    for (const [id, marker] of [[1, MARKER_ON], [2, MARKER_FROM]]) {
      await withEnvironment({ ...marker, SHELL: "/bin/sh" }, async () => {
        initServices({ dataDir: dir, logFile });
        const { run, member } = await trapService(dir, "P3", id);
        members.push(member);
        const s = await withSignals(async (signals) => {
          const r = await stopService({ projectId: "P3", serviceId: id });
          assert.deepEqual(signals.filter(([p]) => p === -run.pid).map(([, sig]) => sig), ["SIGTERM", "SIGKILL"],
            `service ${id}: the signals to the group ${JSON.stringify(signals)}`);
          return r;
        });
        assert.deepEqual([s.killed, s.stopped], [[run.pid], true], JSON.stringify(s));
        await waitForTruthy(() => !processAlive(member), `member of service ${id} ends`);
      });
    }
    // The relocation path (step 4): with the operation mark and own start time in nativeRuns; after the grace the GROUP still lives.
    await withEnvironment({ ...MARKER_ON, SHELL: "/bin/sh" }, async () => {
      initServices({ dataDir: dir, logFile });
      const { run, member } = await trapService(dir, "P4", 3);
      members.push(member);
      assert.deepEqual(nativeRuns("P4"), [{ serviceId: 3, pid: run.pid }]);
      const r = await withSignals(async (signals) => {
        const e = await endNativeRuns("P4", [3], { graceMs: 1_000 });
        assert.deepEqual(signals.filter(([p]) => p === -run.pid).map(([, sig]) => sig), ["SIGTERM", "SIGKILL"],
          `relocation: the signals to the group ${JSON.stringify(signals)}`);
        return e;
      });
      assert.deepEqual([r.ended, r.hart], [[3], [3]], JSON.stringify(r));
      await waitForTruthy(() => !processAlive(member), "member of the relocation ends");
    });
  } finally {
    for (const m of members) { try { process.kill(m, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (19) The start protection ──────────────────────────────────────────────────────────────────────────────────────────
// Every start appends the group of its shell to `list` (under the wrapper the service is leader of its session, in B of the
// login shell group — both times `$$`) and never listens. Cleanup goes through the identifier in the command
// (`sleep 100000.<identifier>`), not through the list: a start that ran twice at the old state (counter-test) may write it only
// after the verdict, and it lies in the root folder of the server, which the harness removes before the finally here.
let sleepCounter = 0;
const sleepIdentifier = () => `${process.pid}${++sleepCounter}`;
const listCommand = (list, identifier) => `echo $$ >> '${list}'; exec sleep 100000.${identifier}`;
const cleanSleepers = (identifier) => { try { execFileSync("pkill", ["-KILL", "-f", `sleep 100000\\.${identifier}$`]); } catch { /* none left */ } };
const readList = (list) => (fs.existsSync(list) ? fs.readFileSync(list, "utf8").split("\n").map(Number).filter((n) => n > 1) : []);
// The field `holdsStart` of the apps page (/api/project-services) for a service.
async function holdsStartInApps(ctx, service) {
  const list = await json(`${ctx.base}/api/project-services`);
  return list.find((s) => s.id === service.id)?.holdsStart;
}
async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

for (const fall of [
  { name: "in B with operation mark", converted: false, environment: ops },
  { name: "in B without operation mark (local)", converted: true, environment: withoutOps },
  { name: "in the project container", converted: true, environment: ops },
]) {
  test(`(19) start protection ${fall.name}: a second start of a living run that does not listen on the port is 409 and leaves the entry — after the stop it starts again`, async () => {
    const fd = await fakeDocker();
    const identifier = sleepIdentifier();
    try {
      await withAgentsServer(async (ctx) => {
        const local = localDockerStub(ctx.root);
        await withEnvironment(fall.environment(fd, local), async () => {
          const o = await project(ctx, fd, { converted: fall.converted });
          const inContainer = fall.converted && fall.environment === ops;
          const list = path.join(ctx.root, "groups.list");
          // The registered port is closed (in B a released one, in the container port 1 of the instance IP): "running" says no there.
          const port = inContainer ? 1 : await closedPort();
          const service = await createService(ctx, o.p, { name: "elsewhere", port, startCommand: listCommand(list, identifier) });
          const one = await startAt(ctx, o.p, service);
          assert.equal(one.status, 202, JSON.stringify(one.body));
          await waitForTruthy(() => readList(list).length === 1, "the first run stands");
          const [group] = readList(list);
          if (inContainer) await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === group, "pgid in the entry");
          const prior = entry(o.runsFile, o.p, service);
          assert.ok(prior, "no entry after the first start");
          if (!inContainer) assert.equal(prior.pid, group);
          const snapshot = await statusOf(ctx, o.p, service);
          assert.equal(snapshot.running, false, "the port is closed — the route takes the service for stopped (precondition)");
          // The state gives the answer of the start protection — in both lists on which the clients show "Stop".
          assert.equal(snapshot.holdsStart, true, `the state does not report the held start: ${JSON.stringify(snapshot)}`);
          assert.equal(await holdsStartInApps(ctx, service), true, "/api/project-services does not report the held start");

          const two = await startAt(ctx, o.p, service);
          assert.equal(two.status, 409, `the second start of a living run: ${two.status} ${JSON.stringify(two.body)}`);
          assert.match(two.body.error, /läuft bereits/);
          assert.equal(two.body.code, "SERVICE_RUNNING");
          assert.deepEqual(entry(o.runsFile, o.p, service), prior, "the entry of the living run was overwritten");
          assert.equal(groupAlive(group), true, "the first run no longer lives");
          assert.equal(readList(list).length, 1, "a second process was started");
          if (inContainer) assert.equal(serviceExecs(fd, o.container).length, 1, "a second docker exec -d");

          // The same protection for the agent start — 409 BEFORE the agent chat, the entry stays.
          const chatsPrior = store.chatIdsInProject(o.p.id).length;
          const agent = await startAt(ctx, o.p, service, { mode: "agent" });
          assert.equal(agent.status, 409, `the agent start over a living run: ${agent.status} ${JSON.stringify(agent.body)}`);
          assert.equal(agent.body.code, "SERVICE_RUNNING");
          assert.deepEqual(entry(o.runsFile, o.p, service), prior, "the agent start replaced the entry of the living run");
          assert.equal(store.chatIdsInProject(o.p.id).length, chatsPrior, "the agent start created a chat");

          // Restart: first the stop (it hits the recorded group), then the same service starts again.
          const s = await stop2(ctx, o.p, service);
          assert.ok(s.killed.includes(group), `the stop did not hit the group of the first run: ${JSON.stringify(s)}`);
          await waitForTruthy(() => !groupAlive(group), "the group of the first run ends");
          assert.equal((await statusOf(ctx, o.p, service)).holdsStart, false, "after the stop the state still holds the start");
          assert.equal(await holdsStartInApps(ctx, service), false, "/api/project-services still holds the start after the stop");
          const three = await startAt(ctx, o.p, service);
          assert.equal(three.status, 202, `start after the stop: ${JSON.stringify(three.body)}`);
          await waitForTruthy(() => readList(list).length === 2, "the new run stands");
          const fresh = readList(list)[1];
          if (inContainer) await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === fresh, "pgid of the new run in the entry");
          const s2 = await stop2(ctx, o.p, service);
          assert.ok(s2.killed.includes(fresh), JSON.stringify(s2));
          await waitForTruthy(() => !groupAlive(fresh), "the group of the new run ends");
        });
      });
    } finally {
      cleanSleepers(identifier);
      fd.cleanUp();
    }
  });
}

test("(19) start protection, unit: only the own group holds the start (start time), a foreign one does not — with the operation mark as without", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-startschutz-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const list = path.join(dir, "groups.list");
  const identifier = sleepIdentifier();
  const children = [spawn("sleep", ["100000"], { detached: true, stdio: "ignore" }), spawn("sleep", ["100000"], { detached: true, stdio: "ignore" })];
  const [own, foreign] = children;
  const svc = (id) => ({ id, name: `s${id}`, startCommand: listCommand(list, identifier) });
  try {
    await Promise.all(children.map((k) => new Promise((r) => k.once("spawn", r))));
    for (const k of children) k.unref();
    setServicesSeam({}); // without an instance (the seam of an earlier server of this file does not count)
    await withEnvironment({ ...MARKER_ON, SHELL: "/bin/sh" }, async () => {
      const start = processStart(own.pid);
      assert.match(String(start), /^(proc|ps):./, `the start time is not readable: ${start}`);
      const ownEntry = runsEntry(dir, "P5", 1, { pid: own.pid, pidStart: start }); // the own, living group
      writeRuns(dir, [ownEntry, runsEntry(dir, "P5", 2, { pid: foreign.pid, pidStart: "proc:1" })]); // 2: the number belongs to someone else
      initServices({ dataDir: dir, logFile });
      assert.throws(() => startSimple({ projectId: "P5", service: svc(1), cwd: dir }),
        (e) => e.code === "SERVICE_RUNNING" && e.status === 409 && /läuft bereits/.test(e.message), "the own living run was overwritten");
      assert.deepEqual(readRuns(dir).find((e) => e.key === "P5:1"), ownEntry, "the entry of the own run changed");
      // Second safeguard: recordAgentRun also does not replace the living simple run (the route asks beforehand).
      assert.throws(() => recordAgentRun({ projectId: "P5", service: svc(1), chatId: "c-agent" }), (e) => e.code === "SERVICE_RUNNING", "recordAgentRun overwrote the living run");
      assert.deepEqual(readRuns(dir).find((e) => e.key === "P5:1"), ownEntry, "recordAgentRun changed the entry of the own run");
      const run = startSimple({ projectId: "P5", service: svc(2), cwd: dir });
      assert.notEqual(run.pid, foreign.pid, "the entry with a foreign start time held the start");
      await waitForTruthy(() => readList(list).length === 1, "the new run stands");
      assert.equal(readRuns(dir).find((e) => e.key === "P5:2").pid, run.pid);
      await stopService({ projectId: "P5", serviceId: 2 });
      await waitForTruthy(() => !groupAlive(run.pid), "the new run ends");
      assert.equal(groupAlive(foreign.pid), true, "the foreign group got a signal");
    });
    // Without the operation mark (local): the same identity — service-runs.json survives the restart of the Mac, the processes
    // do not. The own group holds the start; a foreign one (other start time) and a legacy entry without a start time do not —
    // they are replaced, and the foreign group gets no signal.
    await withEnvironment({ ...MARKER_FROM, SHELL: "/bin/sh" }, async () => {
      const ownEntry = runsEntry(dir, "P5", 3, { pid: own.pid, pidStart: processStart(own.pid) });
      writeRuns(dir, [ownEntry, runsEntry(dir, "P5", 4, { pid: foreign.pid, pidStart: "proc:1" }), runsEntry(dir, "P5", 5, { pid: foreign.pid })]);
      initServices({ dataDir: dir, logFile });
      assert.throws(() => startSimple({ projectId: "P5", service: svc(3), cwd: dir }), (e) => e.code === "SERVICE_RUNNING", "without the operation mark the start overwrote the own living run");
      assert.deepEqual(readRuns(dir).find((e) => e.key === "P5:3"), ownEntry);
      for (const sid of [4, 5]) {
        const prior = readList(list).length;
        const run = startSimple({ projectId: "P5", service: svc(sid), cwd: dir });
        assert.notEqual(run.pid, foreign.pid, `without the operation mark the entry ${sid} (foreign pid) held the start`);
        assert.equal(run.pidStart, processStart(run.pid), "without the operation mark the start time of the new run is missing");
        await waitForTruthy(() => readList(list).length === prior + 1, `the new run of ${sid} stands`);
        await stopService({ projectId: "P5", serviceId: sid });
        await waitForTruthy(() => !groupAlive(run.pid), `the new run of ${sid} ends`);
      }
      assert.equal(groupAlive(foreign.pid), true, "the foreign group got a signal");
    });
  } finally {
    kill(children.map((k) => k.pid));
    cleanSleepers(identifier);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (20) State with a foreign pid ────────────────────────────────────────────────────────────────
test("(20) a port service with a closed port whose stored pid belongs to another process (start time wrong) counts as dead: the state removes the entry, the stop afterwards does not hit the foreign group — with and without the operation mark", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-fremdepid-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const foreign = spawn("sleep", ["100000"], { detached: true, stdio: "ignore" });
  try {
    await new Promise((r) => foreign.once("spawn", r));
    foreign.unref();
    setServicesSeam({}); // without an instance
    const port = await closedPort();
    for (const marker of [MARKER_ON, MARKER_FROM]) {
      await withEnvironment(marker, async () => {
        writeRuns(dir, [runsEntry(dir, "P6", 1, { pid: foreign.pid, pidStart: "proc:1", port })]);
        initServices({ dataDir: dir, logFile });
        const snapshot = await serviceStatus("P6", 1, { port });
        assert.deepEqual([snapshot.running, snapshot.holdsStart], [false, false], `state with a foreign pid: ${JSON.stringify(snapshot)}`);
        assert.deepEqual(readRuns(dir).filter((e) => e.projectId === "P6"), [], "the entry with a foreign pid stayed");
        const s = await stopService({ projectId: "P6", serviceId: 1, port });
        assert.equal(s.killed.includes(foreign.pid), false, `the stop hit the foreign group: ${JSON.stringify(s)}`);
        assert.equal(groupAlive(foreign.pid), true, "the foreign group no longer lives");
      });
    }
  } finally {
    try { process.kill(-foreign.pid, "SIGKILL"); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (21) No start during the relocation ───────────────────────────────────────────────
test("(21) while the project is relocating (lock \"relocation\", open relocation journal, instance in state \"relocation\"), every start is 409 RELOCATION — simple as by agent, without a process, entry or chat; afterwards the service starts", async () => {
  const fd = await fakeDocker();
  const identifier = sleepIdentifier();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { converted: false });
        const list = path.join(ctx.root, "groups.list");
        const service = await createService(ctx, o.p, { name: "relocator", port: await closedPort(), startCommand: listCommand(list, identifier) });
        const denied = async (situation) => {
          const chatsPrior = store.chatIdsInProject(o.p.id).length;
          for (const body of [{}, { mode: "agent" }]) {
            const r = await startAt(ctx, o.p, service, body);
            assert.equal(r.status, 409, `${situation}, ${body.mode || "simple"}: ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal(r.body.code, "RELOCATION", `${situation}: ${JSON.stringify(r.body)}`);
          }
          assert.equal(fs.existsSync(o.runsFile) ? entry(o.runsFile, o.p, service) : null, null, `${situation}: an entry was created`);
          assert.equal(store.chatIdsInProject(o.p.id).length, chatsPrior, `${situation}: an agent chat was created`);
          assert.deepEqual(readList(list), [], `${situation}: a process was started`);
        };

        // (a) the lock with reason "relocation" (step 2 of the relocation, before the journal)
        const lock = projectLocks(o.p.id, { reason: "relocation" });
        assert.equal(lock.ok, true, JSON.stringify(lock));
        try { await denied("lock relocation"); } finally { lock.resolve(); }
        // (b) an open relocation journal (e.g. after a restart, before the follow-up start continues)
        const j = store.createRelocation({ projectId: o.p.id, instance: "main", location: path.join(ctx.root, "relocation-location") });
        try { await denied("open journal"); } finally { store.endRelocation(j.id, "aborted"); }
        // (c) the instance in state "relocation"
        store.changeProjectInstance(o.p.id, "main", { state: "relocation" });
        try { await denied("instance relocation"); } finally { store.changeProjectInstance(o.p.id, "main", { state: "ready" }); }

        // Afterwards the same service starts (in B — the project is not converted).
        const r = await startAt(ctx, o.p, service);
        assert.equal(r.status, 202, JSON.stringify(r.body));
        await waitForTruthy(() => readList(list).length === 1, "the service runs after the relocation");
        const s = await stop2(ctx, o.p, service);
        assert.ok(s.killed.includes(r.body.pid), JSON.stringify(s));
      });
    });
  } finally {
    cleanSleepers(identifier);
    fd.cleanUp();
  }
});

// ── (22)–(24) services per instance ─────────────────────────────────────────────────────────────────────────────────
const COPY = "copy-k1";
// A copy next to the main one: its container in the fake docker and its row (converted) — the service path needs no more
// (build, overlay and stack_copies are not involved).
function copyAlongside(fd, o, { ip = "127.0.0.1" } = {}) {
  const container = `cbase-k-${o.p.id}-k1`;
  execFileSync(fd.bin, ["run", "-d", "--name", container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  store.createProjectInstance({ projectId: o.p.id, instance: COPY, state: "ready", convertedAt: Date.now(), containerId: container, ip });
  return { container, identifier: `${o.p.id}/${COPY}` };
}
const withInstance = (filePath, identifier) => (identifier === undefined ? filePath : `${filePath}?instance=${encodeURIComponent(identifier)}`);
async function serviceCall(ctx, o, service, what, identifier, body = undefined) {
  const method = what === "log" ? "GET" : "POST";
  const r = await fetch(`${ctx.base}${withInstance(`/api/projects/${o.p.id}/services/${service.id}/${what}`, identifier)}`, {
    method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
const allEntries = (runsFile) => (fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")) : []);
async function listenerOn(host) {
  const srv = net.createServer((sock) => sock.end());
  await new Promise((ok, no) => { srv.once("error", no); srv.listen(0, host, ok); });
  return { port: srv.address().port, close: () => new Promise((ok) => srv.close(() => ok())) };
}

test("(22) the same service in main and copy — the start in the copy is exec -d in cbase-k-…, own entry, own log, only its desired; the start in the main one is not held by it; stop per instance", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const k = copyAlongside(fd, o);
        const service = await createService(ctx, o.p, { name: "web", startCommand: `echo SERVICE-LOG; ${markerCommand(ctx.root, "service")}; exec sleep 100000` });
        const copyKey = `${o.p.id}:${service.id}@${COPY}`;
        const entryCopy = () => allEntries(o.runsFile).find((e) => e.key === copyKey) || null;

        // Start in the copy.
        const r = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "simple" });
        assert.equal(r.status, 202, `${r.status}: ${JSON.stringify(r.body)}`);
        await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service in the copy");
        const mk = readMarker(ctx.root, "service");
        groups.push(mk.pgid);
        fs.rmSync(path.join(ctx.root, "service.marker"));
        assert.equal(serviceExecs(fd, k.container).length, 1, `no "docker exec -d … ${k.container} …" — the start of the copy did not run in it (execs: ${JSON.stringify(hostExecs(fd).map((a) => a.args)).slice(0, 600)})`);
        assert.equal(serviceExecs(fd, o.container).length, 0, "the start of the copy ran in the main one");
        const ak = serviceExecs(fd, k.container)[0].args;
        assert.equal(valueValue(ak, "--log"), path.join(o.serviceLogs, `${COPY}_${service.id}.log`), "the log of the copy is called copy-k1_<svc>.log");
        await waitForTruthy(() => entryCopy()?.pgid === mk.pgid, "pgid in the entry of the copy");
        assert.equal(entryCopy().instance, k.identifier);
        assert.equal(entry(o.runsFile, o.p, service), null, "an entry under the key of the main one");
        assert.deepEqual(store.projectInstance(o.p.id, COPY).desired.services, [service.id], "desired.services of the copy");
        assert.deepEqual(store.projectInstance(o.p.id, "main").desired?.services ?? [], [], "the desired of the main one changed");
        // State and log per instance.
        assert.equal((await serviceStatus(o.p.id, service.id, { instance: COPY })).running, true, "state of the copy");
        assert.equal((await statusOf(ctx, o.p, service)).running, false, "the main one counts as running");
        await waitForTruthy(async () => (await serviceCall(ctx, o, service, "log", k.identifier)).body.log.includes("SERVICE-LOG"), "log of the copy");
        assert.equal((await serviceCall(ctx, o, service, "log")).body.log, "", "the log of the main one shows the copy");

        // Start in the main one: the living run of the copy does not hold it (start protection per instance), and it overwrites nothing.
        const rh = await serviceCall(ctx, o, service, "start", undefined, { mode: "simple" });
        assert.equal(rh.status, 202, `${rh.status}: ${JSON.stringify(rh.body)}`);
        await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service in the main one");
        const mh = readMarker(ctx.root, "service");
        groups.push(mh.pgid);
        assert.equal(serviceExecs(fd, o.container).length, 1, "no exec -d into the main one");
        assert.equal(serviceExecs(fd, k.container).length, 1, "a second exec -d into the copy");
        assert.equal(valueValue(serviceExecs(fd, o.container)[0].args, "--log"), path.join(o.serviceLogs, `main_${service.id}.log`));
        await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === mh.pgid, "pgid in the entry of the main one");
        assert.equal(entryCopy()?.pgid, mk.pgid, "the entry of the copy was overwritten");
        assert.deepEqual(store.projectInstance(o.p.id, "main").desired.services, [service.id]);
        // A second start IN the copy: 409 ("is already running" — its state asks `kill -0` in ITS container), no second exec.
        const r2 = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "simple" });
        assert.equal(r2.status, 409, JSON.stringify(r2.body));
        assert.equal(serviceExecs(fd, k.container).length, 1);
        // The start protection itself in the copy: its entry holds its start (that the one of the main one does not is shown by
        // the start in the main one above, in the opposite direction).
        assert.throws(() => startSimple({ projectId: o.p.id, service, cwd: o.projPath, instance: COPY }), { code: "SERVICE_RUNNING" });

        // Stop of the copy: only its group, only its desired, only its entry.
        const sk = await serviceCall(ctx, o, service, "stop", k.identifier);
        assert.equal(sk.status, 200, JSON.stringify(sk.body));
        assert.equal(sk.body.stopped, true, JSON.stringify(sk.body));
        assert.ok(hostExecs(fd).some((x) => x.args.includes(k.container) && x.args.includes("-TERM") && x.args.includes(`-${mk.pgid}`)), "no kill -TERM in the copy");
        assert.equal(hostExecs(fd).some((x) => x.args.includes(o.container) && x.args.includes("kill") && !x.args.includes("-0")), false, "the stop of the copy sent a signal into the main one");
        await waitForTruthy(() => !groupAlive(mk.pgid), "group of the copy ended");
        assert.equal(groupAlive(mh.pgid), true, "the stop of the copy hit the main one");
        assert.deepEqual(store.projectInstance(o.p.id, COPY).desired.services, [], "desired.services of the copy after the stop");
        assert.deepEqual(store.projectInstance(o.p.id, "main").desired.services, [service.id], "the desired of the main one after the stop of the copy");
        assert.equal(entryCopy(), null, "the entry of the copy is still there after the stop");
        assert.equal(entry(o.runsFile, o.p, service)?.pgid, mh.pgid, "the entry of the main one fell with the stop of the copy");

        // There is no agent start in a copy (the service agent is a chat of its own without a binding to the copy — it would run in
        // the main one; not built even with the move-in): 409, no chat, no entry — and the stored start instruction of the service
        // (per project and service, not per instance) stays as it was (the rejected start used to write it empty). The message
        // promises nothing that does not exist (it used to say "follows with the move-in of the chat" after the move-in was built).
        store.setStartInstructions(o.p.id, service.name, "INSTRUCTION-OF-THE-MAIN");
        const chatsPrior = store.chatIdsInProject(o.p.id).length;
        const ra = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "agent" });
        assert.deepEqual([ra.status, ra.body.code], [409, "COPY_AGENT"], JSON.stringify(ra.body));
        assert.doesNotMatch(ra.body.error, /folgt mit dem Einzug|follows once the chat moves in/, "the message promises an agent start that does not exist");
        assert.match(ra.body.error, /keinen Agent-Start|no agent start/, ra.body.error);
        assert.equal(store.chatIdsInProject(o.p.id).length, chatsPrior, "an agent chat was created for the copy");
        assert.equal(entryCopy(), null);
        assert.equal(store.getStartInstructions(o.p.id, service.name), "INSTRUCTION-OF-THE-MAIN", "the rejected agent start of the copy overwrote the start instruction");
        assert.equal(store.listProjectServices(o.p.id).find((x) => x.id === service.id)?.agentInstructions, "INSTRUCTION-OF-THE-MAIN");

        // The choice: `<project>/main` is the main one; unknown 404, foreign project or without form 400 — on all three routes.
        const logMain = await serviceCall(ctx, o, service, "log", `${o.p.id}/main`);
        assert.equal(logMain.status, 200);
        for (const [raw, status] of [[`${o.p.id}/copy-zz`, 404], ["other/main", 400], ["without-form", 400]]) {
          for (const what of ["start", "stop", "log"]) {
            const x = await serviceCall(ctx, o, service, what, raw, { mode: "simple" });
            assert.equal(x.status, status, `${what} ?instance=${raw}: ${x.status} ${JSON.stringify(x.body)}`);
          }
        }
        assert.equal(serviceExecs(fd, k.container).length, 1, "a rejected choice started something");

        // Stop of the main one.
        const sh = await serviceCall(ctx, o, service, "stop");
        assert.equal(sh.body.stopped, true, JSON.stringify(sh.body));
        await waitForTruthy(() => !groupAlive(mh.pgid), "group of the main one ended");
        await waitForTruthy(() => openServiceObservations() === 0, "observer empty");
        assert.deepEqual(local.calls(), [], "the local docker was called");
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

test("(23) failed start, monitor and resources per instance — the bell names the copy, its failure reports under its own key, its containers count for the project", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        // Without a copy: no field `instances`.
        const without = (await json(`${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`)).resources.find((x) => x.projectId === o.p.id);
        assert.equal("instances" in without, false, `without a copy the answer carries instances: ${JSON.stringify(without)}`);
        const k = copyAlongside(fd, o, { ip: second });

        // Resources: both containers count, `instances` names them (main one first).
        const res = (await json(`${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`)).resources.find((x) => x.projectId === o.p.id);
        assert.deepEqual((res.instances || []).map((i) => i.identifier), [`${o.p.id}/main`, k.identifier], JSON.stringify(res));
        assert.equal(res.containers, 2, JSON.stringify(res));
        assert.ok(fd.calls({ daemon: "host" }).some((a) => a.args[0] === "stats" && a.args.includes(k.container)), "no docker stats for the copy"); // bundled since (33)
        // With a quota (cgroup memory.max 2 GiB) `memLimitBytes` of the converted project and of every instance does not stand
        // above it — docker stats reports 8 GiB here. Counter-test: the cap in the route removed => red.
        const root = path.join(ctx.root, "cgroup-root");
        fs.mkdirSync(path.join(root, "sys", "fs", "cgroup"), { recursive: true });
        fs.writeFileSync(path.join(root, "sys", "fs", "cgroup", "memory.max"), `${2 * 1024 ** 3}\n`);
        fs.writeFileSync(path.join(root, "sys", "fs", "cgroup", "memory.current"), `${1024 ** 3}\n`);
        const capped = await withEnvironment({ CBASE_STORAGE_ROOT: root }, () => json(`${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`));
        assert.equal(capped.quota?.mem?.totalBytes, 2 * 1024 ** 3, JSON.stringify(capped.quota));
        const zg = capped.resources.find((x) => x.projectId === o.p.id);
        assert.deepEqual([zg.memLimitBytes, ...zg.instances.map((i) => i.memLimitBytes)], [2 * 1024 ** 3, 2 * 1024 ** 3, 2 * 1024 ** 3], JSON.stringify(zg));
        assert.equal(res.memLimitBytes, 8 * 1024 ** 3, "without a quota the number of docker stats");

        // Failed start in the copy.
        const stream = await globalStreamFor(ctx.base);
        try {
          const broken = await createService(ctx, o.p, { name: "broken", startCommand: "echo BROKEN-LOG; exit 3" });
          const r = await serviceCall(ctx, o, broken, "start", k.identifier, { mode: "simple" });
          assert.equal(r.status, 202, JSON.stringify(r.body));
          await waitForTruthy(() => failedStarts(stream.events, "broken").length > 0, "bell \"Start fehlgeschlagen\" of the copy");
          const n = failedStarts(stream.events, "broken")[0].notice;
          assert.match(n.title, /broken \(Kopie k1\)/, JSON.stringify(n));
          assert.equal(n.instance, COPY, JSON.stringify(n));
          assert.match(n.body, /Code 3/);
        } finally {
          await stream.shutdown();
        }

        // Monitor: a port service that listens only in the copy. First forget the state of other servers (no targets).
        await checkNow();
        const l = await listenerOn(second);
        open.push(l);
        const web = await createService(ctx, o.p, { name: "web", port: l.port });
        const prior = getMonitorEvents(0).reduce((m, e) => Math.max(m, e.id), 0);
        await checkNow(); // first contact: main one down, copy up — nothing reported
        assert.deepEqual(getMonitorEvents(prior).filter((e) => e.kind === "down" || e.kind === "up"), [], "the first contact reported something");
        await l.close();
        open.length = 0;
        await checkNow();
        await checkNow(); // second failure: confirmed
        const events = getMonitorEvents(prior).filter((e) => e.kind === "down" || e.kind === "up");
        assert.deepEqual(events.map((e) => [e.kind, e.key, e.instance]), [["down", `project:${web.id}@${COPY}`, COPY]],
          `no failure of the copy under its own key (events: ${JSON.stringify(events)})`);
        assert.match(events[0].body, /Kopie k1 · web/, events[0].body);
        assert.deepEqual(local.calls(), [], "the local docker was called");
      });
    });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
  }
});

test("(24) fence: with the token of a copy, log, start and stop act only in it — ?instance=<project>/main is 403, without a statement the copy is added", () => {
  const copy = { projectId: "pA", instance: COPY, identifier: `pA/${COPY}` };
  const main = { projectId: "pA", instance: "main", identifier: "pA/main" };
  const view = {
    project: (id) => (id === "pA" ? { id: "pA", workspaceId: "w1", path: "/ws/a" } : null),
    service: (id) => (id === "7" ? { id: 7, projectId: "pA" } : null),
  };
  for (const family of ["project-service-log", "project-service-start", "project-service-stop"]) {
    const row = FENCE_TABLE.find((z) => z.family === family);
    const method = family === "project-service-log" ? "GET" : "POST";
    const params = { project: "pA", service: "7" };
    const without = new URLSearchParams("");
    assert.deepEqual(checkScope({ instance: copy, row, params, method, query: without }, view), { ok: true }, family);
    assert.equal(without.get("instance"), `pA/${COPY}`, `${family}: the copy is added`);
    assert.deepEqual(checkScope({ instance: copy, row, params, method, query: new URLSearchParams(`instance=pA%2F${COPY}`) }, view), { ok: true }, family);
    for (const foreign of ["instance=pA%2Fmain", "instance="]) {
      const r = checkScope({ instance: copy, row, params, method, query: new URLSearchParams(foreign) }, view);
      assert.equal(r.ok, false, `${family} ?${foreign} with the token of the copy went through`);
      assert.match(r.reason, /only the value of this project/);
    }
    // The main one the other way round: the copy is 403 for its token.
    const r = checkScope({ instance: main, row, params, method, query: new URLSearchParams(`instance=pA%2F${COPY}`) }, view);
    assert.equal(r.ok, false, `${family}: the main one reached the copy`);
  }
});

// ── (25) Services in the pause ──────────────────────────────────────────────────────────────────────
test("(25) state and stop in the pause wait at the barrier (no verdict, entry stays); a pause that cbase does not hold is unknown — entry, desired and group stay, stopped:false", async () => {
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const dx = (...args) => execFileSync(fd.bin, args, { env: { ...process.env, ...fd.env } });
        const service = await createService(ctx, o.p, { name: "worker", startCommand: `${markerCommand(ctx.root, "service")}; exec sleep 100000` });
        const desired = () => store.projectInstance(o.p.id, "main").desired?.services ?? [];
        const started = async () => {
          const r = await startAt(ctx, o.p, service, { mode: "simple" });
          assert.equal(r.status, 202, JSON.stringify(r.body));
          await waitForTruthy(() => markerExists(ctx.root, "service"), "mark of the service");
          const m = readMarker(ctx.root, "service");
          fs.rmSync(path.join(ctx.root, "service.marker"));
          groups.push(m.pgid);
          await waitForTruthy(() => entry(o.runsFile, o.p, service)?.pgid === m.pgid, "pgid in the entry");
          return m;
        };
        try {
          // 1. The state in the pause waits (ends also at the counter event: without the barrier it judges at once).
          const m = await started();
          await pause(o.container);
          let snapshot = null;
          const statusFinished = statusOf(ctx, o.p, service).then((x) => { snapshot = x; });
          await waitForTruthy(() => waitingForThaw() >= 1 || snapshot, "the state stands at the barrier");
          assert.equal(snapshot, null, `the state judged during the pause: ${JSON.stringify(snapshot)}`);
          assert.equal(entry(o.runsFile, o.p, service)?.pgid, m.pgid, "the entry fell during the pause");
          await thawOut(o.container);
          await statusFinished;
          assert.equal(snapshot.running, true, `after the thaw: ${JSON.stringify(snapshot)}`);
          assert.equal(entry(o.runsFile, o.p, service)?.pgid, m.pgid, "the entry fell");

          // 2. The stop in the pause waits and stops after the thaw.
          await pause(o.container);
          let stop = null;
          const stopFinished = stop2(ctx, o.p, service).then((x) => { stop = x; });
          await waitForTruthy(() => waitingForThaw() >= 1 || stop, "the stop stands at the barrier");
          assert.equal(stop, null, `the stop judged during the pause: ${JSON.stringify(stop)}`);
          assert.ok(groupAlive(m.pgid), "the group died during the pause — the test measures nothing");
          assert.deepEqual(desired(), [service.id], "the desired fell during the pause");
          await thawOut(o.container);
          await stopFinished;
          assert.equal(stop.stopped, true, JSON.stringify(stop));
          await waitForTruthy(() => !groupAlive(m.pgid), "the group got the stop after the thaw");
          assert.equal(entry(o.runsFile, o.p, service), null, "the entry is still there after the stop");
          assert.deepEqual(desired(), []);

          // 3. A pause that cbase does NOT hold: "is paused" is unknown, never "dead".
          const m2 = await started();
          dx("pause", o.container);
          try {
            await statusOf(ctx, o.p, service);
            assert.equal(entry(o.runsFile, o.p, service)?.pgid, m2.pgid, "\"is paused\" read as \"dead\": the state deleted the entry");
            const s = await stop2(ctx, o.p, service);
            assert.equal(s.stopped, false, `a stop that reached nothing reported success: ${JSON.stringify(s)}`);
            assert.match(String(s.error), /eingefroren/, JSON.stringify(s));
            assert.ok(groupAlive(m2.pgid), "the group died — the test measures nothing");
            assert.equal(entry(o.runsFile, o.p, service)?.pgid, m2.pgid, "the stop deleted the entry without killing anything");
            assert.deepEqual(desired(), [service.id], "the stop took the desired back without killing anything");
          } finally {
            dx("unpause", o.container);
          }
          const s2 = await stop2(ctx, o.p, service);
          assert.equal(s2.stopped, true, JSON.stringify(s2));
          await waitForTruthy(() => !groupAlive(m2.pgid), "group ended after the unpause");
          await waitForTruthy(() => openServiceObservations() === 0, "observer empty");
        } finally {
          if (isFrozen(o.container)) await thawOut(o.container).catch(() => {});
        }
      });
    });
  } finally {
    kill(groups);
    fd.cleanUp();
  }
});

// ── (26) Which native services run (nativeServicesStatus — freeze of a copy, clear-away) ─────────────────
test("(26) nativeServicesStatus: the run decides \"native\" — a service with a registered but not running container and an open port runs natively; a running container is no native service", async () => {
  const fd = await fakeDocker();
  const ip = await secondLoopback();
  // Two listeners "in the instance": the frontend (`npm run dev`, native) and the published port of the database (container).
  const listener = [net.createServer(), net.createServer()];
  for (const s of listener) await new Promise((r) => s.listen(0, ip, r));
  const [fePort, dbPort] = listener.map((s) => s.address().port);
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { ip, name: "Lux" });
        // The compose container of the database runs in the inner daemon; that of the frontend does not exist (it runs natively).
        execFileSync(fd.bin, ["exec", "-u", "agent", o.container, "docker", "run", "-d", "--name", "orbit2-postgres",
          "--label", "com.docker.compose.service=postgres", "--label", `com.docker.compose.project.working_dir=${o.projPath}`, "postgres:16"], { env: { ...process.env, ...fd.env } });
        const frontend = await createService(ctx, o.p, { name: "frontend", container: "examplecorp-web-portal", port: fePort, startCommand: "npm run dev" });
        const db = await createService(ctx, o.p, { name: "postgres", container: "orbit2-postgres", port: dbPort, startCommand: "docker compose up postgres" });
        await createService(ctx, o.p, { name: "minio", container: "orbit2-minio", startCommand: "docker compose up minio" });
        const worker = await createService(ctx, o.p, { name: "worker", startCommand: "node worker.js" });
        // Witness: the port of the database is open — without a look at its container it would count as natively running.
        assert.equal((await serviceStatus(o.p.id, db.id, { port: dbPort })).running, true, "the port of the database is closed — the test measures nothing");

        const snapshot = await nativeServicesStatus(o.p.id);
        assert.deepEqual(snapshot, [
          { id: frontend.id, name: "frontend", port: fePort, running: true },
          { id: worker.id, name: "worker", port: null, running: false },
        ].sort((a, b) => a.id - b.id), JSON.stringify(snapshot));
        assert.ok(fd.calls({ daemon: o.container }).some((a) => a.args[0] === "ps"), "no docker ps in the inner daemon — the container glance is missing");
        assert.deepEqual(local.calls(), [], "the local docker was called for a converted project");
      });
    });
  } finally {
    for (const s of listener) await new Promise((r) => s.close(r));
    fd.cleanUp();
  }
});

// ── (26b) An unreadable inner daemon does not mean "no container runs" ───────────────────────────────
test("(26b) nativeServicesStatus: if the state of the inner Docker is unknown, the computation fails — a container service with an open port does not count as native", async () => {
  const fd = await fakeDocker();
  const ip = await secondLoopback();
  const listener = [net.createServer(), net.createServer()];
  for (const s of listener) await new Promise((r) => s.listen(0, ip, r));
  const [fePort, dbPort] = listener.map((s) => s.address().port);
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd, { ip, name: "Lux" });
        execFileSync(fd.bin, ["exec", "-u", "agent", o.container, "docker", "run", "-d", "--name", "orbit2-postgres",
          "--label", "com.docker.compose.service=postgres", "--label", `com.docker.compose.project.working_dir=${o.projPath}`, "postgres:16"], { env: { ...process.env, ...fd.env } });
        const frontend = await createService(ctx, o.p, { name: "frontend", container: "examplecorp-web-portal", port: fePort, startCommand: "npm run dev" });
        await createService(ctx, o.p, { name: "postgres", container: "orbit2-postgres", port: dbPort, startCommand: "docker compose up postgres" });

        // The inner daemon does not answer `ps` (e.g. a hanging or restarting dockerd).
        fd.errorAt([{ daemon: o.container, pattern: "^ps " }]);
        await assert.rejects(nativeServicesStatus(o.p.id), /state of the inner Docker of project .* unknown/,
          "an unreadable inner daemon counted the database (open port) as a natively running service");

        // Counter-check: the same state with a readable daemon — the database is carried by its container, only the frontend runs natively.
        fd.errorAt([]);
        assert.deepEqual(await nativeServicesStatus(o.p.id), [{ id: frontend.id, name: "frontend", port: fePort, running: true }]);
        assert.deepEqual(local.calls(), [], "the local docker was called for a converted project");
      });
    });
  } finally {
    for (const s of listener) await new Promise((r) => s.close(r));
    fd.cleanUp();
  }
});

// ── Further guards of the service path ────────────────────────────────────────────────────────────────────────────────
//  RP9-8 THE HELPER groupAlive (process-group.mjs) does not count zombies: a group that consists only of an unreaped child
//       (perl: child `setpgrp` + `exit`, parent sleeps) does not live — `process.kill(-G, 0)` (the old helper) says yes and in
//       a container without `--init` made every wait for `!alive(-pgid)` hang.
//  (27) a PORTLESS simple service that runs is in /api/project-services as `running:true, holdsStart:false`; a second start
//       is 409 with the name in „…“ — the closing mark is “, not the straight ".
//  (28) a state that wants to remove a DEAD entry while a start of the same service replaces the entry removes only the entry
//       it checked — the new run stays recorded (nativeRuns names it).
//  (29) THE GROUP OF THE ENTRY: if the leader has ended but a member has not (`sh -c 'sleep … & exit'`), the group still belongs
//       to the entry (a pgid is not reassigned while the group exists) — the start protection holds (SERVICE_RUNNING), the state
//       says "running", the stop ends the member. The entry carries the boot mark of now — as startSimple writes it.
//  (30) A FOREIGN GROUP WITHOUT A LEADER: after a restart of the Mac or a swap of B the pid of an old entry can be the pgid of a
//       FOREIGN group whose leader has already ended (daemon pattern). Without a boot mark in the entry (legacy) or with another
//       one it does not count as own: state `running:false, holdsStart:false`, the entry falls, the start is free, the stop sends
//       NO signal (`killed: []`, the member lives), nativeRuns does not name it — with and without the operation mark.
//  (31) THE RELOCATION PATH ASKS THE SAME VERDICT: a service started with the operation mark through startSimple (start time and
//       boot mark in the entry) whose leader ends and whose member lives is in nativeRuns (tick, plan collection, step 4 and its
//       process search see it); "empty RUNS" without it leaves the entry (`open`); endNativeRuns with it ends the member, the
//       entry falls.
//  (32) THE GUARD FOR THE CLOSING MARK: in projects/routes.js no „…-quote outside comments closes with the straight " (the rule
//       is: closing is always “); the guard checks on a built-in sample that it bites and skips comments.
// Counter-tests: `groupOfTheEntry` does not ask for the group when the leader is dead => (29) red; the route takes probeStatus
// instead of serviceRunning => (27) red; `RUNS.get(k) === run` removed => (28) red; `groupOfTheEntry` again "group lives => own"
// without a boot mark => (30) red, (29) (31) green; `ownGroupAlive` again only with a living leader => (31) red ("nativeRuns
// overlooks the service with an ended leader"), (16) (29) (30) green; a straight " in the skill message back => (32) red.
test("RP9-8 groupAlive does not count zombies: a group made only of an unreaped child does not live, kill(-G, 0) says yes", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-zombie-group-"));
  const marker = path.join(dir, "kind.pid");
  const parent = spawn("perl", ["-e", `my $k = fork(); if ($k == 0) { setpgrp(0, 0); exit 0; } open(my $f, ">", "${marker}.tmp"); print $f $k; close($f); rename("${marker}.tmp", "${marker}"); sleep 100000;`], { stdio: "ignore" });
  try {
    await waitForTruthy(() => fs.existsSync(marker), "the mark of the child");
    const G = Number(fs.readFileSync(marker, "utf8"));
    // The child has ended but is not reaped: ps shows it as Z — only then does the guard measure anything.
    await waitForTruthy(() => /^Z/.test(execFileSync("ps", ["-o", "stat=", "-p", String(G)], { encoding: "utf8" }).trim()), "the child is a zombie");
    let old;
    try { process.kill(-G, 0); old = true; } catch (e) { old = e.code === "EPERM"; }
    assert.equal(old, true, "the old helper (kill -0 to the group) did not see the zombie group as living — the guard measures nothing");
    assert.equal(groupAlive(G), false, "groupAlive counts the zombie");
    assert.equal(processAlive(G), false, "processAlive counts the zombie");
    assert.equal(processAlive(parent.pid), true, "the living parent does not count as living");
    const ownGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
    assert.equal(groupAlive(ownGroup), true, "the group of the test process does not count as living");
  } finally {
    parent.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(27) a portless service that runs is running:true, holdsStart:false in /api/project-services; the second start is 409 „…“", async () => {
  const fd = await fakeDocker();
  const identifier = sleepIdentifier();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(withoutOps(fd, local), async () => {
        const o = await project(ctx, fd, { converted: true });
        const list = path.join(ctx.root, "portless.list");
        const service = await createService(ctx, o.p, { name: "portless", startCommand: listCommand(list, identifier) });
        const one = await startAt(ctx, o.p, service);
        assert.equal(one.status, 202, JSON.stringify(one.body));
        await waitForTruthy(() => readList(list).length === 1, "the run stands");
        const [group] = readList(list);
        const row = (await json(`${ctx.base}/api/project-services`)).find((s) => s.id === service.id);
        assert.deepEqual([row?.running, row?.holdsStart], [true, false], `Apps-Seite: ${JSON.stringify(row)}`);
        assert.equal((await statusOf(ctx, o.p, service)).running, true, "the services list of the project gives the same answer");
        const two = await startAt(ctx, o.p, service);
        assert.equal(two.status, 409, JSON.stringify(two.body));
        assert.ok(two.body.error.includes("„portless“ läuft bereits."), `closing quotation mark: ${two.body.error}`);
        const s = await stop2(ctx, o.p, service);
        assert.ok(s.killed.includes(group), JSON.stringify(s));
        await waitForTruthy(() => !groupAlive(group), "the group ends");
        const afterwards = (await json(`${ctx.base}/api/project-services`)).find((x) => x.id === service.id);
        assert.deepEqual([afterwards?.running, afterwards?.holdsStart], [false, false], JSON.stringify(afterwards));
      });
    });
  } finally {
    cleanSleepers(identifier);
    fd.cleanUp();
  }
});

test("(28) the state removes only the entry it checked — a start in between stays recorded", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-race-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const list = path.join(dir, "groups.list");
  const identifier = sleepIdentifier();
  let run = null;
  try {
    const tot = spawn("true", [], { stdio: "ignore" });
    await new Promise((r) => tot.once("exit", r));
    const port = await closedPort();
    setServicesSeam({}); // without an instance
    await withEnvironment({ ...MARKER_FROM, SHELL: "/bin/sh" }, async () => {
      writeRuns(dir, [runsEntry(dir, "P8", 1, { pid: tot.pid, port })]);
      initServices({ dataDir: dir, logFile });
      const snapshot = serviceStatus("P8", 1, { port }); // without await: it checks the port, the start comes in between
      run = startSimple({ projectId: "P8", service: { id: 1, name: "race", port, startCommand: listCommand(list, identifier) }, cwd: dir });
      assert.equal((await snapshot).running, false, "the port is closed");
      assert.deepEqual(nativeRuns("P8"), [{ serviceId: 1, pid: run.pid }], "the state removed the entry of the new run");
      await waitForTruthy(() => readList(list).length === 1, "the new run stands");
      await stopService({ projectId: "P8", serviceId: 1, port });
      await waitForTruthy(() => !groupAlive(run.pid), "the new run ends");
    });
  } finally {
    if (run?.pid) kill([run.pid]);
    cleanSleepers(identifier);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(29) leader ended, member lives — the group belongs to the entry (start time and boot mark of now): start protection holds, state \"running\", the stop ends the member", async () => {
  const { bootMarker, checkStartFree } = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-leaderless-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const identifier = sleepIdentifier();
  const memberFile = path.join(dir, "member.pid");
  // The leader starts a member in ITS group and ends at once.
  const leader = spawn("sh", ["-c", `sleep 100000.${identifier} & echo $! > '${memberFile}.tmp' && mv '${memberFile}.tmp' '${memberFile}'; exit 0`], { detached: true, stdio: "ignore" });
  const G = leader.pid;
  try {
    await new Promise((r) => leader.once("exit", r)); // after `exit` the leader is reaped — kill(G, 0) fails
    await waitForTruthy(() => fs.existsSync(memberFile), "the pid of the member");
    const member = Number(fs.readFileSync(memberFile, "utf8"));
    assert.equal(processAlive(G), false, "the leader still lives — the test measures nothing");
    assert.equal(processAlive(member), true, "the member does not live — the test measures nothing");
    assert.equal(groupAlive(G), true, "the group does not live — the test measures nothing");
    setServicesSeam({}); // without an instance
    for (const marker of [MARKER_ON, MARKER_FROM]) {
      await withEnvironment(marker, async () => {
        // A start in B carries the boot mark — without it the leaderless group would count as foreign ((30)).
        assert.ok(bootMarker(), "the boot mark is not readable — the test measures nothing");
        writeRuns(dir, [runsEntry(dir, "P7", 1, { pid: G, pidStart: "proc:the-leader", bootMarker: bootMarker() })]);
        initServices({ dataDir: dir, logFile });
        assert.throws(() => checkStartFree("P7", { id: 1, name: "leaderless" }), (e) => e.code === "SERVICE_RUNNING", "the start protection overlooked the living member");
        const snapshot = await serviceStatus("P7", 1);
        assert.equal(snapshot.running, true, `state: ${JSON.stringify(snapshot)}`);
        assert.equal(readRuns(dir).length, 1, "the state removed the entry of the living group");
      });
    }
    const s = await stopService({ projectId: "P7", serviceId: 1 });
    assert.ok(s.killed.includes(G), `the stop sent no signal to the group: ${JSON.stringify(s)}`);
    await waitForTruthy(() => !processAlive(member), "the member ends");
  } finally {
    kill([G]);
    cleanSleepers(identifier);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The entries of ONE project — (30) and (31) share RUNS (one module): a red predecessor would otherwise leave its entries.
const entriesOf = (dir, projectId) => readRuns(dir).filter((e) => e.projectId === projectId);

// ── (30) A FOREIGN group without a leader under an old pid is not the one of the entry ────────────────────────────
test("(30) a foreign group with an ended leader under the pid of an old entry (without or with a foreign boot mark) — state \"not running\", entry gone, start free, the stop sends it no signal, nativeRuns does not name it", async () => {
  const { bootMarker, checkStartFree } = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-foreign-leaderless-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const identifier = sleepIdentifier();
  const memberFile = path.join(dir, "member.pid");
  // The daemon pattern of a FOREIGN process: own group, one member, the leader ends. The entry carries the same number — that is
  // how it looks after a restart of the Mac or a swap of B when an old entry is left over in service-runs.json.
  const leader = spawn("sh", ["-c", `sleep 100000.${identifier} & echo $! > '${memberFile}.tmp' && mv '${memberFile}.tmp' '${memberFile}'; exit 0`], { detached: true, stdio: "ignore" });
  const G = leader.pid;
  try {
    await new Promise((r) => leader.once("exit", r));
    await waitForTruthy(() => fs.existsSync(memberFile), "the pid of the member");
    const member = Number(fs.readFileSync(memberFile, "utf8"));
    assert.equal(processAlive(G), false, "the leader still lives — the test measures nothing");
    assert.equal(groupAlive(G), true, "the foreign group does not live — the test measures nothing");
    assert.ok(bootMarker(), "the boot mark is not readable — the test measures nothing");
    setServicesSeam({}); // without an instance
    // a: a legacy entry without a boot mark (written before the boot mark existed, start time of three days ago);
    // b: an entry with the boot mark of ANOTHER boot.
    const cases = [
      { name: "without boot mark", fields: { pidStart: "ps:Mon Sep 28 09:15:00 2026", startedAt: Date.now() - 3 * 86_400_000 } },
      { name: "foreign boot mark", fields: { pidStart: "proc:4711", bootMarker: `${bootMarker()}-before-the-restart` } },
    ];
    for (const marker of [MARKER_ON, MARKER_FROM]) {
      for (const fall of cases) {
        await withEnvironment(marker, async () => {
          const what = `${fall.name}, ${marker === MARKER_ON ? "with" : "without"} operation mark`;
          const create = () => { writeRuns(dir, [runsEntry(dir, "P9", 1, { pid: G, ...fall.fields })]); initServices({ dataDir: dir, logFile }); };
          create();
          assert.deepEqual(nativeRuns("P9"), [], `${what}: nativeRuns names the foreign group (relocation step 4 would send it TERM)`);
          assert.doesNotThrow(() => checkStartFree("P9", { id: 1, name: "foreign" }), `${what}: the start protection holds on a foreign group`);
          // The stop first (the state would otherwise remove the entry beforehand, and the stop would see none).
          const s = await stopService({ projectId: "P9", serviceId: 1 });
          assert.deepEqual(s.killed, [], `${what}: the stop sent the foreign group a signal: ${JSON.stringify(s)}`);
          assert.equal(processAlive(member), true, `${what}: the member of the foreign group no longer lives`);
          create();
          const snapshot = await serviceStatus("P9", 1);
          assert.deepEqual([snapshot.running, snapshot.holdsStart], [false, false], `${what}: state ${JSON.stringify(snapshot)}`);
          assert.deepEqual(entriesOf(dir, "P9"), [], `${what}: the entry of the foreign group stayed`);
        });
      }
    }
    assert.equal(groupAlive(G), true, "the foreign group got a signal");
  } finally {
    kill([G]);
    cleanSleepers(identifier);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (31) The relocation path knows the service with an ended leader ─────────────────────────────────────────────────────────
test("(31) a service started in B whose leader ends and whose member lives is in nativeRuns; \"empty RUNS\" leaves it, endNativeRuns ends the member", async () => {
  const { bootMarker } = await import("../electron/server/services.js");
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cbase-services-relocation-leaderless-"));
  const logFile = (p, s) => path.join(dir, "logs", `${p}_${s}.log`);
  const identifier = sleepIdentifier();
  const memberFile = path.join(dir, "member.pid");
  let run = null;
  try {
    setServicesSeam({}); // without an instance: the start in B
    await withEnvironment({ ...MARKER_ON, SHELL: "/bin/sh" }, async () => {
      initServices({ dataDir: dir, logFile });
      run = startSimple({ projectId: "P6", service: { id: 1, name: "leaderless", startCommand: `sleep 100000.${identifier} & echo $! > '${memberFile}.tmp' && mv '${memberFile}.tmp' '${memberFile}'; exit 0` }, cwd: dir });
      await waitForTruthy(() => fs.existsSync(memberFile), "the pid of the member");
      const member = Number(fs.readFileSync(memberFile, "utf8"));
      await waitForTruthy(() => !processAlive(run.pid), "the leader (the login shell) ends");
      assert.equal(groupAlive(run.pid), true, "the group does not live — the test measures nothing");
      assert.ok(run.pidStart && run.bootMarker && run.bootMarker === bootMarker(), `the start did not remember start time and boot mark: ${JSON.stringify(run)}`);
      // State and start protection say "running" — the relocation path must give the same answer.
      assert.equal((await serviceStatus("P6", 1)).running, true, "state: the service does not run");
      assert.deepEqual(nativeRuns("P6"), [{ serviceId: 1, pid: run.pid }], "nativeRuns overlooks the service with an ended leader (the tick would take the project for service-free, the process search the member for foreign)");
      // "Empty RUNS" (step 4) without this service in the list: it runs, its entry stays and is in `open`.
      const empty = await endNativeRuns("P6", []);
      assert.deepEqual([empty.ended, empty.open], [[], [1]], JSON.stringify(empty));
      assert.deepEqual(entriesOf(dir, "P6").map((e) => e.key), ["P6:1"], "\"empty RUNS\" deleted the entry of a living group");
      // Step 4 with the service: the member ends, the entry falls. The grace is the cap of the product, not a criterion.
      const r = await endNativeRuns("P6", [1], { graceMs: 10_000 });
      assert.deepEqual(r.ended, [1], JSON.stringify(r));
      await waitForTruthy(() => !processAlive(member), "the member ends");
      assert.deepEqual(entriesOf(dir, "P6"), [], "the entry stayed after step 4");
    });
  } finally {
    if (run?.pid) kill([run.pid]);
    cleanSleepers(identifier);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── (32) In projects/routes.js no „…-quote closes with the straight " ─────────────────────────────────────────────
// The lines without comments are read: whole comment lines (`//`, `*`, `/*`) fall, an appended ` // …` is cut off. Only this
// file: in the rest of the server there are about 200 such places, many in frozen prompt texts (pipeline-prompt*.snapshot.txt).
function currentlyClosings(source) {
  const hits = [];
  source.split("\n").forEach((row, i) => {
    const t = row.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const code = row.replace(/\s\/\/\s.*$/, "");
    for (const m of code.matchAll(/„[^“"\n]*"/g)) hits.push(`${i + 1}: ${m[0]}`);
  });
  return hits;
}
test("(32) no „…-quote outside comments in projects/routes.js closes with the straight \" — the messages close with “", () => {
  const file = new URL("../electron/server/projects/routes.js", import.meta.url);
  assert.deepEqual(currentlyClosings(fs.readFileSync(file, "utf8")), [], "a message closes a „…-quote with the straight \" (rule: closing is always “)");
  // The guard bites: a straight quote in code is a hit, in a comment it is not.
  assert.deepEqual(currentlyClosings('const a = T(`A skill „${n}" exists`);\n// „in a comment"\n  * „in a block"\nconst b = 1; // „appended"'), ['1: „${n}"']);
});
// ── Resources bundled ──────────────────────────────────────────────────────────────────────────────────────────────────
//  (33) ONE docker stats FOR ALL: /api/project-resources of a workspace measures the project containers and copies of ALL
//       projects in ONE `docker stats --no-stream …` (services.js instanceStatsAll). Before, every container had a call of its
//       own, one after the other (about 2 s per call, docker waits out two samples); the 4 s state per container was shorter than
//       the loop and so always cold. The rows stay as they were (`dockerUp`, `containers`, `cpu`, `memBytes`, `instances` with
//       the main one first). COUNTED, not timed — the fake docker answers at once. Counter-test: services.js with instanceStats
//       per container in the loop — 4 calls instead of 1, red.
//  (34) THE FALLBACK: if a project container is missing, the bundled call ends with exit 1 and WITHOUT a single line (the real
//       docker too: 12 names and an unknown one => rc=1, no output) — then every container is asked singly: the existing project
//       keeps `dockerUp: true` and its numbers, the missing one is `dockerUp: false, containers: 0`. Green at the old state (one
//       call per container) — a protection for the fallback. Sabotage: the branch "exit != 0 => singly" in instanceStatsAll
//       removed => the existing project `dockerUp: false`, red.
const statsCalls = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "stats");
const MIB64 = 64 * 1024 ** 2;

test("(33) resources of a workspace: ONE docker stats for all project containers and copies — the same rows as before", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const till = await project(ctx, fd, { name: "Till" });
        const lager = await project(ctx, fd, { name: "Stock" });
        const shop = await project(ctx, fd, { name: "Shop" });
        const k = copyAlongside(fd, lager);
        const prior = statsCalls(fd).length;
        const res = await json(`${ctx.base}/api/project-resources?workspaceId=${ctx.ws.id}&disk=0`);
        const fresh = statsCalls(fd).slice(prior);
        assert.equal(fresh.length, 1, `not ONE docker stats but ${fresh.length}: ${JSON.stringify(fresh.map((a) => a.args))}`);
        assert.ok(fresh[0].args.includes("--no-stream"), JSON.stringify(fresh[0].args));
        for (const c of [till.container, lager.container, k.container, shop.container]) {
          assert.ok(fresh[0].args.includes(c), `${c} is missing in docker stats: ${JSON.stringify(fresh[0].args)}`);
        }
        const row = (o) => res.resources.find((x) => x.projectId === o.p.id);
        for (const o of [till, shop]) {
          const z = row(o);
          assert.deepEqual([z.dockerUp, z.containers, z.cpu, z.memBytes, "instances" in z], [true, 1, 1.5, MIB64, false], JSON.stringify(z));
        }
        const zl = row(lager);
        assert.deepEqual([zl.dockerUp, zl.containers, zl.cpu, zl.memBytes], [true, 2, 3, 2 * MIB64], JSON.stringify(zl));
        assert.deepEqual((zl.instances || []).map((i) => [i.identifier, i.dockerUp, i.containers, i.cpu, i.memBytes]),
          [[`${lager.p.id}/main`, true, 1, 1.5, MIB64], [k.identifier, true, 1, 1.5, MIB64]], JSON.stringify(zl));
        assert.deepEqual(local.calls(), [], "the local docker was called");
      });
    });
  } finally {
    fd.cleanUp();
  }
});

test("(34) if a project container is missing, the rest is measured anyway — the bundled call fails without a line, every container is asked singly", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const existing = await project(ctx, fd, { name: "Till" });
        const gone = await project(ctx, fd, { name: "Stock" });
        execFileSync(fd.bin, ["rm", "-f", gone.container], { env: { ...process.env, ...fd.env } });
        const res = await json(`${ctx.base}/api/project-resources?workspaceId=${ctx.ws.id}&disk=0`);
        const row = (o) => res.resources.find((x) => x.projectId === o.p.id);
        assert.deepEqual([row(existing).dockerUp, row(existing).containers, row(existing).cpu, row(existing).memBytes], [true, 1, 1.5, MIB64], JSON.stringify(row(existing)));
        assert.deepEqual([row(gone).dockerUp, row(gone).containers], [false, 0], JSON.stringify(row(gone)));
        assert.deepEqual(local.calls(), [], "the local docker was called");
      });
    });
  } finally {
    fd.cleanUp();
  }
});
