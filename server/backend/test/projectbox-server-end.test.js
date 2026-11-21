// The stop chain at process end: runs/server-end.js endServer fires "serverEnd" and waits; projectbox/serverEnd.js writes the
// snapshot `desired` per instance and then stops all project containers with `docker stop -t 30` — only then does the server
// close and the process end.
//
// The server runs as its own PROCESS (withAgentsServer { childProcess: true }): the entry agent-server-child.mjs uses the same endServer
// on SIGTERM as server/backend/headless.js in the user container. The fake docker (fake-docker.mjs) holds every `stop` at a
// gate file — so the test sees that the process is still alive DURING the stop, and releases it instead of waiting out a duration.
//
// What holds here:
//   - Operation: one snapshot per instance with a container (name, service, project, state, exit code, depends_on of the
//     containers INSIDE the project container; the native services of the last snapshot travel along); then EXACTLY ONE
//     `stop -t 30` with the ids of both project containers and no foreign one; the process ends only after the gate, with 0.
//   - Without operation marks: immediate end (no gate is opened) and an empty call log.
//   - Cap: if the stop blocks, the process ends anyway — with the message that it was a cap. Forced through the knob
//     CBASE_SERVER_END_MS (clock seam); the other tests set it in the opposite direction (one hour).
//   - headless.js (in no glob of the gate, server/backend/) calls endServer after the start, not process.exit.
//   - If the snapshot hangs (a `docker exec` against a jammed inner dockerd), the stop still comes — the snapshot has its own
//     cap per call (knob CBASE_SNAPSHOT_MS, forced small in the test), and the last snapshot stays. Likewise for the SECOND
//     call (`ps` answers, `inspect` hangs).
//   - An open port tunnel (upgrade connection) no longer holds `server.close` — runs/server-end.js destroys the open upgrade
//     sockets before `close`, the close consumers run (a dynamic workflow ends "interrupted"), the closing cap does not
//     fire. The cap itself stays, forced on a server whose `close` never calls back.
//   - In operation every test names both caps of the chain explicitly — in the opposite direction (one hour) or small in the
//     test of the cap; the wrapper `withEnvironment` refuses a test without them. Otherwise under load the 5 s cap of the
//     snapshot would decide about "server end in operation".
//
// COUNTER-TESTS (each shown red):
//   agent-server-child.mjs: the old SIGTERM body (closeAllConnections, close, exit)   => "server end in operation …" red
//     ("the process ended before the project containers were stopped")
//   server.js: the registration "projectbox" at "serverEnd" removed                    => the same red, plus
//     tools/check/tree-rules.test.mjs (d) (dead kind)
//   server.js: `wait: true` removed                                                    => "server end in operation …" red
//   projectbox/serverEnd.js: the snapshot removed                                      => "server end in operation …" red (desired)
//   projectbox/serverEnd.js: `stop` without `-t 30`                                    => "server end in operation …" red
//   runs/server-end.js: without cap (only `await fireHooks`)                           => "cap …" hangs until the suite deadline
//     (no deadline of its own — the waiting line on stderr says what for)
//   headless.js at the HEAD state (git show HEAD:server/backend/headless.js)           => "headless.js …" red
//   runs/server-end.js: `await` on `server.close` without CLOSE_CAP_MS                 => "closing cap …" hangs until the suite
//     deadline (like the cap above)
//   runs/server-end.js at the state before the upgrade-socket fix (git show 2a627b5:…, without closeUpgradeSocket) => "open
//     upgrade connection …" red (status "running" instead of "interrupted", the closing cap fired); the same with the new leaf
//     but without the registration `trackUpgradeSocket(server)` in server.js
//   runs/server-end.js: `process.exit(0)` before `closeAllConnections` (the server is never closed)
//                                                                                      => "server end closes the server …" red
//     (without it this file and every kind suite stayed green — the `close` consumers agentsAtServerEnd/dynWorkflowsAtServerEnd
//     never ran, and nobody saw it)
//   projectbox/serverEnd.js: the snapshot without `{ capMs }`                          => "hanging snapshot …" red
//     (on the host only `exec`, no `ps`, no `stop` — the process ends through the server-end cap)
//   projectbox/serverEnd.js: ONLY the inspect without `{ capMs }`                      => "hanging inspect …" red (the default cap
//     of the seam reports 120000 instead of 3600000 ms; "hanging snapshot …" stays green — exactly the finding)
//   projectbox/serverEnd.js: the inspect with `{ capMs: 0 }`                           => "hanging inspect …" red, no hang: the
//     waiting fake ends through the ripcord of its gate (exit 9), the message names no cap
//   the state before the cap rule (BEFORE_PC_11): two tests in operation without CBASE_SNAPSHOT_MS => "in operation every test
//     names both caps …" counts them
//   The contract "no docker without operation" hangs on projectbox/docker.js (NO_OPS), not on the check in serverEnd.js:
//   removing that one keeps "without operation marks …" green — intended, the guard of the seam is projectbox-ops.test.js.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { desiredFromInspect } from "../electron/server/projectbox/serverEnd.js";
import { fakeDocker } from "./fake-docker.mjs";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";

