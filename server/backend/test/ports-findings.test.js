// Three gaps that became visible in a real incident.
//
// An agent was to start a project's frontend. The service had been registered for months (port 3101, with a stored start
// command). It never read `cbase_ports_list` but asked `cbase_ports_free`, got 3102 - the free neighbour port of the app it should
// have started - and ran a second process there for 3.5 days. Nowhere was this visible: the apps view reads registrations, the
// port forwarding suggests registrations, and nobody asked the live scan that would have known. Later the same agent overwrote
// the stored start command of the real service twice; the original state was lost.
//
// So what is checked is that three things now stand in the ANSWER and not in an omission: the skipped claimed ports, the
// unregistered service as a finding, and the replaced start command.
//
// With the project container also the building blocks of the network paths in ports.js, without a server: the probe against
// another host (an instance's IP - here the second loopback address from fake-docker.mjs) with a DECOY on 127.0.0.1 at the same
// port, reading /proc/net/tcp{,6} from a template, and the computation per namespace. The paths over server, fake docker and
// tunnel are in projectbox-network-paths.test.js.
// COUNTER-TEST: ports.js without the `{ host }` parameter - the first new test is red (scanPorts does not know `{ host }` and
// probes 127.0.0.1: the listener is missing, the decoy appears), the file as a whole red at the import (parseProcNetTcp,
// claimsPerSpace, findingsInSpace did not exist).
//
// At the end: the question of the native browser (`?ports=P&registered=1`) costs ONE `docker exec` per live instance (cat
// /proc/net/tcp{,6}) and no lsof; the aliveness probe (instanceAlive, tunnel and port choice) likewise. Server, operating mark and
// fake docker as in projectbox-network-paths.test.js (agent-harness.mjs withAgentsServer, fake-docker.mjs). COUNTER-TEST:
// ports.js and projects/routes.js with three execs per instance (cat, lsof LISTEN, lsof cwd) and instanceAlive starting lsof =>
// the test is red.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";

