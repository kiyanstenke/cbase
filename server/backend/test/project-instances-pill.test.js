// Guard for the instances in the answers of the services pill (server side). Real server (withAgentsServer) with operating
// marker and the fake docker.
//
// The promises, each with the way that breaks it:
//  (1) ONE INSTANCE ⇒ BYTE-EQUAL: a converted project without copy returns at `/api/project-services` exactly the text that
//      `{ ...serviceRow, running, holdsStart }` yields, and at `/api/project-resources` a row without `instances`. With a copy
//      the answer is the same PLUS `instances` — nothing else new.
//  (2) FROM TWO INSTANCES the contract, exactly: per service `instances: [{ identifier, running, holdsStart }]` (main first,
//      the state per instance: a listener only on the copy's IP ⇒ main false, copy true), per project `instances: [{ identifier,
//      name, dnsName, chatId, chatTitle, state, cpu, memBytes }]` (main: name `main`, chatId ""; copy: name `k1`, its chat with title).
//  (3) WITHOUT OPERATING MARKER no `instances`, even if the copy row exists (the `copies` seam is silent).
//  (4) `holdsStart` PER INSTANCE: a living run that does not listen on the registered port reports `holdsStart: true` ONLY in its
//      own instance — a run in the copy does not make main "held" (neither in `instances` nor in the service row, which belongs
//      to main) and vice versa; the entry of main is the value of the service row; after the copy stops only its value falls.
//      Same answer as the start guard: the second start in the copy is 409 SERVICE_RUNNING. Without the field an apps page that
//      chose a copy would show "stopped" and "Start", and every start would end in that 409.
//  (5) THE VOCABULARY OF THE INSTANCE CHOICE (the same as the code tab's, devtools/routes.js selectedInstance): start, stop and
//      log with `?instance=` answer 400 `code: "INSTANCE_INVALID"` (no identifier, foreign project) resp. 404
//      `code: "UNKNOWN_INSTANCE"` (unknown copy — and a copy that vanishes between choice and call, services.js targetOf), each
//      with the named `identifier`. That is how a view with `afterError` (web/src/lib/code-instance.ts, iOS
//      Code/CodeInstance.swift) visibly falls back to main. The seam is bound: the expected 404 `code` is read by path from
//      `afterError` of both clients (web and iOS must compare the same one, the server must send it).
//  (6) A START ONLY IN A READY COPY: a simple start with `?instance=` of a copy in `create`, `start`, `recreate`, `clearAway` or
//      `error` is 409 `code: "COPY_NOT_READY"` with `identifier`, and no run is created; the agent start stays COPY_AGENT; ready
//      starts as before (202). Otherwise a stale view would start a run in a copy whose backup was already running during clear-away.
//  (7) EXEC PROCESSES count in the resources of THEIR instance (projectbox/exec-measurement.js) — not twice, not B, not foreign.
//  (8) NO GHOST INSTANCE: a copy whose row falls between the copy list and the enrichment is missing from `instances` and the sum.
//
// COUNTER-TESTS (each shown red):
//  · routes.js without the lock for a non-ready copy ⇒ (6) red ("copy in "create": 202"); the lock lets `error` through ⇒ (6)
//    red; the rejection without `identifier` ⇒ (6) red;
//  · instance-fields.js: `holdsStart` of the copy taken from the service row (`service.holdsStart`) ⇒ (4) red;
//  · routes.js: `startHeld` without `{ instance }` (asks main) ⇒ (4) red;
//  · routes.js: `serviceError` without `identifier` ⇒ (5) red; the 404 resp. 400 of the choice without `code` ⇒ (5) red;
//  · services.js: ServiceInstanceError with the old `code` INSTANCE_UNKNOWN ⇒ (5) red;
//  · the binding: `afterError` in web/src/lib/code-instance.ts resp. mobile/CbaseMobile/Code/CodeInstance.swift compares another
//    code ⇒ (5) red; the web anchor no longer matches ⇒ (5) red with a message, never silently green;
//  · projects/routes.js without `instances` for a copy ⇒ (1) and (2) red;
//  · instance-fields.js: `instancesFromTwo` without the copy condition AND the bound `< 2` in `serviceWithInstances` changed to
//    `< 1` ⇒ (1) and (3) red ("instances" on a service without copy). Each of the two places alone stays green: they secure each other;
//  · `chatTitle` empty ⇒ (2) red; `running` of the copy taken from `runningInMain` ⇒ (2) red (copy false instead of true);
//  · exec-measurement.js without the cgroup filter (PID 1, dockerd, inner containers twice) ⇒ (7) red;
//  · without the shim check (the depot counted everything under PID 1 of B) ⇒ (7) red;
//  · CPU from the whole ticks instead of the difference of the probes ⇒ (7) red (ratio 2.0 instead of 2.5);
//  · instance-fields.js without the cleanup of the sum ⇒ (8) red; `instances` also with only one instance ⇒ (8) red.
// No clock as criterion; connections are closed in `finally`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import { openServiceObservations, setServicesSeam } from "../electron/server/services.js";
import { servicesSeam } from "../electron/server/projectbox/services.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";
import { groupAlive } from "./process-group.mjs";