const TESTDIR = path.dirname(new URL(import.meta.url).pathname);
const HEADLESS = path.resolve(TESTDIR, "..", "headless.js");
const TUNABLES = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_SERVER_END_MS", "CBASE_SNAPSHOT_MS"];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// The calls of withEnvironment in this file at the last state BEFORE the cap rule (17bb7a66, BEFORE_PC_11), word for word: two
// of them run in operation without CBASE_SNAPSHOT_MS.
const CALLS_BEFORE_PC_11 = [
  '    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000" }, () =>',
  '    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000" }, () =>',
  '    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "300" }, () =>',
  '    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000", CBASE_SNAPSHOT_MS: "200" }, () =>',
  '  await withEnvironment({ CBASE_SERVER_END_MS: "3600000" }, () =>',
  '    await withEnvironment({ CBASE_SERVER_END_MS: "3600000" }, () =>',
].join("\n");

// In operation (CBASE_DIND=1 — then the chain runs, snapshot included) a test sets BOTH product caps of the chain explicitly:
// in the opposite direction ("3600000") or, in the test of the cap, small. Forgetting would mean: under load the cap (5 s per
// snapshot call, 45 s for the server end) decides whether the test turns green.
const CAP_TUNABLE = ["CBASE_SERVER_END_MS", "CBASE_SNAPSHOT_MS"];
const missingCap = (values) => (values.CBASE_DIND === "1" ? CAP_TUNABLE.filter((k) => values[k] === undefined) : []);