import { startServer } from "../electron/server/server.js";
import { claimsPerSpace, findingsInSpace, checkPort, instanceAlive, forgetListenerStatus, parseProcNetTcp, scanPorts } from "../electron/server/ports.js";
import * as store from "../electron/server/store.js";
import { portConflicts } from "../electron/server/store.js";
import { db as rawDb } from "../electron/server/store/db.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-ports-findings-"));
  let server;
  try {
    const workspacePath = path.join(root, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    server = await startServer({
      port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"),
      pickDirectory: null, notify: null,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = (await json(`${base}/api/workspaces`, {
      method: "POST", body: JSON.stringify({ name: "Test", path: workspacePath }),
    })).body;
    // Leave the project folder empty: otherwise the route triggers a services scan that
    // writes services of its own into the table in the middle of the check.
    const projPath = path.join(workspacePath, "app");
    const proj = (await json(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST", body: JSON.stringify({ name: "App", path: projPath }),
    })).body;
    await run({ base, ws, proj, projPath });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const addService = (base, projectId, body) =>
  json(`${base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId, ...body }) });

test("ports/free names the claimed ports it walked past", async () => {
  await withServer(async ({ base, proj }) => {
    // Two occupied neighbours, like 3100 (another project) and 3101 (this frontend).
    const a = await addService(base, proj.id, { name: "Web-Frontend", port: 31500, kind: "frontend", startCommand: "npm run dev" });
    assert.equal(a.status, 201);
    assert.equal((await addService(base, proj.id, { name: "API", port: 31501, kind: "backend" })).status, 201);

    const free = await json(`${base}/api/ports/free?start=31500&end=31599`);
    assert.equal(free.status, 200);
    assert.ok(free.body.port > 31501, `expected a port behind the claimed ones, got ${free.body.port}`);

    // The core: the omission is now a statement.
    const ports = free.body.skipped.map((u) => u.port);
    assert.deepEqual(ports, [31500, 31501]);
    assert.equal(free.body.skippedTotal, 2);
    const frontend = free.body.skipped.find((u) => u.port === 31500);
    assert.equal(frontend.service, "Web-Frontend");
    assert.equal(frontend.project, "App");
    // The stored start command comes along: that tells the caller that exactly the
    // service it wanted to start is already registered.
    assert.equal(frontend.startCommand, "npm run dev");
  });
});

test("ports/running reports an unregistered service from a project folder as a finding", async () => {
  await withServer(async ({ base, projPath }) => {
    // A real listener whose working directory is IN the project folder - exactly the
    // situation of the incident: a dev server somebody started by hand without
    // registering it. As a child process and not in the test process itself, because the finding hangs on
    // its cwd and the test process runs in the repo.
    const subprocess = spawn(process.execPath, ["-e", `
      const net = require("node:net");
      const srv = net.createServer((s) => s.end());
      srv.listen(0, "127.0.0.1", () => { process.stdout.write(String(srv.address().port) + "\\n"); });
    `], { cwd: projPath, stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise((resolve, reject) => {
      let buf = "";
      const deadline = setTimeout(() => reject(new Error("child process did not name its port")), 10000);
      subprocess.stdout.on("data", (d) => {
        buf += String(d);
        const n = Number(buf.trim());
        if (buf.includes("\n") && Number.isInteger(n) && n > 0) { clearTimeout(deadline); resolve(n); }
      });
      subprocess.on("error", (e) => { clearTimeout(deadline); reject(e); });
    });
    try {
      const run = await json(`${base}/api/ports/running?ports=${port}`);
      assert.equal(run.status, 200);
      assert.equal(run.body.findingsComplete, true);
      const open = run.body.open.find((o) => o.port === port);
      assert.ok(open, "the port must be recognised as open");
      assert.equal(open.registered, null, "no service claims it");

      const b = run.body.findings.find((x) => x.port === port);
      // resolveListeners works "best effort": without lsof/ss there is no cwd and thus
      // no finding. Then the only thing that counts is that nothing false is claimed.
      if (!open.process?.cwd) {
        assert.equal(b, undefined, "without a resolved cwd no finding may be invented");
        return;
      }
      assert.ok(b, "an unregistered listener in the project folder must be a finding");
      assert.equal(b.kind, "unregistered");
      assert.equal(b.project, "App");
      assert.ok(b.cwd.startsWith(fs.realpathSync(projPath)) || projPath.startsWith(b.cwd),
        `cwd of the finding (${b.cwd}) must be in the project folder (${projPath})`);
    } finally {
      subprocess.kill("SIGKILL");
    }
  });
});

test("ports/running names a port conflict even without process resolution", async () => {
  await withServer(async ({ base, ws, proj }) => {
    const second = (await json(`${base}/api/workspaces/${ws.id}/projects`, {
      method: "POST", body: JSON.stringify({ name: "Second", path: path.join(path.dirname(proj.path), "second") }),
    })).body;
    await addService(base, proj.id, { name: "web", port: 31777, kind: "frontend" });
    await addService(base, second.id, { name: "web", port: 31777, kind: "frontend" });

    // Light mode: no process resolution - but the conflict does not hang on the scan.
    const run = await json(`${base}/api/ports/running?registered=1`);
    assert.equal(run.body.findingsComplete, false, "incomplete must be flagged");
    const k = run.body.findings.find((x) => x.kind === "conflict" && x.port === 31777);
    assert.ok(k, "conflict missing");
    assert.deepEqual(k.services.map((d) => d.project).sort(), ["App", "Second"]);
  });
});

test("a replaced start command is not lost - even after two overwrites", async () => {
  await withServer(async ({ base, proj }) => {
    const svc = (await addService(base, proj.id, {
      name: "Web-Frontend", port: 31800, kind: "frontend",
      startCommand: "npm run build && node server.js",
    })).body;

    // First overwrite: the agent redirects the service to its dummy.
    const first = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ startCommand: "BACKEND_URL=http://127.0.0.1:3103 node server.js" }),
    });
    assert.equal(first.status, 200);
    // It learns in the same move what it displaced.
    assert.equal(first.body.replacedStartCommand, "npm run build && node server.js");

    // Second overwrite: it writes back a version of its OWN, not the original.
    // Exactly here a single predecessor slot would have lost the original state.
    const second = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ startCommand: "node server.js # restored" }),
    });
    assert.equal(second.body.replacedStartCommand, "BACKEND_URL=http://127.0.0.1:3103 node server.js");

    const hist = await json(`${base}/api/project-services/${svc.id}/command-history`);
    assert.equal(hist.status, 200);
    assert.deepEqual(hist.body.history.map((h) => h.startCommand), [
      "BACKEND_URL=http://127.0.0.1:3103 node server.js",
      "npm run build && node server.js",
    ]);

    // Saving without a change is no replacement.
    const equal = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ startCommand: "node server.js # restored" }),
    });
    assert.equal(equal.body.replacedStartCommand, undefined);
    assert.equal((await json(`${base}/api/project-services/${svc.id}/command-history`)).body.history.length, 2);
  });
});

test("the history holds 10 levels and drops the OLDEST, not the newest entry", async () => {
  await withServer(async ({ base, proj }) => {
    const svc = (await addService(base, proj.id, { name: "web", port: 31810, startCommand: "cmd0" })).body;
    for (let i = 1; i <= 12; i++) {
      await json(`${base}/api/project-services/${svc.id}`, { method: "PATCH", body: JSON.stringify({ startCommand: `cmd${i}` }) });
    }
    const hist = (await json(`${base}/api/project-services/${svc.id}/command-history`)).body.history;
    assert.equal(hist.length, 10);
    // Newest first: cmd11 was replaced by cmd12, cmd0 and cmd1 have dropped out.
    assert.equal(hist[0].startCommand, "cmd11");
    assert.equal(hist.at(-1).startCommand, "cmd2");
  });
});

test("a service's description is changeable and is delivered in the list", async () => {
  await withServer(async ({ base, proj }) => {
    // It used to be read-only: set once by the scan, uncorrectable afterwards - and
    // it did not come along in the global services list at all. So a description
    // ("build with VITE_API_BASE=...") could contradict the start command next to it ("MUST stay empty")
    // without anybody being able to see or fix it.
    const svc = (await addService(base, proj.id, {
      name: "web", port: 31830, startCommand: "npm run dev",
      description: "outdated: build with VITE_API_BASE",
    })).body;

    const r = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ description: "VITE_API_BASE MUST stay empty." }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.description, "VITE_API_BASE MUST stay empty.");

    const list = await json(`${base}/api/project-services`);
    const row = list.body.find((x) => x.id === svc.id);
    assert.equal(row.description, "VITE_API_BASE MUST stay empty.", "the list must deliver it");

    // A description is no start command: it writes no history and triggers none.
    assert.equal(r.body.replacedStartCommand, undefined);
    assert.equal((await json(`${base}/api/project-services/${svc.id}/command-history`)).body.history.length, 0);

    const tooLong = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ description: "x".repeat(2001) }),
    });
    assert.equal(tooLong.status, 400);
  });
});

test("a start command that is too long is rejected instead of silently cut", async () => {
  await withServer(async ({ base, proj }) => {
    const svc = (await addService(base, proj.id, { name: "web", port: 31820, startCommand: "node server.js" })).body;
    const lang = `node server.js # ${"x".repeat(320)}`;
    const r = await json(`${base}/api/project-services/${svc.id}`, {
      method: "PATCH", body: JSON.stringify({ startCommand: lang }),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /300/);
    // And the stock stays untouched - a rejected write must change nothing.
    const target = await json(`${base}/api/project-services/${svc.id}/command-history`);
    assert.equal(target.body.history.length, 0);
  });
});

// ── a re-scan reconciles instead of replacing the stock ─────────────────────────────────────────────────────────────────
// The real way: "scan again" (POST /api/projects/:pid/services/scan) -> projects/scans.js -> the scanner (a oneshot of the fake CLI,
// it answers the content of scan.json) -> store/projects.js reconcile. Replacing the stock (DELETE + INSERT) gave every service a
// new id - the desired state's services and the run key in services.js pointed nowhere, a running portless service counted as
// stopped and could be started a second time -, and a hand-registered service vanished entirely.
// COUNTER-TEST: store/projects.js and projects/scans.js replacing the stock => red at "the id of Worker stays".
const SCANNER = fakeClaude({ oneshot: `
    if (prompt.includes("service scanner")) respond(fs.readFileSync(path.join(LOCATION, "scan.json"), "utf8"));
    else respond("[]");` });

test("a re-scan keeps the ids, the running portless service and the hand-registered one - no second start", async () => {
  const shellPrior = process.env.SHELL;
  let pgid = null;
  try {
    process.env.SHELL = "/bin/sh"; // the login shell of the simple start (startSimple), without the machine's profile
    await withAgentsServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "rescan"); // empty: the creation does not scan by itself
      fs.mkdirSync(filePath, { recursive: true });
      const proj = (await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Rescan", path: filePath }) })).body;
      const marker = path.join(ctx.root, "worker.marker");
      // The body as a file: the scanner cuts a start command to 300 characters (claude.js scanServices).
      const body = path.join(ctx.root, "worker.sh");
      fs.writeFileSync(body, `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'\nexec sleep 100000\n`);
      const scanResult = (worker) => fs.writeFileSync(path.join(ctx.root, "scan.json"), JSON.stringify([
        { name: worker, kind: "worker", port: null, startCommand: `exec sh '${body}'` },
        { name: "Web", kind: "frontend", port: 31873, startCommand: "npm run dev" },
      ]));
      const base = (c) => `${c.base}/api/projects/${proj.id}`;
      // The route sets the state "running" BEFORE it answers - any other state afterwards is this scan's.
      const scan = async () => {
        assert.equal((await json(`${base(ctx)}/services/scan`, { method: "POST" })).status, 202);
        return ctx.waitForTruthy(async () => {
          const d = (await json(`${base(ctx)}/services`)).body;
          return d.scan && d.scan.status !== "running" ? d : null;
        }, "scan done");
      };

      scanResult("Worker");
      const d1 = await scan();
      assert.equal(d1.scan.status, "done", JSON.stringify(d1.scan));
      const id = (name) => d1.services.find((x) => x.name === name)?.id;
      const workerId = id("Worker");
      const webId = id("Web");
      assert.ok(workerId && webId, JSON.stringify(d1.services));
      // Registered by hand (POST /api/project-services = cbase_service_add, "the one the scan did not capture").
      const hand = (await addService(ctx.base, proj.id, { name: "Storybook", kind: "frontend", port: 31874, startCommand: "npm run storybook" })).body;
      // The portless service runs (simple start in B - no operating mark, no project container).
      const start = await json(`${base(ctx)}/services/${workerId}/start`, { method: "POST", body: "{}" });
      assert.equal(start.status, 202, JSON.stringify(start.body));
      await ctx.waitForTruthy(() => fs.existsSync(marker), "worker running");
      pgid = Number(fs.readFileSync(marker, "utf8").trim().split(/\s+/)[1]);

      // The same stack; this time the scanner writes the service in lower case - and, as always, does not name Storybook.
      scanResult("worker");
      const d2 = await scan();
      const after = Object.fromEntries(d2.services.map((x) => [x.name, x]));
      const ids = JSON.stringify(d2.services.map((x) => [x.name, x.id]));
      assert.equal(after.Worker?.id, workerId, `the id of Worker stays (name and id of the stock): ${ids}`);
      assert.equal(after.Web?.id, webId, ids);
      assert.equal(after.Storybook?.id, hand.id, `the hand-registered service stays: ${ids}`);
      assert.equal(d2.services.length, 3, `no duplicate: ${ids}`);
      assert.deepEqual(d2.scan.notFound, [{ id: hand.id, name: "Storybook" }], "the scan says what it did not find");
      // The run still belongs to its service: state "running", a second start is 409 (no double process), the stop
      // finds it.
      assert.equal(after.Worker.status.running, true, JSON.stringify(after.Worker.status));
      const second = await json(`${base(ctx)}/services/${workerId}/start`, { method: "POST", body: "{}" });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      const stop = await json(`${base(ctx)}/services/${workerId}/stop`, { method: "POST" });
      assert.equal(stop.body?.stopped, true, JSON.stringify(stop.body));
    }, { claude: SCANNER });
  } finally {
    if (shellPrior === undefined) delete process.env.SHELL; else process.env.SHELL = shellPrior;
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  }
});