// ── Helpers (a test file never imports another) ────────────────────────────────────────────────────────────────────
async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
function localDockerStub(root) {
  const bin = path.join(root, "local-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(bin, "docker"), 0o755);
  return { path: `${bin}:${process.env.PATH}` };
}
const ops = (fd, local) => ({
  CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_SERVICE_QUERY_MS: "20", SHELL: "/bin/sh", PATH: local.path,
});
const withoutOps = (fd, local) => ({ ...ops(fd, local), CBASE_CONTAINER: undefined, CBASE_DIND: undefined });

async function project(ctx, fd, name = "Checkout") {
  const projPath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(projPath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name, path: projPath });
  const container = `cbase-p-${p.id}`;
  execFileSync(fd.bin, ["run", "-d", "--name", container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: container, ip: "127.0.0.1", dnsName: `${name.toLowerCase()}.cbase` });
  return { p, container };
}
const COPY = "copy-k1";
function copyAlongside(fd, o, { ip, chatId, name = "k1" }) {
  const container = `cbase-k-${o.p.id}-${name}`;
  execFileSync(fd.bin, ["run", "-d", "--name", container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  store.createProjectInstance({ projectId: o.p.id, instance: `copy-${name}`, state: "ready", convertedAt: Date.now(), containerId: container, ip, dnsName: `${o.p.name.toLowerCase()}-${name}.cbase`, chatId });
  return { container, identifier: `${o.p.id}/copy-${name}` };
}
const createService = (ctx, p, fields) => json(`${ctx.base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId: p.id, ...fields }) });
async function listenerOn(host) {
  const srv = net.createServer((sock) => sock.end());
  await new Promise((ok, no) => { srv.once("error", no); srv.listen(0, host, ok); });
  return { port: srv.address().port, close: () => new Promise((ok) => srv.close(() => ok())) };
}
// The raw text of an answer (the byte equality applies to the text, not the parsed value).
async function text(url) {
  const r = await fetch(url, { headers: { Connection: "close" } });
  assert.equal(r.status, 200, `${url}: ${r.status}`);
  return r.text();
}
const rowOfThe = (res, pid) => res.resources.find((x) => x.projectId === pid);
// Start, stop and log of a service — with `identifier` as `?instance=`, without it main (pattern from projectbox-services.test.js).
async function serviceCall(ctx, o, service, what, identifier, body = undefined) {
  const method = what === "log" ? "GET" : "POST";
  const q = identifier === undefined ? "" : `?instance=${encodeURIComponent(identifier)}`;
  const r = await fetch(`${ctx.base}/api/projects/${o.p.id}/services/${service.id}/${what}${q}`, {
    method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
// The `code` by which a client's `afterError` recognizes the fallback to main — read by path; an anchor that finds nothing throws.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function fallbackCode(file, anchor) {
  const m = fs.readFileSync(path.join(REPO, file), "utf8").match(anchor);
  if (!m) throw new Error(`${file}: afterError no longer compares \`code\` that way (anchor ${anchor}) — update the binding in (5)`);
  return m[1];
}
// The marker "pid pgid" of the service's shell, written atomically (the wrapper makes the service the leader of its group).
const markerCommand = (root, name) => `echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > '${root}/${name}.tmp' && mv '${root}/${name}.tmp' '${root}/${name}.marker'`;

test("(1) one instance ⇒ the responses are byte-equal to the plain ones; with a copy the same plus `instances`, nothing else", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  let listener = null;
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const service = await createService(ctx, o.p, { name: "web", startCommand: "sleep 1" });
        const serviceUrl = `${ctx.base}/api/project-services`;
        const resourcesUrl = `${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`;

        // The plain text, built from the store: service row, running, holdsStart — nothing else.
        const expected = store.listAllProjectServices().map((s) => ({ ...s, running: false, holdsStart: false }));
        const individual = await text(serviceUrl);
        assert.equal(individual, JSON.stringify(expected), `with one instance the answer deviates from the plain one: ${individual.slice(0, 400)}`);
        assert.ok(!individual.includes("instances"), "one instance, but `instances` is in the answer");
        const ressIndividual = rowOfThe(JSON.parse(await text(resourcesUrl)), o.p.id);
        assert.equal("instances" in ressIndividual, false, `one instance, but the resource row carries instances: ${JSON.stringify(ressIndividual)}`);

        // With a copy: the same answer plus `instances`.
        listener = await listenerOn(second);
        copyAlongside(fd, o, { ip: second, chatId: null });
        const two = JSON.parse(await text(serviceUrl));
        assert.equal(two.length, 1);
        const { instances, ...rest } = two[0];
        assert.ok(Array.isArray(instances) && instances.length === 2, JSON.stringify(two));
        assert.equal(JSON.stringify([rest]), JSON.stringify(expected), "with a copy something besides `instances` changed in the service row");
        assert.equal(service.id, rest.id);
      });
    });
  } finally {
    if (listener) await listener.close();
    fd.cleanUp();
  }
});