// The environment of the server process: withAgentsServer({ kind }) starts it with the process.env of this test.
async function withEnvironment(values, fn) {
  const missing = missingCap(values);
  if (missing.length) {
    throw new Error(`withEnvironment: in operation ${missing.join(", ")} is missing — a test of the stop chain sets every cap explicitly ` +
      "(opposite direction \"3600000\", small only in the test of the cap), otherwise its result hangs on the clock");
  }
  const saved = Object.fromEntries(TUNABLES.map((k) => [k, process.env[k]]));
  try {
    for (const k of TUNABLES) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// An instance row straight into the database of the server process (the read access db() of the harness is readOnly) — there
// is no route that creates an instance.
function writeRow(dataRoot, { projectId, containerId = "", desired = null }) {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try {
    const t = Date.now();
    raw.prepare(`INSERT INTO project_instances (project_id, instance, container_id, state, desired, state_since, created_at, updated_at)
      VALUES (?, 'main', ?, 'ready', ?, ?, ?, ?)`).run(projectId, containerId, desired ? JSON.stringify(desired) : "", t, t, t);
  } finally { raw.close(); }
}

function desiredOf(db, projectId) {
  const d = db();
  try {
    const r = d.prepare("SELECT desired FROM project_instances WHERE project_id = ? AND instance = 'main'").get(projectId);
    return r?.desired ? JSON.parse(r.desired) : null;
  } finally { d.close(); }
}

// Until the `stop` of the fake docker stands at the gate OR the process ends — without a deadline, and unlike fd.gateReached
// the waiting also ends if the stop never comes (otherwise a red state would hang instead of being red).
async function gateOrEnd(fd, alive) {
  const marker = path.join(fd.dir, "gates", "stop.waiting");
  for (;;) {
    if (fs.existsSync(marker)) return "gate";
    if (!alive()) return "end";
    await pause(15);
  }
}

// The end of the server process: exit 0 from endServer. ONE named exception: with CBASE_CONTAINER=1 warmupEmbeddings loads
// onnxruntime-node, and its static destructors abort `exit()` with "libc++abi: … mutex lock failed: Invalid argument"
// (SIGABRT) — AFTER process.exit(0), so after the whole chain. Counts only with exactly this line in the log of the server
// process; any other signal or an exit != 0 is red.
function serverLog(root) {
  return fs.readdirSync(root).filter((n) => /^server-\d+\.log$/.test(n)).map((n) => fs.readFileSync(path.join(root, n), "utf8")).join("\n");
}
function assertOrdered(end, root) {
  if (end.code === 0 && end.signal === null) return;
  assert.equal(end.signal, "SIGABRT", `no orderly end: ${JSON.stringify(end)}`);
  assert.match(serverLog(root), /libc\+\+abi: terminating due to uncaught exception of type std::__1::system_error: mutex lock failed/,
    `SIGABRT without the known destructor line of onnxruntime: ${JSON.stringify(end)}`);
}

const docker = (fd, ...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();

// Two project containers (label cbase.project) and a foreign inner container of the user container; in the first a
// compose stack with a running service and an exited one-shot container.
function seed(fd) {
  const p1 = docker(fd, "run", "-d", "--name", "cbase-p-p1", "--label", "cbase.project=p1", "cbase-projectbox:latest");
  const p2 = docker(fd, "run", "-d", "--name", "cbase-p-p2", "--label", "cbase.project=p2", "cbase-projectbox:latest");
  const foreign = docker(fd, "run", "-d", "--name", "audit-db", "postgres:16");
  docker(fd, "exec", "-u", "agent", "cbase-p-p1", "docker", "run", "-d", "--name", "geo-db-1",
    "--label", "com.docker.compose.service=db", "--label", "com.docker.compose.project=geo", "postgres:16");
  docker(fd, "exec", "-u", "agent", "cbase-p-p1", "docker", "run", "--name", "geo-migrate-1",
    "--label", "com.docker.compose.service=migrate", "--label", "com.docker.compose.project=geo",
    "--label", "com.docker.compose.depends_on=db:service_healthy:false", "geo-migrate");
  return { p1, p2, foreign };
}

test("desiredFromInspect: compose labels, state and exit code per container, ordered by name; native services travel along", () => {
  const inspect = [
    { Id: "b".repeat(64), Name: "/geo-migrate-1", State: { Status: "exited", ExitCode: 0 },
      Config: { Labels: { "com.docker.compose.service": "migrate", "com.docker.compose.project": "geo", "com.docker.compose.depends_on": "db:service_healthy:false,redis:service_started:false" } } },
    { Id: "a".repeat(64), Name: "/geo-db-1", State: { Status: "running", ExitCode: 0 }, Config: { Labels: { "com.docker.compose.service": "db", "com.docker.compose.project": "geo" } } },
    { Id: "c".repeat(64), Name: "/loose", State: { Status: "created" }, Config: {} },
  ];
  assert.deepEqual(desiredFromInspect(inspect, { time: 7, services: [{ name: "vite" }] }), {
    time: 7,
    container: [
      { name: "geo-db-1", id: "a".repeat(64), service: "db", project: "geo", state: "running", exitCode: 0, dependsOn: "" },
      { name: "geo-migrate-1", id: "b".repeat(64), service: "migrate", project: "geo", state: "exited", exitCode: 0, dependsOn: "db:service_healthy:false,redis:service_started:false" },
      { name: "loose", id: "c".repeat(64), service: "", project: "", state: "created", exitCode: null, dependsOn: "" },
    ],
    services: [{ name: "vite" }],
  });
  assert.deepEqual(desiredFromInspect(null, { time: 1 }), { time: 1, container: [], services: [] });
});

test("server end in operation: snapshot per instance, then ONE stop -t 30 with both project containers; the process ends only after the gate", async () => {
  const fd = await fakeDocker({ stopGate: "stop" });
  try {
    const { p1, p2, foreign } = seed(fd);
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000", CBASE_SNAPSHOT_MS: "3600000" }, () =>
      withAgentsServer(async ({ dataRoot, db, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1 });
        writeRow(dataRoot, { projectId: "p2", containerId: p2, desired: { time: 1, container: [], services: [{ name: "vite", port: 5173 }] } });
        writeRow(dataRoot, { projectId: "p3" }); // without a container: no snapshot, no stop
        const prior = fd.calls().length;

        const { ended, alive } = signal("SIGTERM");
        assert.equal(await gateOrEnd(fd, alive), "gate", "the process ended before the project containers were stopped");
        assert.ok(alive(), "the server process is alive during the stop");

        // The snapshot stands BEFORE the stop.
        const s1 = desiredOf(db, "p1");
        assert.ok(s1 && Number.isFinite(s1.time), `p1 has a snapshot: ${JSON.stringify(s1)}`);
        assert.deepEqual(s1.container.map(({ name, service, project, state, exitCode, dependsOn }) => ({ name, service, project, state, exitCode, dependsOn })), [
          { name: "geo-db-1", service: "db", project: "geo", state: "running", exitCode: 0, dependsOn: "" },
          { name: "geo-migrate-1", service: "migrate", project: "geo", state: "exited", exitCode: 0, dependsOn: "db:service_healthy:false" },
        ]);
        assert.deepEqual(s1.services, []);
        const s2 = desiredOf(db, "p2");
        assert.deepEqual(s2.container, [], "p2 has no inner containers");
        assert.deepEqual(s2.services, [{ name: "vite", port: 5173 }], "the native services of the last snapshot travel along");
        assert.ok(s2.time > 1, "p2 was written anew");
        assert.equal(desiredOf(db, "p3"), null, "no snapshot without a container");

        const host = fd.calls().slice(prior).filter((a) => a.daemon === "host").map((a) => a.args);
        const stops = host.filter((a) => a[0] === "stop");
        assert.equal(stops.length, 1, `exactly one stop: ${JSON.stringify(host)}`);
        const [stop] = stops;
        assert.deepEqual(stop.slice(0, 3), ["stop", "-t", "30"]);
        assert.deepEqual(stop.slice(3).sort(), [p1.slice(0, 12), p2.slice(0, 12)].sort(), "both project containers, no foreign one");
        assert.ok(!stop.includes(foreign.slice(0, 12)));
        assert.equal(host.indexOf(stop), host.length - 1, `the stop is the last call: ${JSON.stringify(host)}`);
        // The thaw (`ps … status=paused`) runs ALONGSIDE the snapshot — the list of the stop is the other `ps`.
        // The same for the list of inherited labels (`ps -aq --no-trunc …`) — the list of the stop is `ps -q`.
        const stopList = (a) => a[0] === "ps" && a[1] === "-q" && !a.includes("status=paused");
        assert.ok(host.findIndex((a) => a[0] === "exec") < host.findIndex(stopList), "first the snapshot, then the list of the project containers");
        assert.deepEqual(host.find(stopList), ["ps", "-q", "--filter", "label=cbase.project"]);

        fd.openGate("stop");
        assertOrdered(await ended, root);
        const z = fd.state();
        assert.equal(z.container[p1].status, "exited");
        assert.equal(z.container[p2].status, "exited");
        assert.equal(z.container[foreign].status, "running", "a foreign inner container stays as it is");
      }, { childProcess: true }));
  } finally {
    fd.openGate("stop");
    fd.cleanUp();
  }
});

// A user container from an image with `LABEL cbase.project=p1` inherits the label — it is no project container and keeps
// running after the server end; the real project container next to it is stopped (counter-check). The same for the thaw: a
// paused one with an inherited label stays paused, the own one is thawed.
// COUNTER-TESTS: serverEnd.js without the filter (`.filter((id) => {…})` removed) => red ("the user container was stopped");
// docker.js thawAll without `onlyOwnProjectContainer` => red (thawed).
test("a container that only inherits cbase.project from its image is neither thawed nor stopped at server end — the real one is", async () => {
  const IMAGE = "e".repeat(64);
  const fd = await fakeDocker({ stopGate: "stop", images: { "user-app:1": { id: IMAGE, labels: { "cbase.project": "p1" } } } });
  try {
    const p1 = docker(fd, "run", "-d", "--name", "cbase-p-p1", "--label", "cbase.project=p1", "cbase-projectbox:latest");
    const p2 = docker(fd, "run", "-d", "--name", "cbase-p-p2", "--label", "cbase.project=p2", "cbase-projectbox:latest");
    const user = docker(fd, "run", "-d", "--name", "user-app", "user-app:1");
    const user2 = docker(fd, "run", "-d", "--name", "user-app-2", "user-app:1");
    assert.equal(JSON.parse(docker(fd, "inspect", user))[0].Config.Labels["cbase.project"], "p1", "the fake docker does not inherit the label");
    docker(fd, "pause", p2);
    docker(fd, "pause", user2);
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000", CBASE_SNAPSHOT_MS: "3600000" }, () =>
      withAgentsServer(async ({ dataRoot, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1 });
        const prior = fd.calls().length;
        const { ended, alive } = signal("SIGTERM");
        assert.equal(await gateOrEnd(fd, alive), "gate", "the process ended before the stop");
        const host = fd.calls().slice(prior).filter((a) => a.daemon === "host").map((a) => a.args);
        const stop = host.find((a) => a[0] === "stop");
        assert.deepEqual(stop.slice(3).sort(), [p1.slice(0, 12), p2.slice(0, 12)].sort(), `the user container is in the stop: ${JSON.stringify(stop)}`);
        const unpause = host.filter((a) => a[0] === "unpause");
        assert.deepEqual(unpause.map((a) => a.slice(1)), [[p2]], `thawed: ${JSON.stringify(unpause)}`);
        fd.openGate("stop");
        assertOrdered(await ended, root);
      }, { childProcess: true }));
    const z = fd.state();
    assert.equal(z.container[user].status, "running", "the user container was stopped");
    assert.equal(Boolean(z.container[user2].paused), true, "the paused user container was thawed");
    assert.equal(z.container[p1].status, "exited", "counter-check: the project container kept running");
  } finally {
    fd.openGate("stop");
    fd.cleanUp();
  }
});