// ── the reconciliation piles up no duplicates, and "by hand" holds for the content ──────────────────────────────────────
// A first repair kept EVERY service the scan did not name. The scanner is a model call and names the same portless service
// differently on the next run ("Web-Frontend" -> "Frontend" -> "Web") with a slightly different command: none of the four keys
// hits, and every re-scan put another startable row next to it (different run key => startable a second time next to the
// running original). And a hand-registered service kept its id but not its command: the scan overwrote it. Since then every row
// carries its origin (store/db.js `origin`): a scan row the scan no longer names is dropped - unless it runs or is in an
// instance's desired state (projects/scans.js keep list) -, a hand row stays with everything in it; what stays without being
// found is removed by the human at the row (DELETE /api/project-services/:id, web ProjectServicesPane and iOS ProjectsPane).
// The real way as above: "scan again" -> scanner (oneshot of the fake CLI) -> reconcile, start/stop over the routes.
// COUNTER-TEST: the first repair (keeping every unnamed service) => red at "one row for the Web-Frontend" (two rows); replacing
// the stock => red at "the hand-registered service stays".
test("a re-scan that names the same service differently adds no second row - except next to a running one; hand-registered keeps its command", async () => {
  const shellPrior = process.env.SHELL;
  let pgid = null;
  try {
    process.env.SHELL = "/bin/sh";
    await withAgentsServer(async (ctx) => {
      const filePath = path.join(ctx.root, "workspace", "duplicates");
      fs.mkdirSync(filePath, { recursive: true });
      const proj = (await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Dubletten", path: filePath }) })).body;
      const marker = path.join(ctx.root, "worker.marker");
      const body = path.join(ctx.root, "worker.sh");
      fs.writeFileSync(body, `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${marker}.tmp' && mv '${marker}.tmp' '${marker}'\nexec sleep 100000\n`);
      const base = `${ctx.base}/api/projects/${proj.id}`;
      const scan = async (findings) => {
        fs.writeFileSync(path.join(ctx.root, "scan.json"), JSON.stringify(findings));
        assert.equal((await json(`${base}/services/scan`, { method: "POST" })).status, 202);
        const d = await ctx.waitForTruthy(async () => {
          const d = (await json(`${base}/services`)).body;
          return d.scan && d.scan.status !== "running" ? d : null;
        }, "scan done");
        assert.equal(d.scan.status, "done", JSON.stringify(d.scan));
        return d;
      };
      const names = (d) => d.services.map((x) => x.name).sort();
      const row = (d, name) => d.services.find((x) => x.name === name);
      const worker = { name: "Worker", kind: "worker", port: null, startCommand: `exec sh '${body}'` };

      // Registered by hand, with its own command (POST /api/project-services = cbase_service_add).
      const hand = (await addService(ctx.base, proj.id, { name: "Storybook", kind: "frontend", port: 31875, startCommand: "npx storybook dev -p 31875 --no-open" })).body;
      // Two rows of unknown origin (NULL - every row from before the column): they stay what they were. Not found => stays;
      // hit => the scan overwrites as before.
      const old = store.addProjectService(proj.id, { name: "Legacy", port: null, startCommand: "npm run legacy" });
      const oldApi = store.addProjectService(proj.id, { name: "API", port: 31876, startCommand: "node alt.js" });
      rawDb.prepare("UPDATE project_services SET origin = NULL WHERE id IN (?, ?)").run(old.id, oldApi.id);
      const d1 = await scan([{ name: "Web-Frontend", kind: "frontend", port: null, dir: "web", startCommand: "npm run dev" }, worker]);
      assert.equal(d1.scan.status, "done", JSON.stringify(d1.scan));
      const workerId = row(d1, "Worker")?.id;
      assert.ok(workerId, JSON.stringify(d1.services));

      // The same stack, named differently - and the scanner now also names Storybook, with ITS command.
      const d2 = await scan([
        { name: "Frontend", kind: "frontend", port: null, dir: "web", startCommand: "npm run dev -- --host" },
        worker,
        { name: "storybook", kind: "other", port: 31875, startCommand: "npm run storybook", description: "from scan" },
        { name: "api", kind: "backend", port: 31876, startCommand: "node server.js" },
      ]);
      assert.deepEqual(names(d2), ["API", "Frontend", "Legacy", "Storybook", "Worker"], `one row for the Web-Frontend: ${JSON.stringify(d2.services.map((x) => [x.name, x.id]))}`);
      assert.deepEqual(d2.scan.removed.map((x) => x.name), ["Web-Frontend"], "the scan says what dropped");
      const sb = row(d2, "Storybook");
      assert.equal(sb?.id, hand.id, "the hand-registered service stays (id and name)");
      assert.equal(sb.startCommand, "npx storybook dev -p 31875 --no-open", "its command stays");
      assert.equal(sb.kind, "frontend");
      assert.equal(sb.description, "from scan", "the scan fills an empty field of the hand row");
      assert.equal(row(d2, "API")?.id, oldApi.id);
      assert.equal(row(d2, "API").startCommand, "node server.js", "unknown origin: the scan overwrites as before");
      assert.deepEqual(d2.scan.notFound.map((x) => x.name), ["Legacy"], "unknown origin, not found: stays");

      // The portless worker runs; this time the scanner names it differently and with a different command. The running one stays
      // (its run hangs on its id), the new row stands next to it - and the human removes it at the row.
      const start = await json(`${base}/services/${workerId}/start`, { method: "POST", body: "{}" });
      assert.equal(start.status, 202, JSON.stringify(start.body));
      await ctx.waitForTruthy(() => fs.existsSync(marker), "worker running");
      pgid = Number(fs.readFileSync(marker, "utf8").trim().split(/\s+/)[1]);
      const different = { name: "Background-Worker", kind: "worker", port: null, startCommand: `exec sh '${body}' --different` };
      const d3 = await scan([{ name: "Web", kind: "frontend", port: null, dir: "web", startCommand: "pnpm dev" }, different]);
      assert.deepEqual(names(d3), ["API", "Background-Worker", "Legacy", "Storybook", "Web", "Worker"], JSON.stringify([d3.scan, d3.services.map((x) => [x.name, x.id])]));
      assert.deepEqual(d3.scan.removed.map((x) => x.name), ["Frontend"]);
      assert.deepEqual(d3.scan.notFound.map((x) => x.name).sort(), ["API", "Legacy", "Storybook", "Worker"], "the running one, the hand-registered one and the unknown ones stay");
      assert.equal(row(d3, "Worker").status.running, true);
      assert.equal((await json(`${base}/services/${workerId}/start`, { method: "POST", body: "{}" })).status, 409, "no second start of the running one");
      const duplicate = row(d3, "Background-Worker");
      assert.deepEqual((await json(`${ctx.base}/api/project-services/${duplicate.id}`, { method: "DELETE" })).body, { ok: true });
      const stop = await json(`${base}/services/${workerId}/stop`, { method: "POST" });
      assert.equal(stop.body?.stopped, true, JSON.stringify(stop.body));
      pgid = null;

      // Stopped, but in an instance's desired state (the restore started it over its id): it stays.
      store.createProjectInstance({ projectId: proj.id, instance: "main", state: "ready", desired: { container: [], services: [workerId] } });
      const d4 = await scan([{ name: "Web", kind: "frontend", port: null, dir: "web", startCommand: "pnpm dev" }, different]);
      assert.equal(row(d4, "Worker")?.id, workerId, `in the desired state => stays: ${JSON.stringify(d4.scan)}`);
      store.deleteProjectInstance(proj.id, "main");
      // It neither runs nor is in the desired state: the next scan clears the old row - one row per service.
      const d5 = await scan([{ name: "Web", kind: "frontend", port: null, dir: "web", startCommand: "pnpm dev" }, different]);
      assert.deepEqual(names(d5), ["API", "Background-Worker", "Legacy", "Storybook", "Web"], JSON.stringify(d5.services.map((x) => [x.name, x.id])));
      assert.deepEqual(d5.scan.removed.map((x) => x.name), ["Worker"]);
      assert.deepEqual(d5.scan.notFound.map((x) => x.name).sort(), ["API", "Legacy", "Storybook"]);
      // Without a verdict on "running" (the facade calls the reconciliation without `keep`) nothing drops - a missing verdict is
      // no statement that nothing runs.
      assert.deepEqual(store.replaceProjectServices(proj.id, []).map((x) => x.name).sort(), ["API", "Background-Worker", "Legacy", "Storybook", "Web"]);
    }, { claude: SCANNER });
  } finally {
    if (shellPrior === undefined) delete process.env.SHELL; else process.env.SHELL = shellPrior;
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  }
});

// ── probes against an instance's host ──────────────────────────────────────────────────────────────────────────────────

// A listener on `host` at `port` (0 = choose a free one) that sends `word` to every caller.
function listener(host, port, word) {
  return new Promise((resolve, reject) => {
    const socks = new Set();
    const srv = net.createServer((s) => { socks.add(s); s.on("close", () => socks.delete(s)); s.on("error", () => {}); s.end(word); });
    srv.once("error", reject);
    srv.listen(port, host, () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); }),
    }));
  });
}

