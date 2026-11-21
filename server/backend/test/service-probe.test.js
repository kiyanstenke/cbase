// Regression: a RUNNING service was reported as "not active" in the apps view.
//
// Observed on the GPU server: a frontend (port 3101, without a container entry) answered 127.0.0.1:3101 with HTTP 200 while
// GET /api/project-services in the same process returned `running:false`. Cause was a chain:
//   1. 23 of 26 services have a container entry. The 4-s cache in dockerNames() (now dockerContainer()) is filled only AFTER the
//      answer, so every one of these checks started its own `docker ps` in a Promise.all — 23 child processes at once.
//   2. That stalled the event loop for 481 ms, more than checkPort's 400-ms deadline. The deadline timer fired although the connect
//      was long through => "port closed".
// Services WITH a container first wait for `docker ps` and start their port check afterwards — so exactly the services without a
// container entry were hit.
//
// Also: the match via compose labels (below), `dir` on ONE line with `working_dir`, the superseded containers
// (`project_superseded`) and the rebuild marker of the monitor (at the very bottom, each with a counter-test).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPort, followUpCounter } from "../electron/server/ports.js";
import { PS_TEMPLATE, checkCommandSyntax, containerFromPs, forgetDockerStatus, initServices, labelsFromPs, matchContainers, probeStatus, sanitizeStartCommand, setRebuildMarker, stopService, tailLogAny } from "../electron/server/services.js";
import * as store from "../electron/server/store.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

const listen = () =>
  new Promise((resolve) => {
    // Without a host — just like `node server.js` of that frontend: binds the IPv6 wildcard and is reachable via 127.0.0.1 v4-mapped.
    const srv = net.createServer((s) => s.end());
    srv.listen(0, () => resolve({ srv, port: srv.address().port }));
  });

const close = (srv) => new Promise((resolve) => srv.close(resolve));

// Block the event loop hard (no await) — so the deadline timer becomes due while the connect event is still queued.
function stallEventLoop(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* busy */ }
}

test("checkPort reports an open port even if the event loop overruns the deadline", async () => {
  const { srv, port } = await listen();
  try {
    const pending = checkPort(port, 100); // deadline shorter than the following stall
    stallEventLoop(300);
    assert.equal(await pending, true, "an open port must not fail on the deadline timer");
  } finally {
    await close(srv);
  }
});

// A MECHANISM is checked, not a speed: a closed loopback port answers at once with ECONNREFUSED, so the first connect decides —
// checkPort's follow-up deadline (see ports.js) must not even occur. No upper bound on the duration is asserted (that would be a
// statement about the machine); ports.js COUNTS the follow-ups instead, and the test reads the number: zero.
const DEADLINE_MS = 20_000;      // the deadline that must NOT be waited for
test("checkPort still reports a closed port as closed — without waiting for the deadline", async (t) => {
  // A released port is free only until a neighbouring test (parallelism 10) binds it again. If checkPort reports it open, that was
  // this neighbour — then a fresh port, at most five times. What is still checked is the closed port and zero follow-ups.
  let to = null, prior = 0, port = 0, t0 = 0;
  for (let attempt = 0; attempt < 5 && to !== false; attempt += 1) {
    const l = await listen();
    port = l.port;
    await close(l.srv);
    prior = followUpCounter();
    t0 = Date.now();
    to = await checkPort(port, DEADLINE_MS);
    if (to !== false) t.diagnostic(`port ${port} taken again after release (neighbouring test) — new attempt`);
  }
  assert.equal(to, false, "five released ports in a row taken again");
  t.diagnostic(`closed port answered in ${Date.now() - t0} ms, follow-ups ${followUpCounter() - prior} (follow-up deadline from ${DEADLINE_MS})`);
  assert.equal(followUpCounter() - prior, 0, "the follow-up deadline occurred — an ECONNREFUSED is not silence");
});