test("without operation marks: immediate end and an empty call log", async () => {
  const fd = await fakeDocker({ stopGate: "stop" });
  try {
    const { p1 } = seed(fd);
    const prior = fd.calls().length;
    // CBASE_CONTAINER alone (the local server has neither mark; a B without sysbox only this one).
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000" }, () =>
      withAgentsServer(async ({ dataRoot, db, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1 });
        const { ended } = signal("SIGTERM");
        assertOrdered(await ended, root); // ends without a gate having been opened
        assert.deepEqual(fd.calls().slice(prior), [], "no docker call");
        assert.equal(desiredOf(db, "p1"), null, "no snapshot");
        assert.equal(fd.state().container[p1].status, "running");
      }, { childProcess: true }));
  } finally {
    fd.openGate("stop");
    fd.cleanUp();
  }
});

test("cap: a stop that never ends does not hold the process end — with a message", async () => {
  const fd = await fakeDocker({ stopGate: "stop" });
  try {
    const { p1 } = seed(fd);
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "300", CBASE_SNAPSHOT_MS: "3600000" }, () =>
      withAgentsServer(async ({ dataRoot, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1 });
        const { ended, alive } = signal("SIGTERM");
        const reached = await gateOrEnd(fd, alive);
        assertOrdered(await ended, root); // the process ends despite the closed gate
        assert.match(serverLog(root), /\[server-end\] cap of 300 ms hit — the subscribers of "serverEnd" are still running, the server ends anyway/);
        // Cleanup of the fake docker: the held `stop` runs to its end after the gate (otherwise it would write into a deleted
        // folder). If it was not yet at the gate (under load), the open gate releases it at once later.
        fd.openGate("stop");
        if (reached === "gate") while (fd.state().container[p1]?.status !== "exited") await pause(15);
      }, { childProcess: true }));
  } finally {
    fd.openGate("stop");
    fd.cleanUp();
  }
});