test("scanPorts/checkPort with { host }: the instance's listener, not the decoy on 127.0.0.1", async () => {
  const second = await secondLoopback();
  // Port A: ONLY on the second address (the instance). Port K: ONLY on 127.0.0.1 (B's decoy).
  const instance = await listener(second, 0, "INSTANCE\n");
  let decoy = null;
  try {
    decoy = await listener("127.0.0.1", 0, "DECOY\n");
    const A = instance.port;
    const K = decoy.port;
    assert.deepEqual(await scanPorts([A, K], { host: second }), [A], "with host: only the instance's listener");
    assert.deepEqual(await scanPorts([A, K]), [K], "without host as before: 127.0.0.1 - the decoy, not the instance");
    assert.equal(await checkPort(A, undefined, { host: second }), true);
    assert.equal(await checkPort(K, undefined, { host: second }), false, "the decoy on 127.0.0.1 is not occupied in the instance");
    assert.equal(await checkPort(A), false, "without host: 127.0.0.1");
  } finally {
    await instance.close();
    if (decoy) await decoy.close();
  }
});

// A template after Linux 6.8 (shortened): tcp with a header, two LISTEN (3000 on all addresses, 5432 on loopback) and one
// established connection; behind it tcp6 with its own header and LISTEN on :::8080 - the way `cat /proc/net/tcp /proc/net/tcp6`
// prints both one after the other.
const PROC_NET_TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 515151 1 0000000000000000 100 0 0 10 0",
  "   2: 0100007F:0BB8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 616161 1 0000000000000000 20 4 30 10 -1",
  "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 717171 1 0000000000000000 100 0 0 10 0",
  "",
].join("\n");