test("(2) from two instances the contract: service `{identifier, running, holdsStart}` per instance, project `{identifier, name, dnsName, chatId, chatTitle, state, cpu, memBytes}`", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  let listener = null;
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        listener = await listenerOn(second);
        // The copy's chat with a title.
        const chat = await json(`${ctx.base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ctx.ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }) });
        await json(`${ctx.base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Rebuild checkout" }) });
        const k = copyAlongside(fd, o, { ip: second, chatId: chat.id });
        // A port service whose port is open only on the copy's IP.
        const service = await createService(ctx, o.p, { name: "web", port: listener.port });

        const list = JSON.parse(await text(`${ctx.base}/api/project-services`));
        const z = list.find((s) => s.id === service.id);
        assert.deepEqual(z.instances, [{ identifier: `${o.p.id}/main`, running: false, holdsStart: false }, { identifier: k.identifier, running: true, holdsStart: false }], JSON.stringify(z));
        assert.deepEqual(Object.keys(z.instances[1]), ["identifier", "running", "holdsStart"]);

        const r = rowOfThe(JSON.parse(await text(`${ctx.base}/api/project-resources?projectId=${o.p.id}&disk=0`)), o.p.id);
        assert.equal(r.instances.length, 2, JSON.stringify(r));
        const touched = (i) => ({ identifier: i.identifier, name: i.name, dnsName: i.dnsName, chatId: i.chatId, chatTitle: i.chatTitle, state: i.state });
        assert.deepEqual(r.instances.map(touched), [
          { identifier: `${o.p.id}/main`, name: "main", dnsName: "checkout.cbase", chatId: "", chatTitle: "", state: "ready" },
          { identifier: k.identifier, name: "k1", dnsName: "checkout-k1.cbase", chatId: chat.id, chatTitle: "Rebuild checkout", state: "ready" },
        ], JSON.stringify(r.instances));
        for (const i of r.instances) {
          assert.equal(typeof i.cpu, "number", JSON.stringify(i));
          assert.equal(typeof i.memBytes, "number", JSON.stringify(i));
        }
      });
    });
  } finally {
    if (listener) await listener.close();
    fd.cleanUp();
  }
});

test("(3) without operating marker there is no `instances` in the response, even when the copy row exists", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(withoutOps(fd, local), async () => {
        const o = await project(ctx, fd);
        copyAlongside(fd, o, { ip: second, chatId: null });
        await createService(ctx, o.p, { name: "web", startCommand: "sleep 1" });
        assert.ok(!(await text(`${ctx.base}/api/project-services`)).includes("instances"));
      });
    });
  } finally {
    fd.cleanUp();
  }
});