test("hanging snapshot: an exec that never answers does not hold the stop — the last snapshot counts", async () => {
  const fd = await fakeDocker({ stopGate: "stop", execGate: "exec" });
  try {
    fd.openGate("exec"); // the seeding itself goes through `exec` on the host
    const { p1, p2 } = seed(fd);
    fd.closeGate("exec");
    const old = { time: 1, container: [{ name: "geo-db-1" }], services: [] };
    // The server-end cap stands in the OPPOSITE direction (one hour): the stop must come from the snapshot cap.
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000", CBASE_SNAPSHOT_MS: "200" }, () =>
      withAgentsServer(async ({ dataRoot, db, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1, desired: old });
        const prior = fd.calls().length;
        const { ended, alive } = signal("SIGTERM");
        assert.equal(await gateOrEnd(fd, alive), "gate", "no stop: the hanging snapshot held the chain");
        const host = fd.calls().slice(prior).filter((a) => a.daemon === "host").map((a) => a.args);
        // That the snapshot was attempted is proven by its log line below ("docker exec: cap of 200 ms reached"). The fake docker's
        // own call record is no proof: on a slow machine (the CI runner) the 200-ms cap kills the exec before the fake has started
        // far enough to record it.
        const [stop] = host.filter((a) => a[0] === "stop");
        assert.deepEqual(stop.slice(0, 3), ["stop", "-t", "30"]);
        assert.deepEqual(stop.slice(3).sort(), [p1.slice(0, 12), p2.slice(0, 12)].sort());
        assert.deepEqual(desiredOf(db, "p1"), old, "the last snapshot stays");
        fd.openGate("stop");
        assertOrdered(await ended, root);
        assert.match(serverLog(root), /\[server-end\] snapshot .* not written, the last one counts \(docker exec: cap of 200 ms reached/);
      }, { childProcess: true }));
  } finally {
    fd.openGate("stop");
    fd.openGate("exec");
    fd.cleanUp();
  }
});