test("probeStatus shares a running `docker ps` instead of starting one per service", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-fake-docker-"));
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(
    path.join(dir, "docker"),
    `#!/bin/sh\necho call >> ${calls}\nsleep 0.2\necho foreign-container\n`,
    { mode: 0o755 },
  );
  const pathBefore = process.env.PATH;
  process.env.PATH = `${dir}:${pathBefore}`;
  const { srv, port } = await listen();
  try {
    // 23 services with a container entry + the one without — as in the real table. None of the container names matches, so all
    // fall back to the port check.
    const services = Array.from({ length: 23 }, (_, i) => ({ port: null, container: `container-${i}` }));
    services.push({ port, container: "" });

    const results = await Promise.all(services.map((s) => probeStatus(s)));

    const invocations = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").length : 0;
    assert.equal(invocations, 1, `docker ps was started ${invocations}×, expected 1×`);
    assert.equal(results.at(-1), true, "the service without a container entry runs and must be reported so");
    assert.deepEqual(new Set(results.slice(0, 23)), new Set([false]));
  } finally {
    await close(srv);
    process.env.PATH = pathBefore;
    fs.rmSync(dir, { recursive: true, force: true });
    forgetDockerStatus(); // this fake's state must not reach a later test
  }
});

// ── matchContainers via compose labels ───────────────────────────────────────────────────────────────────────────────
//
// The promise: the service `db` of project A no longer hits `b-db-1` of project B, and its stop no longer halts B. A compose
// container belongs to a project if its label `com.docker.compose.project.working_dir` lies, after realpath, UNDER the project
// folder (with separator); without a label only the exact name hits. Counter-test against the old state: matchContainers as it
// stood in services.js at 7fcf1ff (BEFORE_S1_15; its body below, the name changed) hits exactly the foreign containers the new one leaves out.

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

// matchContainers at BEFORE_S1_15: the name or the compose pattern `<project>-<service>-<n>` of ANY project.
function matchContainersBeforeS115(names, container) {
  if (!names || !container) return [];
  const esc = container.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const composePattern = new RegExp(`[-_]${esc}[-_]\\d+$`);
  return names.filter((n) => n === container || composePattern.test(n));
}

// A tree with real folders (realpath!): ws/a with repo, ws/b, ws/orbit and ws/orbit-2 (prefix without separator), plus a symlink
// to ws/a — compose writes the path `up` ran under, realpath makes both equal.
function projectTree() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-s1-15-"));
  for (const d of ["ws/a/repo", "ws/b", "ws/orbit", "ws/orbit-2", "link"]) fs.mkdirSync(path.join(w, d), { recursive: true });
  fs.symlinkSync(path.join(w, "ws/a"), path.join(w, "link/a"));
  return w;
}
// One row of `docker ps -a --format '{{json .}}'` in the form of the real docker (labels as ONE string).
const psRow = (name, { labels = {}, state = "running" } = {}) => JSON.stringify({
  Command: "\"docker-entrypoint.sh\"", ID: "0123456789ab", Image: "postgres:16",
  Labels: Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(","), Names: name, State: state,
  Status: state === "running" ? "Up 2 hours" : "Exited (0) 1 hour ago",
});
const compose = (service, folder) => ({
  "com.docker.compose.project": path.basename(folder), "com.docker.compose.service": service,
  "com.docker.compose.project.working_dir": folder, "com.docker.compose.depends_on": "",
});

test("labelsFromPs: commas in values (depends_on, config_files) belong to the value before", () => {
  assert.deepEqual(labelsFromPs("a=1,com.docker.compose.depends_on=db:service_started:false,redis:service_healthy:true,com.docker.compose.config_files=/x/a.yml,/x/b.yml,z=9"), {
    a: "1",
    "com.docker.compose.depends_on": "db:service_started:false,redis:service_healthy:true",
    "com.docker.compose.config_files": "/x/a.yml,/x/b.yml",
    z: "9",
  });
  assert.deepEqual(labelsFromPs(""), {});
  assert.deepEqual(labelsFromPs("empty="), { empty: "" });
});