test("(4) `holdsStart` per instance: a living run that does not listen on the port holds the start only in ITS instance — copy like main, and after the stop only its value falls", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const k = copyAlongside(fd, o, { ip: second, chatId: null });
        const main = `${o.p.id}/main`;
        // Port 1 is closed on both addresses: "running" says no in every instance, only the start guard knows of the run.
        const service = await createService(ctx, o.p, { name: "elsewhere", port: 1, startCommand: `${markerCommand(ctx.root, "service")}; exec sleep 100000` });
        const runsFile = path.join(ctx.dataRoot, "data", "service-runs.json");
        const pgidOf = (key) => (fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")).find((e) => e.key === key)?.pgid : undefined);
        const marker = path.join(ctx.root, "service.marker");
        const snapshot = async () => {
          const z = JSON.parse(await text(`${ctx.base}/api/project-services`)).find((s) => s.id === service.id);
          return { row: [z.running, z.holdsStart], instances: z.instances };
        };
        const byKey = (h, copy) => [{ identifier: main, running: false, holdsStart: h }, { identifier: k.identifier, running: false, holdsStart: copy }];
        // A simple start in the instance; the group comes back once the entry carries it.
        const startIn = async (identifier, key) => {
          const r = await serviceCall(ctx, o, service, "start", identifier, { mode: "simple" });
          assert.equal(r.status, 202, `Start ${identifier ?? "main"}: ${r.status} ${JSON.stringify(r.body)}`);
          await waitForTruthy(() => fs.existsSync(marker), `marker of the service (${identifier ?? "main"})`);
          const pgid = Number(fs.readFileSync(marker, "utf8").trim().split(/\s+/)[1]);
          fs.rmSync(marker);
          groups.push(pgid);
          await waitForTruthy(() => pgidOf(key) === pgid, `pgid in the entry ${key}`);
          return pgid;
        };

        assert.deepEqual((await snapshot()).instances, byKey(false, false), "before any start something already holds");

        // A run in the COPY: it holds its own start — main does not, not even in the service row (which belongs to main).
        const gk = await startIn(k.identifier, `${o.p.id}:${service.id}@copy-k1`);
        let s = await snapshot();
        assert.deepEqual(s.instances, byKey(false, true), `the copy's run: ${JSON.stringify(s)}`);
        assert.deepEqual(s.row, [false, false], "the service row (main) does not count as held because of the copy's run");
        // Same answer as the start guard: the second start in the copy is 409 SERVICE_RUNNING.
        const two = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "simple" });
        assert.deepEqual([two.status, two.body.code], [409, "SERVICE_RUNNING"], JSON.stringify(two.body));

        // Reverse direction: a run in MAIN — its value in `instances` is that of the service row, the copy stays as it was.
        const gh = await startIn(undefined, `${o.p.id}:${service.id}`);
        s = await snapshot();
        assert.deepEqual(s.instances, byKey(true, true), `both runs: ${JSON.stringify(s)}`);
        assert.deepEqual(s.row, [false, true], "the service row does not report main's run");

        // Stop of the copy: only its value falls.
        const sk = await serviceCall(ctx, o, service, "stop", k.identifier);
        assert.equal(sk.body.stopped, true, JSON.stringify(sk.body));
        await waitForTruthy(() => !groupAlive(gk), "copy's group ended");
        assert.deepEqual((await snapshot()).instances, byKey(true, false), "after the copy's stop");

        const sh = await serviceCall(ctx, o, service, "stop");
        assert.equal(sh.body.stopped, true, JSON.stringify(sh.body));
        await waitForTruthy(() => !groupAlive(gh), "main's group ended");
        assert.deepEqual((await snapshot()).instances, byKey(false, false), "after both stops");
        await waitForTruthy(() => openServiceObservations() === 0, "observers empty");
      });
    });
  } finally {
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
    fd.cleanUp();
  }
});

test("(5) the instance choice of the service routes speaks the code tab's vocabulary: 400 INSTANCE_INVALID, 404 UNKNOWN_INSTANCE, each with `identifier` — also for a copy that vanishes between choice and call", async () => {
  // The seam: a 404 is a fallback to main for a view only if its `afterError` compares EXACTLY this code —
  // web and iOS by path; the server must send it below.
  const unknown = fallbackCode("web/src/lib/code-instance.ts", /export function afterError[\s\S]*?o\.code !== "([A-Z_]+)"/);
  const unknownIos = fallbackCode("mobile/CbaseMobile/Code/CodeInstance.swift", /static func afterError[\s\S]*?code == "([A-Z_]+)"/);
  assert.equal(unknownIos, unknown, "web and iOS recognize the fallback by different codes");
  const second = await secondLoopback();
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const k = copyAlongside(fd, o, { ip: second, chatId: null });
        const service = await createService(ctx, o.p, { name: "web", startCommand: "sleep 1" });
        const check = async (raw, status, code, where) => {
          for (const what of ["start", "stop", "log"]) {
            const x = await serviceCall(ctx, o, service, what, raw, { mode: "simple" });
            assert.deepEqual([x.status, x.body.code, x.body.identifier], [status, code, raw], `${where}: ${what} ?instance=${raw} ⇒ ${x.status} ${JSON.stringify(x.body)}`);
            assert.equal(typeof x.body.error, "string", JSON.stringify(x.body));
          }
        };
        await check(`${o.p.id}/copy-zz`, 404, unknown, "unknown copy");
        await check("other/main", 400, "INSTANCE_INVALID", "foreign project");
        await check("without-form", 400, "INSTANCE_INVALID", "no identifier");
        // The copy vanishes between the choice and the call: the services seam no longer knows it
        // (services.js targetOf throws ServiceInstanceError) — the same answer as for an unknown copy.
        const real = servicesSeam();
        setServicesSeam({ ...real, instanceFor: (pid, instance) => (instance === "copy-k1" ? null : real.instanceFor(pid, instance)) });
        try {
          await check(k.identifier, 404, unknown, "copy gone between choice and call");
        } finally {
          setServicesSeam(real);
        }
      });
    });
  } finally {
    fd.cleanUp();
  }
});