// The guard of the snapshot cap held the cap only at the FIRST call (`ps`) — the second (`inspect`) was unbound, although
// deadlines.test.mjs counts with "2 x snapshot". Here `ps` answers in the project container, and only `exec … docker inspect`
// hangs at the gate (fake-docker `inspectGate`).
// The cap stands in the OPPOSITE direction (one hour) and is forced through the clock seam (SIGWINCH -> docker.js advanceCap)
// as soon as `inspect` stands at the gate — a small cap would hit both calls: the finished `ps` alone (two node starts of the
// fake docker) already tore the 200 ms, and `inspect` never came up.
// The message carries the value of the cap: 3600000 means "the cap of the snapshot", 120000 would mean "the default cap of the
// seam" (inspect without `{ capMs }`). Without any cap (`capMs: 0`) the waiting fake ends through its ripcord (exit 9) —
// red, no hang.
test("hanging inspect: `ps` answers but `inspect` hangs, the stop still comes — the last snapshot counts", async () => {
  const fd = await fakeDocker({ stopGate: "stop", inspectGate: "inspect" });
  try {
    const { p1, p2 } = seed(fd); // the seeding goes through `exec … docker run` — the gate holds only `inspect`
    const old = { time: 1, container: [{ name: "geo-db-1" }], services: [] };
    await withEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVER_END_MS: "3600000", CBASE_SNAPSHOT_MS: "3600000" }, () =>
      withAgentsServer(async ({ dataRoot, db, root, signal }) => {
        writeRow(dataRoot, { projectId: "p1", containerId: p1, desired: old });
        const prior = fd.calls().length;
        const insidePrior = fd.calls({ daemon: "cbase-p-p1" }).length;
        const { ended, alive } = signal("SIGTERM");
        // `ps` ran INSIDE the project container and answered; `inspect` stands at the gate and never gets past it.
        const marker = path.join(fd.dir, "gates", "inspect.waiting");
        for (;;) { if (fs.existsSync(marker) || !alive()) break; await pause(15); }
        assert.ok(fs.existsSync(marker), "the inspect was not attempted — then the test checks nothing");
        assert.deepEqual(fd.calls({ daemon: "cbase-p-p1" }).slice(insidePrior).map((a) => a.args), [["ps", "-aq"]]);
        signal("SIGWINCH"); // advance the clock to the cap
        assert.equal(await gateOrEnd(fd, alive), "gate", "no stop: the hanging inspect held the chain");
        const host = fd.calls().slice(prior).filter((a) => a.daemon === "host").map((a) => a.args);
        assert.ok(host.some((a) => a[0] === "exec" && a.includes("inspect")), JSON.stringify(host));
        const [stop] = host.filter((a) => a[0] === "stop");
        assert.deepEqual(stop.slice(0, 3), ["stop", "-t", "30"]);
        assert.deepEqual(stop.slice(3).sort(), [p1.slice(0, 12), p2.slice(0, 12)].sort());
        assert.deepEqual(desiredOf(db, "p1"), old, "the last snapshot stays");
        fd.openGate("stop");
        assertOrdered(await ended, root);
        assert.match(serverLog(root), /\[server-end\] snapshot .* not written, the last one counts \(docker exec: cap of 3600000 ms reached/);
      }, { childProcess: true }));
  } finally {
    fd.openGate("stop");
    fd.openGate("inspect");
    fd.cleanUp();
  }
});

// The wrapper refuses a test in operation without both caps. Counter-test: the same rule over the calls of the file at the
// state before the rule finds exactly the two tests whose result hung on the 5 s cap of the snapshot.
test("in operation every test names both caps of the chain — without them withEnvironment refuses; the state before the rule had two tests without", async () => {
  let ran = false;
  for (const [without, values] of [
    ["CBASE_SNAPSHOT_MS", { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_SERVER_END_MS: "3600000" }],
    ["CBASE_SERVER_END_MS", { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_SNAPSHOT_MS: "3600000" }],
  ]) {
    await assert.rejects(withEnvironment(values, () => { ran = true; }), new RegExp(`in operation ${without} is missing`));
  }
  assert.equal(ran, false, "the test ran despite a missing cap");
  await withEnvironment({ CBASE_CONTAINER: "1" }, () => { ran = true; }); // without operation no chain, no duty
  assert.equal(ran, true);

  const inOpsWithout = [...CALLS_BEFORE_PC_11.matchAll(/withEnvironment\(\{([^}]*)\}/g)].map((m) => m[1])
    .filter((a) => /CBASE_DIND: "1"/.test(a) && !CAP_TUNABLE.every((k) => a.includes(`${k}:`)));
  assert.equal(inOpsWithout.length, 2, `at the state before the rule: ${JSON.stringify(inOpsWithout)}`);
});