test("matchContainers: the service `db` of A no longer hits `b-db-1` — counter-test: the old regex hits it", () => {
  const w = projectTree();
  try {
    const A = path.join(w, "ws/a");
    const list = containerFromPs([
      psRow("a-db-1", { labels: compose("db", path.join(w, "ws/a/repo")) }),
      psRow("b-db-1", { labels: compose("db", path.join(w, "ws/b")) }),
      psRow("a-db-2", { labels: compose("db", path.join(w, "link/a")), state: "exited" }),
      psRow("orbit-2-db-1", { labels: compose("db", path.join(w, "ws/orbit-2")) }),
      psRow("geo-minio", { labels: compose("minio", path.join(w, "ws/a/repo")) }),
      psRow("my-redis"),
      psRow("foreign-db-1"), // compose-shaped name WITHOUT a label
      "not json",
    ].join("\n"));
    assert.equal(list.length, 7, "the row without JSON drops out, all others stay");
    const names = (container, filePath) => matchContainers(list, container, filePath).map((c) => c.name).sort();

    assert.deepEqual(names("db", A), ["a-db-1", "a-db-2"], "only the containers under the project folder (also via the symlink)");
    assert.deepEqual(names("db", path.join(w, "ws/b")), ["b-db-1"]);
    assert.deepEqual(names("db", path.join(w, "ws/orbit")), [], "ws/orbit-2 is NOT under ws/orbit (separator)");
    assert.deepEqual(names("minio", A), ["geo-minio"], "service name");
    assert.deepEqual(names("geo-minio", A), ["geo-minio"], "container_name");
    assert.deepEqual(names("geo-minio", path.join(w, "ws/b")), [], "container_name of a foreign project");
    assert.deepEqual(names("my-redis", A), ["my-redis"], "without a label: the exact name");
    assert.deepEqual(names("db", undefined), [], "without a project folder no compose container hits — unknown is not \"everywhere\"");
    assert.deepEqual(list.filter((c) => c.name === "a-db-2").map((c) => c.running), [false], "exited is not running");

    // Counter-test: the old match — names only. It hits the foreign `b-db-1`, `orbit-2-db-1` and the name without a label; with it
    // the first assertion above would be red.
    const oldHits = matchContainersBeforeS115(list.map((c) => c.name), "db").sort();
    for (const foreign of ["b-db-1", "orbit-2-db-1", "foreign-db-1"]) {
      assert.ok(oldHits.includes(foreign), `the old regex does not hit ${foreign} — the counter-test proves nothing`);
    }
    assert.notDeepEqual(oldHits, names("db", A));
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

// On the case-INsensitive APFS (Mac, local) ".../Project/Sub" and ".../pROJECT/sUB" are the same folder, but `fs.realpathSync` (JS)
// returns the spelling of the argument — the match compared character by character and missed the container. So `realpathSync.native`
// is used on BOTH sides (working_dir and project folder). What is right is decided by the file system under os.tmpdir():
// case-insensitive => both spellings hit; case-sensitive (Linux) => another spelling is another, non-existent folder and does not
// hit. Both branches are assertions, no skip, and the line below says which one ran. Counter-test (APFS): red with `fs.realpathSync`
// instead of `.native`.
test("matchContainers: another case spelling of the same folder hits on a case-insensitive file system — on both sides", () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-pd-11-"));
  try {
    fs.mkdirSync(path.join(w, "Project", "Sub"), { recursive: true });
    const real = path.join(w, "Project");
    const different = path.join(w, "pROJECT");
    const insensitive = fs.existsSync(different);
    console.log(`[service-probe] the file system under ${os.tmpdir()} is case-${insensitive ? "insensitive" : "sensitive"}`);
    const list = containerFromPs([
      psRow("wd-different", { labels: compose("db", path.join(different, "sUB")) }),
      psRow("wd-real", { labels: compose("cache", path.join(real, "Sub")) }),
    ].join("\n"));
    const names = (container, filePath) => matchContainers(list, container, filePath).map((c) => c.name);
    assert.deepEqual(names("db", real), insensitive ? ["wd-different"] : [], "working_dir in another spelling than the project folder");
    assert.deepEqual(names("cache", different), insensitive ? ["wd-real"] : [], "project folder in another spelling than working_dir");
    assert.deepEqual(names("cache", real), ["wd-real"], "the same spelling always hits");
    assert.deepEqual(names("db", path.join(w, "Project-2")), [], "another folder never hits");
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test("stop and log via the fake docker: `db` of A stops only a-db-1, B keeps running", async () => {
  const w = projectTree();
  const fd = await fakeDocker();
  const pathPrior = process.env.PATH;
  const seed = (...args) => execFileSync(fd.bin, args, { encoding: "utf8" }).trim();
  try {
    for (const [name, folder] of [["a-db-1", "ws/a/repo"], ["b-db-1", "ws/b"]]) {
      const labels = Object.entries(compose("db", path.join(w, folder))).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
      seed("run", "-d", "--name", name, ...labels, "postgres:16");
    }
    // services.js calls `docker` via the PATH (the local server and projects not yet moved).
    process.env.PATH = `${fd.dir}${path.delimiter}${pathPrior}`;
    forgetDockerStatus();
    const r = await stopService({ projectId: "A", serviceId: 1, container: "db", projectPath: path.join(w, "ws/a") });
    assert.deepEqual(r, { killed: ["a-db-1"], stopped: true });
    const stops = fd.calls().filter((a) => a.args[0] === "stop").map((a) => a.args.slice(1));
    assert.deepEqual(stops, [["a-db-1"]], "only the own container is stopped");
    const z = Object.values(fd.state().container);
    assert.equal(z.find((c) => c.name === "b-db-1").status, "running", "B keeps running");
    assert.equal(z.find((c) => c.name === "a-db-1").status, "exited");
    // The state comes with labels and ALL containers (`ps -a`), in one call per match.
    assert.ok(fd.calls().some((a) => a.args.join(" ") === `ps -a --format ${PS_TEMPLATE}`));
    // Never the template "everything" and never .Size: both make the docker CLI fetch the sizes too (size=1).
    assert.ok(!fd.calls().some((a) => a.args[0] === "ps" && /\{\{\s*json\s+\.\s*\}\}|\.Size/.test(a.args.join(" "))),
      "ps without {{json .}} and without .Size");
    // The log reads from the same state — only the own (also stopped) container. The file of the simple start is missing (empty
    // runtime folder), so tailLogAny asks docker.
    initServices({ dataDir: w, logFile: (p, s) => path.join(w, "logs", `${p}_${s}.log`) });
    forgetDockerStatus();
    await tailLogAny("A", 1, { container: "db", projectPath: path.join(w, "ws/a") });
    const logs = fd.calls().filter((a) => a.args[0] === "logs").map((a) => a.args.at(-1));
    assert.deepEqual(logs, ["a-db-1"], "docker logs only for A's container");
  } finally {
    process.env.PATH = pathPrior;
    forgetDockerStatus();
    fd.cleanUp();
    fs.rmSync(w, { recursive: true, force: true });
  }
});

// ── the stop at a port never hits the own process or any of its ancestors ───────────────────────────────────────────────
// In the B path stopService sent SIGTERM (SIGKILL after 1.5 s) to EVERY listener `lsof` named at the port — a service registered on
// 7718 ended the app itself with its stop. Three generations, each with a SIGTERM catcher that notes itself and removes itself from
// the listener list (so no SIGKILL arrives even with the old code): the test process (grandparent — reachable only via the `ps`
// chain), a parent process and the stopper itself, which calls stopService. Plus a foreign listener that MUST fall. `lsof` is a stub
// on the PATH that prints the list (the same on every machine). Counter-test: the old services.js => red (all three generations
// got SIGTERM).
const SERVICES_URL = new URL("../electron/server/services.js", import.meta.url).href;

test("stop at the port in B: the own process, its parent and its grandparent get no signal, a foreign listener does", async () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-n25-"));
  const list = path.join(w, "listener.txt");
  const bin = path.join(w, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh\ncat '${list}'\n`, { mode: 0o755 });
  // A generation removes itself from the list on SIGTERM and notes the hit.
  const drop = `const fs = require("node:fs");
    const drop = (who) => { fs.writeFileSync(${JSON.stringify(w)} + "/hit-" + who, "1");
      const f = ${JSON.stringify(list)}; fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("\\n").filter((z) => z && Number(z) !== process.pid).join("\\n") + "\\n"); };`;
  fs.writeFileSync(path.join(w, "stopper.cjs"), `${drop}
    process.on("SIGTERM", () => drop("stopper"));
    fs.appendFileSync(${JSON.stringify(list)}, process.pid + "\\n");
    import(${JSON.stringify(SERVICES_URL)}).then(async ({ initServices, stopService }) => {
      initServices({ dataDir: ${JSON.stringify(w)}, logFile: (p, s) => ${JSON.stringify(w)} + "/" + p + "_" + s + ".log" });
      const r = await stopService({ projectId: "n25", serviceId: 1, port: Number(process.argv[2]) });
      fs.writeFileSync(${JSON.stringify(path.join(w, "result.json"))}, JSON.stringify(r));
      process.exit(0); // no module timer keeps the stopper open
    });`);
  fs.writeFileSync(path.join(w, "parent.cjs"), `${drop}
    process.on("SIGTERM", () => drop("parent"));
    fs.appendFileSync(${JSON.stringify(list)}, process.pid + "\\n");
    const k = require("node:child_process").spawn(process.execPath, [${JSON.stringify(path.join(w, "stopper.cjs"))}, process.argv[2]], { stdio: "inherit" });
    k.on("exit", (code, signal) => { fs.writeFileSync(${JSON.stringify(path.join(w, "stopper-end.json"))}, JSON.stringify({ code, signal })); process.exit(0); });`);
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", detached: true });
  const foreignEnd = new Promise((r) => foreign.once("exit", (code, signal) => r({ code, signal })));
  const itself = () => {
    fs.writeFileSync(path.join(w, "hit-test"), "1");
    fs.writeFileSync(list, fs.readFileSync(list, "utf8").split("\n").filter((z) => z && Number(z) !== process.pid).join("\n") + "\n");
  };
  process.on("SIGTERM", itself);
  try {
    fs.writeFileSync(list, `${process.pid}\n${foreign.pid}\n`);
    // A port nobody listens at: the follow-up check (checkPort) then says "stopped".
    const port = await new Promise((r) => { const srv = net.createServer().listen(0, "127.0.0.1", () => { const n = srv.address().port; srv.close(() => r(n)); }); });
    const parent = spawn(process.execPath, [path.join(w, "parent.cjs"), String(port)], { stdio: "inherit", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    await new Promise((r) => parent.once("exit", r));
    const hit = ["test", "parent", "stopper"].filter((who) => fs.existsSync(path.join(w, `hit-${who}`)));
    assert.deepEqual(hit, [], "SIGTERM to the own process or an ancestor");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w, "stopper-end.json"), "utf8")), { code: 0, signal: null });
    const r = JSON.parse(fs.readFileSync(path.join(w, "result.json"), "utf8"));
    assert.deepEqual(r, { killed: [foreign.pid], stopped: true }, "the foreign listener falls");
    assert.equal((await foreignEnd).signal, "SIGTERM");
  } finally {
    process.off("SIGTERM", itself);
    try { process.kill(foreign.pid, "SIGKILL"); } catch { /* gone */ }
    fs.rmSync(w, { recursive: true, force: true });
  }
});

// ── a failed syntax check is not a syntax error ─────────────────────────────────────────────────────────────────────────
// `spawnSync` does not throw if the check itself fails — it returns `r.error` (ETIMEDOUT under load, EAGAIN, E2BIG). Its message
// used to stand there as a "syntax error": the scan emptied valid start commands (sanitizeStartCommand), PATCH and POST answered
// 400. E2BIG is the way that can be produced without a clock: a valid command above ARG_MAX (macOS 1 MiB, Linux 128 KiB per
// argument). Counter-test: the old services.js => red ("spawnSync /bin/bash E2BIG", dropped).
test("checkCommandSyntax: if the check itself fails (E2BIG) that is no syntax error — a real one stays one", () => {
  const large = `echo ${"a".repeat(3_000_000)}`;
  assert.equal(checkCommandSyntax(large), null, "unknown is not wrong");
  const s = sanitizeStartCommand(large);
  assert.deepEqual([s.cmd.length, s.dropped], [large.length, false], "the scan does not empty the valid command");
  // What bash objects to stays objected to — and the repair of the prose suffixes stays.
  assert.match(String(checkCommandSyntax("echo (")), /syntax error/i);
  assert.deepEqual(sanitizeStartCommand("npm run dev (frontend/)"), { cmd: "npm run dev", dropped: false });
  assert.deepEqual(sanitizeStartCommand("echo ((("), { cmd: "", dropped: true });
  // A NUL byte runs no shell (spawn throws at the argument): an answer, not an unknown verdict.
  assert.match(String(checkCommandSyntax("echo a\0b")), /NUL/);
});

// ── the wiring through the real server ──────────────────────────────────────────────────────────────────────────────────
//
// The tests above call matchContainers/stopService/tailLogAny DIRECTLY, with `projectPath` as an argument. In the server the project
// folder gets there in TWO ways: server.js `initServices({ projectPath })` (the setter through which services.js fetches the folder
// from the project id) and the routes in projects/routes.js, which pass only the project id (status, stop, log, apps list) — the
// monitor (listMonitoredServices) too. Without the setter every compose service would stand as "not running" (without a folder
// matchContainers hits no compose container), a stop would fall back to the port path and stop nothing, and the log would stay empty.
//
// Main seam: withAgentsServer (real server, real routes) with the fake docker on the PATH (services.js calls `docker` via the PATH —
// the path of the local server and of projects not yet moved), two projects with a service `db`, one compose container each,
// `a-db-1`/`b-db-1`. Route, stop, log and a monitor pass hit only `a-db-1`. Counter-test: server.js without `projectPath: …` at
// initServices => red (A's service "not running" although a-db-1 runs).
test("main seam: status routes, stop, log and a monitor pass hit only a-db-1 — the project folder arrives via server.js", async () => {
  const fd = await fakeDocker();
  const pathPrior = process.env.PATH;
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      process.env.PATH = `${fd.dir}${path.delimiter}${pathPrior}`;
      forgetDockerStatus();
      const project = async (name, folder) => {
        const filePath = path.join(ctx.root, "workspace", folder);
        fs.mkdirSync(filePath, { recursive: true });
        const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
        const svc = store.addProjectService(p.id, { name: "db", container: "db" });
        const labels = Object.entries(compose("db", filePath)).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
        execFileSync(fd.bin, ["run", "-d", "--name", `${folder}-db-1`, ...labels, "postgres:16"], { encoding: "utf8" });
        return { p, svc };
      };
      const A = await project("A", "a");
      const B = await project("B", "b");
      const status = async (x) => (await json(`${base}/api/projects/${x.p.id}/services`)).services.find((s) => s.id === x.svc.id).status.running;
      const apps = async () => Object.fromEntries((await json(`${base}/api/project-services`)).map((s) => [s.projectId, s.running]));

      // Status: both run — found via the folder of the OWN project (without the setter: both "not running").
      assert.equal(await status(A), true, "the service db of A is not running — did the project folder not arrive (initServices projectPath)?");
      assert.equal(await status(B), true);
      assert.deepEqual(await apps(), { [A.p.id]: true, [B.p.id]: true }, "apps list (/api/project-services)");

      // Monitor: the first pass remembers the state (both up), afterwards every change counts.
      await json(`${base}/api/services/check`, { method: "POST" });
      const { seq } = await json(`${base}/api/services/events`);

      // Stop: only a-db-1.
      const r = await json(`${base}/api/projects/${A.p.id}/services/${A.svc.id}/stop`, { method: "POST" });
      assert.deepEqual(r, { killed: ["a-db-1"], stopped: true });
      assert.deepEqual(fd.calls().filter((a) => a.args[0] === "stop").map((a) => a.args.slice(1)), [["a-db-1"]], "only A's container");
      const z = Object.values(fd.state().container);
      assert.equal(z.find((c) => c.name === "b-db-1").status, "running", "B keeps running");
      assert.equal(await status(A), false);
      assert.equal(await status(B), true);

      // Log: docker logs only for a-db-1 (also stopped).
      await json(`${base}/api/projects/${A.p.id}/services/${A.svc.id}/log`);
      assert.deepEqual(fd.calls().filter((a) => a.args[0] === "logs").map((a) => a.args.at(-1)), ["a-db-1"], "docker logs only for A's container");

      // Two passes (the monitor reports an outage only after two failed probes): exactly ONE "down", for A.
      await json(`${base}/api/services/check`, { method: "POST" });
      await json(`${base}/api/services/check`, { method: "POST" });
      const ev = (await json(`${base}/api/services/events?since=${seq}`)).events;
      assert.deepEqual(ev.map((e) => [e.kind, e.projectId]), [["down", A.p.id]], JSON.stringify(ev));
    });
  } finally {
    process.env.PATH = pathPrior;
    forgetDockerStatus();
    fd.cleanUp();
  }
});

// ── `dir` on one line, superseded containers, rebuild marker ────────────────────────────────────────────────────────────
//
// The promise: a compose container hits a service only if its `working_dir` and `<root>/<dir>` lie on ONE line — equal, ancestor
// (the compose file one level above the service folder) or descendant, in whole path parts. A sibling (`…/services/y`) and a prefix
// without separator (`…/services/xy`) no longer hit; a stack at the root lies on every line. Without `dir` (empty, absolute, `..`)
// the earlier rule applies. A superseded container never hits. Counter-test: matchContainers as it stood in services.js at 94e3daba
// (BEFORE_AN_19; its body below) hits the siblings and the superseded one.
function matchBeforeAn19() {
  const LABEL_FOLDER = "com.docker.compose.project.working_dir";
  const realPath = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  return function matchContainers(list, container, projectPath) {
    if (!Array.isArray(list) || !container) return [];
    const root = projectPath ? realPath(projectPath) : "";
    const underRoot = (folder) => !!root && (folder === root || folder.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
    return list.filter((c) => {
      if (c.labels?.[LABEL_FOLDER]) return underRoot(c.folder) && (c.service === container || c.name === container);
      return c.name === container;
    });
  };
}
const withId = (row, id) => JSON.stringify({ ...JSON.parse(row), ID: id });

test("matchContainers: `dir` on one line with working_dir — ancestor, equal, descendant hit, siblings do not; counter-test: the old state hits them", () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-an19-line-"));
  try {
    const P = path.join(w, "ws", "p");
    for (const d of ["audit/services/x/inside", "audit/services/y", "audit/services/xy"]) fs.mkdirSync(path.join(P, d), { recursive: true });
    const list = containerFromPs([
      psRow("audit-x-1", { labels: compose("x", path.join(P, "audit")) }), // compose one level above the service folder
      psRow("x-x-1", { labels: compose("x", path.join(P, "audit/services/x")) }),
      psRow("inside-x-1", { labels: compose("x", path.join(P, "audit/services/x/inside")) }),
      psRow("y-x-1", { labels: compose("x", path.join(P, "audit/services/y")) }),
      psRow("xy-x-1", { labels: compose("x", path.join(P, "audit/services/xy")) }),
      psRow("p-x-1", { labels: compose("x", P) }), // a stack at the root
      psRow("x"), // without a label: only the exact name, untouched by `dir`
    ].join("\n"));
    const names = (dir) => matchContainers(list, "x", P, { dir }).map((c) => c.name).sort();
    const line = ["audit-x-1", "inside-x-1", "p-x-1", "x", "x-x-1"];
    assert.deepEqual(names("audit/services/x"), line, "ancestor, equal, descendant, the root — and the exact name");
    assert.deepEqual(names("./audit/services/x/"), line, "`./` and a trailing slash change nothing");
    assert.deepEqual(names("audit/services/y"), ["audit-x-1", "p-x-1", "x", "y-x-1"], "the sibling hits its own service folder");
    const all = ["audit-x-1", "inside-x-1", "p-x-1", "x", "x-x-1", "xy-x-1", "y-x-1"];
    for (const dir of ["", "/abs/path", "../outside", "audit/../y", "."]) assert.deepEqual(names(dir), all, `"${dir}" does not narrow (the earlier rule)`);
    // COUNTER-TEST: the old state knows no `dir` — it also hits the siblings y-x-1 and xy-x-1.
    const prior = matchBeforeAn19()(list, "x", P).map((c) => c.name).sort();
    assert.deepEqual(prior, all, "the old state hits all under the root");
    for (const foreign of ["y-x-1", "xy-x-1"]) assert.ok(prior.includes(foreign) && !names("audit/services/x").includes(foreign), `${foreign}: hit before, not now`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test("matchContainers: a superseded container never hits — compared by id prefix; counter-test: without `exempt` and in the old state it hits", () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-an19-superseded-"));
  try {
    const P = path.join(w, "p");
    for (const d of ["web", "frontend"]) fs.mkdirSync(path.join(P, d), { recursive: true }); // realpath: both folders exist
    const full = "ab".repeat(32);
    const list = containerFromPs([
      withId(psRow("web-fixed", { labels: compose("app", path.join(P, "web")), state: "exited" }), full.slice(0, 12)), // `ps` shortens
      withId(psRow("frontend-app-1", { labels: compose("app", path.join(P, "frontend")) }), "cd".repeat(6)),
      withId(psRow("without-id", { labels: compose("app", path.join(P, "web")) }), ""),
    ].join("\n"));
    const names = (exempt) => matchContainers(list, "app", P, { exempt }).map((c) => c.name).sort();
    assert.deepEqual(names(new Set([full])), ["frontend-app-1", "without-id"], "the full id of the table exempts the shortened one; without an id none is exempted");
    assert.deepEqual(names([full.slice(0, 12)]), ["frontend-app-1", "without-id"], "a shortened id in the table too");
    // COUNTER-TEST: without `exempt` and in the old state the superseded container hits too.
    assert.deepEqual(names(null), ["frontend-app-1", "web-fixed", "without-id"]);
    assert.ok(matchBeforeAn19()(list, "app", P).some((c) => c.name === "web-fixed"), "the old state hits the superseded one");
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

// The main seam as above: a project with the service `x` (`dir` = audit/services/x) and three compose containers — `audit-x-1` (on
// the line), `y-x-1` (sibling) and `old-x-1` (on the line, but superseded: a row in `project_superseded`). Stop and log hit only
// `audit-x-1` — `dir` arrives via the routes (service.dir), the superseded ones via server.js setSupersededSource. Then the rebuild
// marker: with the marker the monitor does not report the stopped service, without it it does (counter-test in the same situation).
// Counter-test on the product: server.js without `setSupersededSource(…)` => red ("only audit-x-1 — neither the sibling nor the
// superseded one": old-x-1 was stopped too).
test("main seam: stop and log hit only the container on the line (dir via the routes, superseded via server.js), the rebuild marker holds the monitor", async () => {
  const fd = await fakeDocker();
  const pathPrior = process.env.PATH;
  try {
    await withAgentsServer(async (ctx) => {
      const { base, ws } = ctx;
      process.env.PATH = `${fd.dir}${path.delimiter}${pathPrior}`;
      forgetDockerStatus();
      const filePath = path.join(ctx.root, "workspace", "a");
      for (const d of ["audit/services/x", "audit/services/y"]) fs.mkdirSync(path.join(filePath, d), { recursive: true });
      const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "A", path: filePath }) });
      const svc = store.addProjectService(p.id, { name: "x", container: "x", dir: "audit/services/x" });
      const seed = (name, folder) => {
        const labels = Object.entries(compose("x", path.join(filePath, folder))).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
        return execFileSync(fd.bin, ["run", "-d", "--name", name, ...labels, "postgres:16"], { encoding: "utf8" }).trim();
      };
      seed("audit-x-1", "audit");
      seed("y-x-1", "audit/services/y");
      const oldId = seed("old-x-1", "audit");
      store.rememberSuperseded({ projectId: p.id, instance: "main", containerId: oldId, namePrior: "old-x-1", stackPrior: "audit", stackNow: "audit-new" });
      const status = async () => (await json(`${base}/api/projects/${p.id}/services`)).services.find((s) => s.id === svc.id).status.running;
      assert.equal(await status(), true);

      // Monitor: the first pass remembers the state.
      await json(`${base}/api/services/check`, { method: "POST" });
      const { seq } = await json(`${base}/api/services/events`);

      const r = await json(`${base}/api/projects/${p.id}/services/${svc.id}/stop`, { method: "POST" });
      assert.deepEqual(r, { killed: ["audit-x-1"], stopped: true }, "only audit-x-1 — neither the sibling nor the superseded one");
      assert.deepEqual(fd.calls().filter((a) => a.args[0] === "stop").map((a) => a.args.slice(1)), [["audit-x-1"]]);
      const z = Object.values(fd.state().container);
      for (const n of ["y-x-1", "old-x-1"]) assert.equal(z.find((c) => c.name === n).status, "running", `${n} keeps running`);
      assert.equal(await status(), false, "the service is stopped — y-x-1 and old-x-1 do not count");
      await json(`${base}/api/projects/${p.id}/services/${svc.id}/log`);
      assert.deepEqual(fd.calls().filter((a) => a.args[0] === "logs").map((a) => a.args.at(-1)), ["audit-x-1"], "docker logs only for audit-x-1");

      // Rebuild marker: two passes (an outage counts only after two failed probes) — with the marker NO "down".
      setRebuildMarker(p.id, true);
      try {
        await json(`${base}/api/services/check`, { method: "POST" });
        await json(`${base}/api/services/check`, { method: "POST" });
        assert.deepEqual((await json(`${base}/api/services/events?since=${seq}`)).events, [], "with the rebuild marker the monitor does not check the project");
      } finally { setRebuildMarker(p.id, false); }
      // COUNTER-TEST: the same situation without the marker — the outage is reported.
      await json(`${base}/api/services/check`, { method: "POST" });
      await json(`${base}/api/services/check`, { method: "POST" });
      const ev = (await json(`${base}/api/services/events?since=${seq}`)).events;
      assert.deepEqual(ev.map((e) => [e.kind, e.projectId]), [["down", p.id]], JSON.stringify(ev));
    });
  } finally {
    process.env.PATH = pathPrior;
    forgetDockerStatus();
    fd.cleanUp();
  }
});