test("parseProcNetTcp: LISTEN from tcp and tcp6 one after the other, headers and connections drop out", () => {
  assert.deepEqual(parseProcNetTcp(PROC_NET_TCP), [
    { port: 3000, inode: "424242" },
    { port: 5432, inode: "515151" },
    { port: 8080, inode: "717171" },
  ]);
  assert.deepEqual(parseProcNetTcp(""), []);
  assert.deepEqual(parseProcNetTcp(null), []);
});

// The conflicts are computed not by findingsInSpace itself but by the ONE computation of the data layer (store.portConflicts,
// without relocated projects); findingsInSpace only puts them into the shape of a finding. The test holds the same promise at the
// new place (the computation with explicit claims needs no database); the full way over the server is in conflict-transition.test.js.
test("namespaces: the claims of a relocated project apply in its instance - no conflict across the boundary", () => {
  const claims = [
    { id: 1, port: 3000, projectId: "pA", name: "web", projectName: "A" },
    { id: 2, port: 3000, projectId: "pB", name: "web", projectName: "B" },
    { id: 3, port: 5432, projectId: "pB", name: "db", projectName: "B" },
  ];
  // Without an instance: one space (B) with all claims - today's computation, including the conflict on 3000.
  const without = claimsPerSpace(claims);
  assert.deepEqual([...without.keys()], [null]);
  assert.equal(without.get(null).length, 3);
  assert.deepEqual(findingsInSpace({ conflicts: portConflicts(new Set(), without.get(null)), light: true }).map((b) => [b.kind, b.port, b.instance]), [["conflict", 3000, null]]);
  // pB relocated: its claims move into its instance, and on both sides only ONE project claims 3000.
  const targets = [{ identifier: "pB/main", projectId: "pB", instance: "main", ip: "10.249.1.2", container: "cbase-p-pB" }];
  const including = claimsPerSpace(claims, targets);
  assert.deepEqual([...including.keys()], [null, "pB/main"]);
  assert.deepEqual(including.get(null).map((a) => a.id), [1]);
  assert.deepEqual(including.get("pB/main").map((a) => a.id), [2, 3]);
  assert.deepEqual(portConflicts(new Set(["pB"]), claims), [], "pB relocated: no conflicts any more");
  for (const [identifier, list] of including) assert.deepEqual(findingsInSpace({ identifier, conflicts: portConflicts(new Set(["pB"]), list), light: true }), [], `space ${identifier}`);
  // "unregistered" only with a project of THIS space: the same listener in pB's folder counts in the instance, not in B.
  const open = [{ port: 4000, registered: null, process: { pid: 1, cmd: "vite", cwd: "/ws/b/app" } }];
  const projects = [{ id: "pB", name: "B", path: "/ws/b", workspaceId: "w" }];
  assert.deepEqual(findingsInSpace({ identifier: "pB/main", conflicts: [], open, projects }).map((b) => [b.kind, b.port, b.instance, b.projectId]),
    [["unregistered", 4000, "pB/main", "pB"]]);
  assert.deepEqual(findingsInSpace({ identifier: null, conflicts: [], open, projects: [] }), [], "B does not know the folder of a relocated project");
});