test("headless.js: after the start a signal ends through endServer, not through process.exit (server/backend is in no glob)", () => {
  const text = fs.readFileSync(HEADLESS, "utf8");
  assert.match(text, /import \{[^}]*\bendServer\b[^}]*\} from "\.\/electron\/server\/server\.js"/);
  assert.match(text, /process\.on\(sig, \(\) => \(server \? endServer\(server\) : process\.exit\(0\)\)\)/);
  assert.match(text, /\nserver = await startServer\(/, "the server is remembered, otherwise `server` would stay null and every signal would end at once");
  assert.doesNotMatch(text, /process\.on\(sig, \(\) => process\.exit\(0\)\)/, "the old body ends at once");
});

// PORT=7718 from the Dockerfile applies only to the backend itself; inherited, it would land in every terminal, every agent
// shell and every native service in B (Next.js & co. read PORT). Counter-test: the state before (7918507e) reads PORT and
// leaves it standing.
// headless.js before PORT was dropped (reduced from 7918507e): it reads PORT and leaves it in the environment of every child.
const HEADLESS_BEFORE_PE_37 = [
  'import { endServer, startServer } from "./electron/server/server.js";',
  "const PORT = Number(process.env.PORT || 7718);",
  "let server = null;",
  'for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (server ? endServer(server) : process.exit(0)));',
  "server = await startServer({ port: PORT, dataRoot: DATA_ROOT, webDir: WEB_DIR, pickDirectory: null, notify: null });",
  "",
].join("\n");
function portDefects(text) {
  const read = text.search(/\nconst PORT = Number\(process\.env\.PORT \|\| 7718\);/);
  const way = text.search(/\ndelete process\.env\.PORT;/);
  const start = text.search(/\nserver = await startServer\(/);
  const m = [];
  if (read < 0) m.push("PORT is no longer read");
  if (way < 0) m.push("PORT stays in the environment");
  else if (way < read || way > start) m.push("PORT is not dropped between reading and start");
  return m;
}
test("headless.js: PORT is deleted from the environment after reading, no child inherits 7718", () => {
  assert.deepEqual(portDefects(fs.readFileSync(HEADLESS, "utf8")), []);
  assert.deepEqual(portDefects(HEADLESS_BEFORE_PE_37),["PORT stays in the environment"], "counter-check: the old state must be red");
});

// The intended side effect: `endServer` CLOSES the server, and the server-end consumers hang on `close` (server.js:
// agentsAtServerEnd, dynWorkflowsAtServerEnd, the tickers). Their trace in the database: a running dynamic workflow ends
// "interrupted" with "Server beendet" — without the `close` it would stay "running" (the next start would clean it up, but as
// a crash, and its agents would die with the process instead of in order). Without operation marks the hook does nothing;
// only the closing path is checked.
// The main agent calls cbase_dynamic_workflow with "WF[<tag>]:{json}" (like dynworkflows-run.test.js, shortened); the
// workflow agent holds at its gate {GATE:<tag>}.
const WF_CLAUDE = fakeClaude({
  main: `
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for the existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "b-" + Date.now(), content: [{ type: "text", text: "ok" }] } });
  finished();
  say({ type: "result", result: "ok", session_id: "main-session" });`,
  sub: `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    say({ type: "assistant", message: { id: "s1", content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    finished();
    say({ type: "result", result: "Finding", session_id: "sub-x" });`,
});

test("server end closes the server: a running dynamic workflow ends in order (interrupted, \"Server beendet\"), not silently with the process", async () => {
  await withEnvironment({ CBASE_SERVER_END_MS: "3600000" }, () =>
    withAgentsServer(async ({ base, chat, root, db, signal, gate }) => {
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      const script = "export const meta = { name: 'server-end', description: 'Tracer', phases: [{ title: 'Waiting' }] }\nreturn await agent('Wait {GATE:e}');\n";
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `WF[e]:${JSON.stringify({ script })}` }) });
      const file = path.join(root, "wf-e");
      await waitForTruthy(() => fs.existsSync(file), "tool result");
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(r.status, "started", JSON.stringify(r));
      await gate.reached("e");
      const row = () => { const d = db(); try { return d.prepare("SELECT status, error FROM dyn_workflow_runs WHERE id = ?").get(r.runId); } finally { d.close(); } };
      assert.equal(row().status, "running");

      const { ended } = signal("SIGTERM");
      assertOrdered(await ended, root);
      const z = row();
      assert.equal(z.status, "interrupted", "the server was not closed — dynWorkflowsAtServerEnd never ran");
      assert.match(z.error, /Server beendet/);
    }, { claude: WF_CLAUDE, childProcess: true }));
});