test("(6) a start in a copy that is not `ready` is 409 COPY_NOT_READY with `identifier` — no run in a copy being created, backed up or cleared away; ready starts as before", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  const groups = [];
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const o = await project(ctx, fd);
        const k = copyAlongside(fd, o, { ip: second, chatId: null });
        // A command that ends at once: a start that got through despite the lock leaves no long runner that
        // would hold the server at close — the test goes red, it does not hang. Only for "ready" the long runner with marker.
        const service = await createService(ctx, o.p, { name: "web", port: 1, startCommand: "exit 0" });
        const runsFile = path.join(ctx.dataRoot, "data", "service-runs.json");
        const entryTheCopy = () => (fs.existsSync(runsFile) ? JSON.parse(fs.readFileSync(runsFile, "utf8")).some((e) => e.key === `${o.p.id}:${service.id}@${COPY}`) : false);
        // A copy in a working state counts as open work (`projectInstances` in /api/runs/active) — the harness
        // would wait forever for quiet after a failure. Hence it is back on `ready` in the `finally`.
        try {
          for (const state of ["create", "start", "recreate", "clearAway", "error"]) {
            store.changeProjectInstance(o.p.id, COPY, { state });
            const r = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "simple" });
            assert.deepEqual([r.status, r.body.code, r.body.identifier], [409, "COPY_NOT_READY", k.identifier], `copy in "${state}": ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal(typeof r.body.error, "string", JSON.stringify(r.body));
            assert.ok(r.body.error.includes("k1"), `the message does not name the copy: ${r.body.error}`);
            assert.equal(entryTheCopy(), false, `copy in "${state}": the start created a run anyway`);
          }
          // The agent start stays COPY_AGENT (there is none in any copy), even if it is not ready.
          const agent = await serviceCall(ctx, o, service, "start", k.identifier, { mode: "agent" });
          assert.deepEqual([agent.status, agent.body.code], [409, "COPY_AGENT"], JSON.stringify(agent.body));
        } finally {
          store.changeProjectInstance(o.p.id, COPY, { state: "ready" });
        }

        // Ready: the start goes through as before (202), the run is under the copy's key. A second service: the command with
        // marker is too long for a PATCH (cap 300 characters), the creation takes it.
        const lang = await createService(ctx, o.p, { name: "lang", port: 1, startCommand: `${markerCommand(ctx.root, "service")}; exec sleep 100000` });
        const marker = path.join(ctx.root, "service.marker");
        const ok = await serviceCall(ctx, o, lang, "start", k.identifier, { mode: "simple" });
        assert.equal(ok.status, 202, `ready: ${ok.status} ${JSON.stringify(ok.body)}`);
        await waitForTruthy(() => fs.existsSync(marker), "service marker in the copy");
        groups.push(Number(fs.readFileSync(marker, "utf8").trim().split(/\s+/)[1]));
        await waitForTruthy(() => fs.existsSync(runsFile) && JSON.parse(fs.readFileSync(runsFile, "utf8")).some((e) => e.key === `${o.p.id}:${lang.id}@${COPY}`), "entry of the run in the copy");
        const stop = await serviceCall(ctx, o, lang, "stop", k.identifier);
        assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
        await waitForTruthy(() => !groupAlive(groups[0]), "copy's group ended");
        await waitForTruthy(() => openServiceObservations() === 0, "observers empty");
      });
    });
  } finally {
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
    fd.cleanUp();
  }
});

// ── Resources per instance ────────────────────────────────────────────────────────────────────────────────────────────────
// The fake docker does not know `State.Pid`, and fake-docker.mjs is at the line guard — hence a docker WRAPPER of this
// test: it passes every call to the fake docker and inserts in the output of an `inspect` with `.State.Pid` the PID from
// `pids.sed`. Before the first `stats` it runs `at-stats.sh` once (the ticks BETWEEN the two /proc probes that
// projectbox/exec-measurement.js puts around the call), and while `stats-hold` exists it waits (the gate for (8); tick, no deadline).
function dockerWrapper(root, fd, pids = {}) {
  const d = path.join(root, "wrapper");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "pids.sed"), `# PID 1 per container\n${Object.entries(pids).map(([name, pid]) => `s#^/${name} <no value> #/${name} ${pid} #\n`).join("")}`);
  const bin = path.join(d, "docker");
  fs.writeFileSync(bin, [
    "#!/bin/sh",
    `D='${d}'`,
    `FD='${fd.bin}'`,
    'if [ "$1" = stats ]; then',
    '  if [ -e "$D/at-stats.sh" ]; then sh "$D/at-stats.sh"; rm -f "$D/at-stats.sh"; fi',
    '  if [ -e "$D/stats-hold" ]; then : > "$D/stats.waiting"; while [ -e "$D/stats-hold" ]; do sleep 0.02; done; fi',
    "fi",
    'case "$*" in',
    '  *State.Pid*) out=$("$FD" "$@"); rc=$?; printf \'%s\\n\' "$out" | sed -f "$D/pids.sed"; exit $rc ;;',
    "esac",
    'exec "$FD" "$@"',
    "",
  ].join("\n"));
  fs.chmodSync(bin, 0o755);
  return { bin, dir: d };
}
// A fake /proc: per process stat (ppid, utime, starttime), cgroup, status (VmRSS), smaps_rollup (only with `pss`), cmdline. With
// `utimeAfter` there is also `stat.after`, which `at-stats.sh` copies over `stat` between the probes.
const statRow = (p) => `${p.pid} (${p.comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 100 0 0 0 ${p.utime} 7 0 0 20 0 1 0 4711 1000000 100\n`;
function procWrite(root, processes) {
  for (const p of processes) {
    const d = path.join(root, String(p.pid));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "stat"), statRow({ utime: 10, ...p }));
    if (p.utimeAfter !== undefined) fs.writeFileSync(path.join(d, "stat.after"), statRow({ ...p, utime: p.utimeAfter }));
    fs.writeFileSync(path.join(d, "cgroup"), `0::${p.cgroup}\n`);
    fs.writeFileSync(path.join(d, "status"), `Name:\t${p.comm}\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nVmRSS:\t${p.rss ?? 0} kB\n`);
    if (p.pss !== undefined) {
      fs.writeFileSync(path.join(d, "smaps_rollup"),
        `55d0c0000000-7ffd00000000 ---p 00000000 00:00 0                          [rollup]\nRss:\t${p.pss * 2} kB\nPss:\t${p.pss} kB\nPss_Anon:\t1 kB\nPss_File:\t2 kB\n`);
    }
    fs.writeFileSync(path.join(d, "cmdline"), `${(p.cmdline || [p.comm]).join("\0")}\0`);
  }
  const between = processes.filter((p) => p.utimeAfter !== undefined).map((p) => `cp '${path.join(root, String(p.pid), "stat.after")}' '${path.join(root, String(p.pid), "stat")}'`);
  return between.join("\n");
}
const containerId = (fd, name) => execFileSync(fd.bin, ["inspect", "--type", "container", "--format", "{{.Id}}", name], { env: { ...process.env, ...fd.env } }).toString().trim();
const shimCmdline = (id) => ["/usr/bin/containerd-shim-runc-v2", "-namespace", "moby", "-id", id, "-address", "/var/run/docker/containerd/containerd.sock"];
const KIB = 1024;
const MIB64 = 64 * 1024 ** 2; // the fixed numbers of the fake docker stats per running container (plus CPU 1.5 %)