// ── the native browser's question is ONE exec per instance ─────────────────────────────────────────────────────────────
// The client's native browser let a copy's page run silently into "connection refused": its measurement
// `/api/ports/running?ports=P` aborted after 4 s because the server started three `docker exec` one after another per live
// instance (cat, lsof LISTEN, lsof cwd) - about 3.4-4.7 s under load with 16 instances. The client now asks light
// (`&registered=1`), and light mode only needs to know whether an instance is alive: ONE `cat`.

const b407Hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const B407_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const b407Row = (port) =>
  `   0: 0100007F:${b407Hex4(port)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0`;

async function b407WithEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// The inside of every container (docker fake's `programs` hook): `cat` reads the template (tcp6 is missing - `cat`
// exits with 1, the tcp lines are still on stdout), `lsof` names pid 4242 "vite".
function b407Inside(dir, port, projPath) {
  const tcp = path.join(dir, "tcp");
  fs.writeFileSync(tcp, [B407_HEADER, b407Row(port), ""].join("\n"));
  const cat = path.join(dir, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh
rc=0
for f in "$@"; do
  case "$f" in
    /proc/net/tcp) cat '${tcp}' ;;
    *) rc=1 ;;
  esac
done
exit $rc
`);
  const lsof = path.join(dir, "fake-lsof");
  fs.writeFileSync(lsof, `#!/bin/sh