// An upgrade connection (here the port tunnel /api/tunnel, WebSocket <-> TCP) is not counted by `closeAllConnections`, and
// `server.close` waited for it — `close` never fired, the server-end consumers (agentsAtServerEnd, dynWorkflowsAtServerEnd)
// did not run, and the process ended through the 5 s cap like after a crash. Now runs/server-end.js remembers every upgrade
// socket (`trackUpgradeSocket`, from server.js) and destroys the open ones before `close`. The proof is the trace of the
// consumers in the database: a running dynamic workflow ends "interrupted" with "Server beendet" — with an OPEN tunnel. The
// test itself keeps it open: a TCP service the tunnel passes through to, and a raw WebSocket handshake.
test("an open upgrade connection (port tunnel) does not hold the closing path — the close consumers run, no cap", async () => {
  const target = net.createServer((s) => s.on("error", () => {}));
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  let sock = null;
  try {
    await withEnvironment({ CBASE_SERVER_END_MS: "3600000" }, () =>
      withAgentsServer(async ({ base, port, chat, root, db, signal, gate }) => {
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
        const script = "export const meta = { name: 'tunnel-end', description: 'Tracer', phases: [{ title: 'Waiting' }] }\nreturn await agent('Wait {GATE:t}');\n";
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `WF[t]:${JSON.stringify({ script })}` }) });
        const file = path.join(root, "wf-t");
        await waitForTruthy(() => fs.existsSync(file), "tool result");
        const r = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(r.status, "started", JSON.stringify(r));
        await gate.reached("t");
        const row = () => { const d = db(); try { return d.prepare("SELECT status, error FROM dyn_workflow_runs WHERE id = ?").get(r.runId); } finally { d.close(); } };
        assert.equal(row().status, "running");

        sock = net.connect(port, "127.0.0.1");
        sock.on("error", () => {});
        const to = new Promise((resolve) => sock.once("close", resolve));
        const response = new Promise((resolve) => { let b = ""; sock.on("data", (d) => { b += d; if (b.includes("\r\n\r\n")) resolve(b); }); });
        sock.write(`GET /api/tunnel?port=${target.address().port} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
        assert.match(await response, /^HTTP\/1\.1 101 /, "the tunnel stands");

        const { ended } = signal("SIGTERM");
        assertOrdered(await ended, root);
        await to;
        const z = row();
        assert.equal(z.status, "interrupted", "the open tunnel held `server.close` — dynWorkflowsAtServerEnd never ran");
        assert.match(z.error, /Server beendet/);
        assert.doesNotMatch(serverLog(root), /server\.close is still waiting for open connections/, "the closing cap fired — the tunnel was not destroyed");
      }, { claude: WF_CLAUDE, childProcess: true }));
  } finally {
    sock?.destroy();
    await new Promise((r) => target.close(r));
  }
});

// The second cap (CLOSE_CAP_MS, 5 s) stays as a net for a path runs/server-end.js does not know (since the fix no upgrade
// socket holds it any more). Forced on a server whose `close` never calls back — in a process of its own, because endServer
// ends with process.exit. Waited for is the process end, not a duration; the message says it was a cap, the exit is 0.
test("closing cap: if `server.close` never calls back, the process still ends — with a message", async () => {
  const module = new URL("../electron/server/runs/server-end.js", import.meta.url).href;
  const code = `import { endServer, trackUpgradeSocket } from ${JSON.stringify(module)};\n` +
    "const server = { on() {}, closeAllConnections() {}, close() {} };\ntrackUpgradeSocket(server);\nendServer(server);\n";
  const env = { ...process.env, CBASE_SERVER_END_MS: "3600000" };
  delete env.NODE_TEST_CONTEXT;
  const subprocess = spawn(process.execPath, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  subprocess.stderr.on("data", (b) => { err += b; });
  const [exitCode, sig] = await once(subprocess, "exit");
  assert.deepEqual({ exitCode, sig }, { exitCode: 0, sig: null }, err);
  assert.match(err, /\[server-end\] cap of 5000 ms hit — server\.close is still waiting for open connections, the process ends anyway/);
});