//  (7) EXEC PROCESSES COUNT: what `docker exec` starts in an instance (wrapper, native service, Chromium) lies, because of the
//      nested cgroup, in B's and was missing from `docker stats`. Now it is in the numbers of ITS instance (memory Pss, else
//      VmRSS; CPU from the ticks between the probes) and in the project sum; what lies in the container's cgroup (PID 1,
//      dockerd, inner containers) does not count twice; the shim itself, B (PID 1, the backend) and a foreign project do not
//      count; a container whose PID 1 does not hang under its shim gets nothing added (otherwise B and all other projects
//      would hang under it). Counter-test: without the exec-process addition main shows 64 MiB instead of 64 MiB + 351,000 kB.
test("(7) exec processes count: what `docker exec` starts in an instance is in ITS numbers — its cgroup, the shim, B and foreign projects are not", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const till = await project(ctx, fd, "Checkout");
        const k = copyAlongside(fd, till, { ip: second, chatId: null });
        const lager = await project(ctx, fd, "Depot");
        const [idH, idK, idL] = [till.container, k.container, lager.container].map((c) => containerId(fd, c));
        const foreign = "f".repeat(64);
        const B = "/init.scope";
        const root = path.join(ctx.root, "proc");
        const between = procWrite(root, [
          // B itself: PID 1, the backend — both in B's cgroup, like the exec processes, but under no shim.
          { pid: 1, ppid: 0, comm: "tini", cgroup: B, pss: 900, utimeAfter: 100_010 },
          { pid: 50, ppid: 1, comm: "node", cgroup: B, pss: 999_999, utimeAfter: 100_010 },
          // Main: shim → PID 1 (tini) → dockerd → inner container; shim → wrapper → node; an orphan at PID 1, without smaps_rollup.
          { pid: 100, ppid: 1, comm: "containerd-shim", cgroup: B, pss: 9_000, utimeAfter: 100_010, cmdline: shimCmdline(idH) },
          { pid: 101, ppid: 100, comm: "tini", cgroup: `/docker/${idH}/init`, pss: 500, utimeAfter: 100_010 },
          { pid: 102, ppid: 101, comm: "dockerd", cgroup: `/docker/${idH}/init`, pss: 60_000, utimeAfter: 100_010 },
          { pid: 106, ppid: 102, comm: "postgres", cgroup: `/docker/${idH}/docker/${"a".repeat(64)}`, pss: 30_000, utimeAfter: 100_010 },
          { pid: 103, ppid: 100, comm: "cbase-wrapper", cgroup: B, pss: 7_000, utime: 50_000, utimeAfter: 53_000 },
          { pid: 105, ppid: 103, comm: "node", cgroup: B, pss: 70_000 },
          { pid: 104, ppid: 101, comm: "next-server (v1", cgroup: B, rss: 274_000, utime: 50_000, utimeAfter: 52_000 },
          // Copy: shim → PID 1; shim → Chromium.
          { pid: 200, ppid: 1, comm: "containerd-shim", cgroup: B, pss: 9_000, cmdline: shimCmdline(idK) },
          { pid: 201, ppid: 200, comm: "tini", cgroup: `/docker/${idK}/init`, pss: 500 },
          { pid: 203, ppid: 200, comm: "chrome", cgroup: B, pss: 200_000, utime: 50_000, utimeAfter: 52_000 },
          // A foreign project (not in the query) with an exec process.
          { pid: 300, ppid: 1, comm: "containerd-shim", cgroup: B, cmdline: shimCmdline(foreign) },
          { pid: 301, ppid: 300, comm: "tini", cgroup: `/docker/${foreign}/init` },
          { pid: 303, ppid: 300, comm: "node", cgroup: B, pss: 777_777, utimeAfter: 100_010 },
          // Depot: PID 1 does NOT hang under its shim (at B's PID 1) — nothing added.
          { pid: 401, ppid: 1, comm: "tini", cgroup: `/docker/${idL}/init`, pss: 500 },
        ]);
        const h = dockerWrapper(ctx.root, fd, { [till.container]: 101, [k.container]: 201, [lager.container]: 401 });
        fs.writeFileSync(path.join(h.dir, "at-stats.sh"), `${between}\n`);
        await withEnvironment({ CBASE_DOCKER_BIN: h.bin, CBASE_PROC_ROOT: root }, async () => {
          const prior = fd.calls({ daemon: "host" }).length;
          const res = JSON.parse(await text(`${ctx.base}/api/project-resources?workspaceId=${ctx.ws.id}&disk=0`));
          const zk = rowOfThe(res, till.p.id);
          const zl = rowOfThe(res, lager.p.id);
          const [iH, iK] = zk.instances || [];
          assert.deepEqual([iH?.identifier, iK?.identifier], [`${till.p.id}/main`, k.identifier], JSON.stringify(zk));
          // Memory exactly: main wrapper 7,000 + node 70,000 (Pss) + orphan 274,000 (VmRSS); copy Chromium 200,000.
          assert.deepEqual([iH.memBytes, iK.memBytes], [MIB64 + 351_000 * KIB, MIB64 + 200_000 * KIB], `exec processes not (exactly) in the numbers of their instance: ${JSON.stringify(zk.instances)}`);
          assert.deepEqual([zk.memBytes, zk.containers], [iH.memBytes + iK.memBytes, 2], `the project sum: ${JSON.stringify(zk)}`);
          assert.deepEqual([zl.memBytes, zl.cpu, zl.containers, "instances" in zl], [MIB64, 1.5, 1, false], `Depot (PID 1 not under its shim) got something added: ${JSON.stringify(zl)}`);
          // CPU: both rise, in the ratio of their ticks BETWEEN the probes (main 3,000 + 2,000, copy 2,000) — the same duration
          // for both, so independent of how long docker took. With B, the shim, PID 1 or the foreign project (+100,000 each) it would be
          // far off, with the whole ticks instead of the difference (50,000 each before) at 2.0.
          assert.ok(iH.cpu > 1.5 && iK.cpu > 1.5, `CPU did not rise: ${JSON.stringify(zk.instances)}`);
          const ratio = (iH.cpu - 1.5) / (iK.cpu - 1.5);
          assert.ok(Math.abs(ratio - 2.5) < 0.05, `CPU shares main/copy ${ratio} instead of 2.5: ${JSON.stringify(zk.instances)}`);
          // Over the seam: ONE inspect for all three containers.
          const inspects = fd.calls({ daemon: "host" }).slice(prior).filter((a) => a.args[0] === "inspect" && a.args.join(" ").includes("State.Pid"));
          assert.equal(inspects.length, 1, JSON.stringify(inspects.map((a) => a.args)));
          for (const c of [till.container, k.container, lager.container]) assert.ok(inspects[0].args.includes(c), `${c} is missing from the inspect`);
        });
      });
    });
  } finally {
    fd.cleanUp();
  }
});