case "$*" in
  *LISTEN*) printf 'p4242\\ncvite\\nn*:${port}\\n' ;;
  *cwd*) printf 'p4242\\nn${projPath}\\n' ;;
esac
`);
  fs.chmodSync(cat, 0o755);
  fs.chmodSync(lsof, 0o755);
  return { cat, lsof };
}

async function b407Project(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  // In operation (the marks are already set): without an instance row via the store - the test creates the row itself (POST
  // .../projects creates the row too in operation).
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  return { p, path: filePath, container: `cbase-p-${p.id}`, identifier: `${p.id}/main` };
}

test("?ports=P&registered=1 (the native browser's question): ONE exec (cat) per live instance, no lsof; instanceAlive likewise", async () => {
  const second = await secondLoopback();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-b407-"));
  let fd = null;
  let service = null;
  try {
    await withAgentsServer(async (ctx) => {
      // The port: the service "in" every instance - they share the address here (the second loopback address).
      service = await listener(second, 0, "INSTANCE\n");
      const P = service.port;
      fd = await fakeDocker({ programs: b407Inside(tmp, P, path.join(ctx.root, "workspace")) });
      await b407WithEnvironment({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin }, async () => {
        // Three live instances (containers run) and a dead one (row with address, no container).
        const live = [];
        for (const name of ["Checkout", "Stock", "Counter"]) {
          const b = await b407Project(ctx, name);
          execFileSync(fd.bin, ["run", "-d", "--name", b.container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
          store.createProjectInstance({ projectId: b.p.id, state: "ready", convertedAt: Date.now(), containerId: b.container, ip: second });
          live.push(b);
        }
        const tot = await b407Project(ctx, "Archive");
        store.createProjectInstance({ projectId: tot.p.id, state: "ready", convertedAt: Date.now(), containerId: tot.container, ip: second });
        // The looks inside (cat or lsof) - counted from a marker, not over everything else the server does.
        const inside = () => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && (a.args.includes("cat") || a.args.includes("lsof")));
        const since = (marker) => inside().slice(marker).map((a) => a.args);
        const ofContainer = (argv, c) => argv.filter((a) => a[3] === c);
        const CAT = (c) => ["exec", "-u", "agent", c, "cat", "/proc/net/tcp", "/proc/net/tcp6"];

        // The browser's question, fresh (no state from before).
        forgetListenerStatus();
        let marker = inside().length;
        const r = await fetch(`${ctx.base}/api/ports/running?ports=${P}&registered=1`, { headers: { Connection: "close" } });
        const body = await r.json();
        assert.equal(r.status, 200, JSON.stringify(body));
        const light = since(marker);
        for (const b of live) assert.deepEqual(ofContainer(light, b.container), [CAT(b.container)], `${b.p.name}: exactly ONE exec (cat), no lsof`);
        assert.ok(ofContainer(light, tot.container).length <= 1, "the dead instance: at most the one attempt");
        assert.deepEqual(light.filter((a) => a.includes("lsof")), [], "light mode starts no lsof");
        // The answer is the same statement as before: every live instance holds P (without a process), the dead one is not probed.
        assert.deepEqual(body.open.filter((e) => e.instance).map((e) => [e.port, e.instance, "process" in e]).sort(),
          live.map((b) => [P, b.identifier, false]).sort());
        assert.deepEqual(body.unreachable, [{ instance: tot.identifier, reason: "Container nicht lesbar (läuft nicht oder fehlt)" }]);
        assert.equal(body.findingsComplete, false);

        // The aliveness probe (tunnel, port choice): ONE exec, no lsof.
        forgetListenerStatus();
        marker = inside().length;
        assert.equal(await instanceAlive({ identifier: live[0].identifier, container: live[0].container }), true);
        assert.equal(await instanceAlive({ identifier: tot.identifier, container: tot.container }), false);
        assert.deepEqual(since(marker).filter((a) => a.includes("lsof")), [], "instanceAlive starts no lsof");
        assert.deepEqual(ofContainer(since(marker), live[0].container), [CAT(live[0].container)]);

        // Counterpart in the same run: full mode still resolves the processes - the count above SEES lsof when it runs.
        forgetListenerStatus();
        marker = inside().length;
        const full = await (await fetch(`${ctx.base}/api/ports/running?ports=${P}`, { headers: { Connection: "close" } })).json();
        assert.ok(since(marker).some((a) => a.includes("lsof")), "full mode resolves processes via lsof");
        for (const b of live) {
          assert.equal(ofContainer(since(marker), b.container).filter((a) => a.includes("cat")).length, 1, `${b.p.name}: the port list comes from ONE cat`);
        }
        assert.ok(full.open.filter((e) => e.instance).every((e) => e.process?.pid === 4242), JSON.stringify(full.open));
      });
    });
  } finally {
    if (service) await service.close();
    fd?.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