//  (8) NO GHOST INSTANCE: projectResources takes the copy list BEFORE `docker stats` measures, and the clear-away deletes the
//      instance row last — if it falls in between, the copy arrived with `state: ""` (the apps page showed "stopped" and
//      "Clear away"). Now it is missing from `instances`, its numbers are missing from the project sum, and if only main remains,
//      `instances` is missing entirely. The path is entered: the wrapper holds `docker stats` at the gate, the test deletes the
//      rows, then it goes on. Counter-test: without the cleanup, Checkout shows copy-k2 with `state: ""`, Depot shows `instances`.
test("(8) a copy whose row falls between copy list and enrichment is not in `instances` — never `state: \"\"`, its numbers not in the sum, with only main no `instances`", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const local = localDockerStub(ctx.root);
      await withEnvironment(ops(fd, local), async () => {
        const till = await project(ctx, fd, "Checkout");
        const k1 = copyAlongside(fd, till, { ip: second, chatId: null });
        copyAlongside(fd, till, { ip: second, chatId: null, name: "k2" });
        const lager = await project(ctx, fd, "Depot");
        copyAlongside(fd, lager, { ip: second, chatId: null });
        const h = dockerWrapper(ctx.root, fd);
        const hold = path.join(h.dir, "stats-hold");
        fs.writeFileSync(hold, "");
        try {
          await withEnvironment({ CBASE_DOCKER_BIN: h.bin }, async () => {
            const response = text(`${ctx.base}/api/project-resources?workspaceId=${ctx.ws.id}&disk=0`).then((t) => ({ t }), (error) => ({ error }));
            await waitForTruthy(() => fs.existsSync(path.join(h.dir, "stats.waiting")), "docker stats at the gate");
            assert.equal(store.deleteProjectInstance(till.p.id, "copy-k2"), 1);
            assert.equal(store.deleteProjectInstance(lager.p.id, COPY), 1);
            fs.rmSync(hold);
            const a = await response;
            if (a.error) throw a.error;
            const res = JSON.parse(a.t);
            const empty = res.resources.flatMap((z) => z.instances || []).filter((i) => i.state === "");
            assert.deepEqual(empty, [], "an instance without a row is in the answer with state \"\"");
            const zk = rowOfThe(res, till.p.id);
            assert.deepEqual((zk.instances || []).map((i) => [i.identifier, i.state]), [[`${till.p.id}/main`, "ready"], [k1.identifier, "ready"]], JSON.stringify(zk));
            assert.deepEqual([zk.memBytes, zk.cpu, zk.containers], [2 * MIB64, 3, 2], `Checkout: the numbers of the dropped copy are still in the sum: ${JSON.stringify(zk)}`);
            const zl = rowOfThe(res, lager.p.id);
            assert.equal("instances" in zl, false, `Depot has only main left, but carries instances: ${JSON.stringify(zl)}`);
            assert.deepEqual([zl.memBytes, zl.cpu, zl.containers], [MIB64, 1.5, 1], JSON.stringify(zl));
          });
        } finally {
          fs.rmSync(hold, { force: true });
        }
      });
    });
  } finally {
    fd.cleanUp();
  }
});
