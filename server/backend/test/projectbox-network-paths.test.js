// The network paths of the backend to a project instance: port list, port choice, tunnel, the MCP port tools (the part "ports
// and tunnel" - CDP, inspector, WebFetch, monitor and HTTP MCP are in their own files).
//
// The setup, without a clock: a real server (agent-harness.mjs withAgentsServer), operating mark and fake docker
// (fake-docker.mjs) AFTER the start (the mark loads onnxruntime at start), a project with a running container
// `cbase-p-<id>` and instance row whose IP is the second loopback address (127.0.0.2, on macOS ::1). There the service "of
// the instance" listens, on 127.0.0.1 at the SAME port a DECOY (B's service). `cat` and `lsof` of the fake docker look inside
// the container: `cat /proc/net/tcp /proc/net/tcp6` reads a template (tcp6 is missing - `cat` ends with 1, the tcp rows are
// still on stdout), `lsof` names pid 4242 "vite" in the project folder.
//
// The promises, each with the way that breaks it:
//   (1) /api/ports/running?instance=K probes on the instance's IP and resolves the processes IN the container (pid 4242),
//       every entry carries `instance`; the claim of the converted project holds in its instance, not in B (the decoy on
//       127.0.0.1 has no claim there). Without `instance` B and all instances, `instance=` (empty) only B, unknown 404.
//       Without an instance row - and without the operating mark - the list sees only B, and no `docker exec` runs.
//   (2) Tunnel: `instance=K` reaches the instance's service, not the decoy; empty = B; an old client without `instance` stays
//       in B while B holds the port, and goes to the instance when B does not hold it and exactly one instance does; unknown
//       instance 404 before the handshake; without operation 404 with "only in server mode" and B as before.
//       tunnelTarget with a wrong probe: two holders => B, read error => B or 500, instance without address => 409.
//   (3) /api/ports/free?instance=K: only the claims of ITS project, occupied means occupied on the IP - the decoy on 127.0.0.1
//       occupies nothing there; without `instance` in B - without the claims of converted projects (conflict-transition.test.js).
//   (4) MCP: backendAccessFor passes the identifier, writeMcpConfig writes `CBASE_INSTANCE` (not without an instance), and
//       cbase_ports_running/_free send it as `instance` (without it the URL is today's).
//   (5) Fence: from a project network the table sets `instance` to the own identifier; another one (also empty = B) is 403.
//   (6) A copy is a namespace of its own WITH the claims of its project - the copy's port is registered, no "unregistered"; one
//       instance per project gives the same map as before.
//   (7) MCP: cbase_service_log/_start/_stop send the chat's instance as `instance` - only for a service of their project.
//   Every look inside runs as `agent` - an exec without `-u` runs as root in the project box, and lsof would see the root-owned
//       docker-proxy at the published port of the compose stack (cwd "/" => "occupied by another"). The wrapper `rootWrapper`
//       gives such an exec the root view; with `-u agent` the port stays unresolved as in B.
//   (1b) an instance whose container is not readable is not probed (not even lightly), `unreachable` names it; tunnelTarget
//       probes only living instances. Without a clock: the address is REACHABLE here - an entry would betray the probe.
//   (3b) freePort skips the backend port in an instance (`reserved`); the number is in the entrypoint.
//
// COUNTER-TESTS (each in a copy of the tree under $TMPDIR, the earlier state is the index):
//   tunnel.js without the `instance` parameter                  => (2) red: `instance=K` reads "DECOY" (and tunnelTarget is missing)
//   projects/routes.js without the `instance` parameter         => (1) and (3) red: `instance` is ignored, the list names only B
//   the two table rows setting the identifier removed           => (5) red
//   mcp/tools/services.js without `instance` in the URLs        => (4) red: the URL carries no `instance`
//   ports.js `asAgent` without "-u", "agent"                    => (1) red: docker-proxy (root) resolved, finding "occupied by another"
//   projects/routes.js + tunnel.js at the index                 => (1b) red (the dead instance is in `open`) and tunnelTarget red (probed)
//   ports.js without the line "host && INSTANCE_BACKEND_PORT"   => (3b) red: 7718 counts as free in the instance
//   ports.js old claimsPerSpace                                  => (6) red: the copy calls the port "unregistered"
//   projects/routes.js without the check `instanceAlive` in /api/ports/free => (3) red: the never-started instance gets 200
//     with the first port
//   mcp/tools/services.js without the sentence on `unreachable` => (4) red
// Every `finally` closes connections and listeners; the server closes through the harness (closeAllConnections before close).
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { ONLY_IN_OPS } from "../electron/server/projectbox/ops.js";
import { FENCE_TABLE } from "../electron/server/projectbox/fence-table.js";
import { checkScope } from "../electron/server/projectbox/fence.js";
import { tunnelTarget } from "../electron/server/tunnel.js";
import { INSTANCE_BACKEND_PORT, claimsPerSpace, freePort } from "../electron/server/ports.js";
import { writeMcpConfig } from "../electron/server/toolchain/mcp-config.js";
import { backendAccessFor, setBackendAccess } from "../electron/server/runs/backend-access.js";
import { withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_TOOLS = path.resolve(HERE, "..", "electron", "mcp", "tools", "services.js");

// ── helpers (a test file never imports another) ──────────────────────────────────────────────────────────────

async function withEnvironment(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
const withoutOps = { CBASE_CONTAINER: undefined, CBASE_DIND: undefined };

async function request(url) {
  const res = await fetch(url, { headers: { Connection: "close" } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A listener on `host:port` that sends `word` to every caller and stays open until the caller goes.
function listener(host, port, word) {
  return new Promise((resolve, reject) => {
    const socks = new Set();
    const srv = net.createServer((s) => { socks.add(s); s.on("close", () => socks.delete(s)); s.on("error", () => {}); s.write(word); });
    srv.once("error", reject);
    srv.listen(port, host, () => resolve({
      close: () => new Promise((r) => { for (const s of socks) s.destroy(); srv.close(() => r()); }),
    }));
  });
}
const bindable = (host, port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen(port, host, () => s.close(() => resolve(true)));
});
// n consecutive ports that are free on ALL addresses (the port choice searches upwards).
async function freeSequence(n, addresses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = 42000 + Math.floor(Math.random() * 16000);
    let gut = true;
    for (let i = 0; i < n && gut; i++) for (const a of addresses) if (!(await bindable(a, base + i))) { gut = false; break; }
    if (gut) return base;
  }
  throw new Error("no free port sequence found");
}

// Reads the first message over the tunnel - or the answer before the handshake or the close without a message.
function tunnelRead(base, query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/tunnel?${query}`);
    let finished = false;
    const end = (x) => { if (finished) return; finished = true; try { ws.terminate(); } catch {} resolve(x); };
    ws.on("message", (d) => end({ text: String(d) }));
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => end({ status: res.statusCode, body }));
    });
    ws.on("close", (code) => end({ close: code }));
    ws.on("error", (e) => end({ error: String(e?.message || e) }));
  });
}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const procRow = (i, port, inode) =>
  `   ${i}: 0100007F:${hex4(port)} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const PROC_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

// The container's inside for `cat` and `lsof` (docking point `programs` of the fake docker): files in `inside`.
function insidePrograms(dir) {
  const inside = path.join(dir, "inside");
  fs.mkdirSync(inside, { recursive: true });
  const cat = path.join(dir, "fake-cat");
  fs.writeFileSync(cat, `#!/bin/sh
rc=0
for f in "$@"; do
  case "$f" in
    /proc/net/tcp) cat '${inside}/tcp' 2>/dev/null || rc=1 ;;
    /proc/net/tcp6) cat '${inside}/tcp6' 2>/dev/null || rc=1 ;;
    *) rc=1 ;;
  esac
done
exit $rc
`);
  // As root (FAKE_AS_ROOT, set by rootWrapper for an exec WITHOUT `-u`) lsof also sees the root-owned processes -
  // `lsof-listen-root`/`lsof-cwd-root` come BEFORE those of the agent (lsof counts by pid, docker-proxy has the smaller).
  const lsof = path.join(dir, "fake-lsof");
  fs.writeFileSync(lsof, `#!/bin/sh
case "$*" in
  *LISTEN*) [ -n "$FAKE_AS_ROOT" ] && cat '${inside}/lsof-listen-root' 2>/dev/null; cat '${inside}/lsof-listen' 2>/dev/null ;;
  *cwd*) [ -n "$FAKE_AS_ROOT" ] && cat '${inside}/lsof-cwd-root' 2>/dev/null; cat '${inside}/lsof-cwd' 2>/dev/null ;;
esac
`);
  fs.chmodSync(cat, 0o755);
  fs.chmodSync(lsof, 0o755);
  return { inside, programs: { cat, lsof } };
}

// The project-box stage has no USER: a `docker exec` WITHOUT `-u` runs there as root. The wrapper around the fake docker
// gives such an exec `FAKE_AS_ROOT=1` - the fake lsof then also sees the root-owned docker-proxy. An exec with `-u` passes
// unchanged (the fake docker's record then shows the product's argv).
function rootWrapper(dir, fd) {
  const bin = path.join(dir, "docker-as-root");
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = exec ]; then
  case "$2" in -u|--user) exec '${fd.bin}' "$@" ;; esac
  shift
  exec '${fd.bin}' exec -e FAKE_AS_ROOT=1 "$@"
fi
exec '${fd.bin}' "$@"
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// A project with a running container; `convert()` creates the instance row (before that the project is not converted).
async function projectWithContainer(ctx, fd, ip) {
  const projPath = path.join(ctx.root, "workspace", "till");
  fs.mkdirSync(projPath, { recursive: true });
  // Without an instance row through the store (POST .../projects creates one WITH a row in operation) - `convert` creates it.
  const p = await ctx.projectWithoutInstance({ name: "Shop", path: projPath });
  const container = `cbase-p-${p.id}`;
  execFileSync(fd.bin, ["run", "-d", "--name", container, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
  return {
    p, projPath, container, identifier: `${p.id}/main`,
    convert: () => store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: container, ip }),
  };
}
// A converted project whose container does NOT run (server end until the restart grace, removed): row with address, no
// container - every `docker exec` fails like with the real docker ("No such container").
async function projectWithoutContainer(ctx, name, ip) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const p = await ctx.projectWithoutInstance({ name, path: filePath });
  store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${p.id}`, ip });
  return { p, identifier: `${p.id}/main` };
}
const createService = async (ctx, projectId, name, port) => {
  const res = await fetch(`${ctx.base}/api/project-services`, {
    method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ projectId, name, port, kind: "frontend" }),
  });
  assert.equal(res.status, 201);
  return res.json();
};
const execs = (fd) => fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec").length;

// ── (1) port list ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) /api/ports/running per namespace: instance through its IP, processes from the container, B without its claim", async () => {
  const second = await secondLoopback();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-paths-"));
  const { inside, programs } = insidePrograms(tmp);
  const fd = await fakeDocker({ programs });
  const asRoot = rootWrapper(tmp, fd);
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment({ ...ops(fd), CBASE_DOCKER_BIN: asRoot }, async () => {
        const P = await freeSequence(3, ["127.0.0.1", second]);
        const Q = P + 1;
        const R = P + 2; // the compose service "db", published by the inner dockerd - docker-proxy (root) listens there
        const box = await projectWithContainer(ctx, fd, second);
        const web = await createService(ctx, box.p.id, "web", P);
        const db = await createService(ctx, box.p.id, "db", R);
        open.push(await listener(second, P, "INSTANCE\n"), await listener(second, Q, "INSTANCE-Q\n"), await listener(second, R, "DB\n"),
          await listener("127.0.0.1", P, "DECOY\n"));
        fs.writeFileSync(path.join(inside, "tcp"), [PROC_HEADER, procRow(0, P, 424242), procRow(1, Q, 434343), procRow(2, R, 444444), ""].join("\n")); // tcp6 is missing
        fs.writeFileSync(path.join(inside, "lsof-listen"), `p4242\ncvite\nn*:${P}\nn127.0.0.1:${Q}\n`);
        fs.writeFileSync(path.join(inside, "lsof-cwd"), `p4242\nn${box.projPath}\n`);
        fs.writeFileSync(path.join(inside, "lsof-listen-root"), `p1\ncdocker-proxy\nn*:${R}\n`);
        fs.writeFileSync(path.join(inside, "lsof-cwd-root"), `p1\nn/\n`);
        const list = (query) => request(`${ctx.base}/api/ports/running?${query}`);

        // Before the relocation (operation, but no instance row): only B - and no docker exec.
        const prior = await list(`ports=${P},${Q}`);
        assert.equal(prior.status, 200);
        assert.deepEqual(prior.body.open.map((e) => [e.port, e.instance]), [[P, null]], "without an instance row only B");
        assert.equal(prior.body.open[0].registered?.id, web.id, "without a relocation the claim holds in B as before");
        assert.equal(execs(fd), 0, "without an instance row no docker exec");

        box.convert();
        // Only the instance.
        const r = await list(`ports=${P},${Q},${R}&instance=${encodeURIComponent(box.identifier)}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.open.map((e) => [e.port, e.instance]), [[P, box.identifier], [Q, box.identifier], [R, box.identifier]]);
        const [eP, eQ, eR] = r.body.open;
        assert.equal(eP.registered?.id, web.id, "the project's claim holds in its instance");
        assert.deepEqual(eP.process, { pid: 4242, cmd: "vite", cwd: box.projPath }, "the process comes from the container (lsof through docker exec)");
        assert.equal(eP.mismatch, false);
        assert.equal(eQ.registered, null);
        // lsof runs as agent - the root-owned docker-proxy stays unresolved as in B, no "occupiedByOther".
        assert.equal(eR.registered?.id, db.id);
        assert.equal(eR.process, null, "docker-proxy (root) is invisible to agent - as in B (resolveViaProc)");
        assert.equal("mismatch" in eR, false);
        assert.deepEqual(r.body.findings.map((b) => [b.kind, b.port, b.instance, b.projectId]), [["unregistered", Q, box.identifier, box.p.id]],
          "no finding \"occupiedByOther\" at the published port of the compose stack");
        assert.equal(r.body.findingsComplete, true);
        assert.equal("unreachable" in r.body, false, "a living instance is reachable");
        const insideCalls = fd.calls({ daemon: "host" }).filter((a) => a.args[0] === "exec" && (a.args.includes("cat") || a.args.includes("lsof")));
        assert.deepEqual(insideCalls.find((a) => a.args.includes("cat"))?.args, ["exec", "-u", "agent", box.container, "cat", "/proc/net/tcp", "/proc/net/tcp6"]);
        assert.ok(insideCalls.some((a) => a.args.includes("lsof")), "lsof ran");
        assert.deepEqual(insideCalls.filter((a) => a.args.slice(0, 4).join(" ") !== `exec -u agent ${box.container}`).map((a) => a.args), [],
          "every look inside runs as agent");

        // B and all instances: the decoy stands as a B entry WITHOUT a claim (it belongs to the instance), no foreign occupation.
        const all = await list(`ports=${P},${Q},${R}`);
        assert.deepEqual(all.body.open.map((e) => [e.port, e.instance]), [[P, null], [P, box.identifier], [Q, box.identifier], [R, box.identifier]]);
        assert.equal(all.body.open[0].registered, null, "in B the converted project's port has no claim");
        assert.equal(all.body.findings.some((b) => b.kind === "occupiedByOther"), false);
        // B explicitly (empty): only the decoy.
        assert.deepEqual((await list(`ports=${P},${Q}&instance=`)).body.open.map((e) => [e.port, e.instance]), [[P, null]]);
        // Light mode: per space only ITS claims, without process.
        const light = await list("registered=1");
        assert.deepEqual(light.body.open.map((e) => [e.port, e.instance, "process" in e]), [[P, box.identifier, false], [R, box.identifier, false]]);
        assert.equal(light.body.findingsComplete, false);
        // Unknown.
        const nix = await list("instance=exists-not%2Fmain");
        assert.equal(nix.status, 404);
        assert.match(nix.body.error, /unknown instance/);

        // Without the operating mark: 404 "only in server mode", only B, and no further docker call.
        const beforeWithout = fd.calls().length;
        await withEnvironment(withoutOps, async () => {
          const o = await list(`ports=${P},${Q}&instance=${encodeURIComponent(box.identifier)}`);
          assert.equal(o.status, 404);
          assert.equal(o.body.error, ONLY_IN_OPS);
          assert.deepEqual((await list(`ports=${P},${Q}`)).body.open.map((e) => [e.port, e.instance]), [[P, null]]);
        });
        assert.equal(fd.calls().length, beforeWithout, "without operation no docker starts");
      });
    });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("(1b) an instance without a running container is not probed: B stays, `unreachable` names it", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const P = await freeSequence(1, ["127.0.0.1", second]);
        // The instance's address is REACHABLE here (a listener on the second loopback address) - so the answer shows without a
        // clock whether it was probed: the instance's entry would be in `open`. In reality the address of a non-running
        // container does not answer at all, and every batch ran into deadline and retry.
        open.push(await listener(second, P, "GHOSTS-INSTANCE\n"), await listener("127.0.0.1", P, "B\n"));
        const box = await projectWithoutContainer(ctx, "Depot", second);
        await createService(ctx, box.p.id, "web", P);
        const list = (query) => request(`${ctx.base}/api/ports/running?${query}`);
        const not = [{ instance: box.identifier, reason: "Container nicht lesbar (läuft nicht oder fehlt)" }];

        const r = await list(`ports=${P}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.open.map((e) => [e.port, e.instance]), [[P, null]], "B is still in, the dead instance is not");
        assert.deepEqual(r.body.unreachable, not);
        assert.equal(r.body.findingsComplete, false, "an unchecked space is not an empty one");
        assert.equal(r.body.scanned, 1, "what was probed is counted");
        // Light mode (polling) asks the same liveness: no entry of the instance, no "reserved" either.
        const light = await list("registered=1");
        assert.deepEqual(light.body.open, []);
        assert.deepEqual(light.body.reserved, [], "not probed does not mean \"closed\"");
        assert.deepEqual(light.body.unreachable, not);
        // Only the instance: nothing probed.
        const only = await list(`ports=${P}&instance=${encodeURIComponent(box.identifier)}`);
        assert.deepEqual([only.body.open, only.body.unreachable, only.body.scanned], [[], not, 0]);
        // B explicitly: the field is missing (today's answer).
        assert.equal("unreachable" in (await list(`ports=${P}&instance=`)).body, false);
      });
    });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
  }
});

// ── (2) tunnel ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) Tunnel: `instance` reaches the instance, empty is B, an old client stays in B while B holds the port", async () => {
  const second = await secondLoopback();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-paths-"));
  const { inside, programs } = insidePrograms(tmp);
  fs.writeFileSync(path.join(inside, "tcp"), `${PROC_HEADER}\n`); // the container lives (readable) - only living instances are probed
  const fd = await fakeDocker({ programs });
  const open = [];
  let decoy = null;
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const P = await freeSequence(1, ["127.0.0.1", second]);
        const box = await projectWithContainer(ctx, fd, second);
        open.push(await listener(second, P, "INSTANCE\n"));
        decoy = await listener("127.0.0.1", P, "DECOY\n");
        const k = encodeURIComponent(box.identifier);

        // Without an instance row: `instance=K` is unknown, the old way stays B.
        assert.equal((await tunnelRead(ctx.base, `port=${P}&instance=${k}`)).status, 404);
        assert.deepEqual(await tunnelRead(ctx.base, `port=${P}`), { text: "DECOY\n" });

        box.convert();
        assert.deepEqual(await tunnelRead(ctx.base, `port=${P}&instance=${k}`), { text: "INSTANCE\n" }, "with instance: its service, not the decoy");
        assert.deepEqual(await tunnelRead(ctx.base, `port=${P}&instance=`), { text: "DECOY\n" }, "empty: B explicitly");
        assert.deepEqual(await tunnelRead(ctx.base, `port=${P}`), { text: "DECOY\n" }, "an old client: B holds the port, B applies");
        const nix = await tunnelRead(ctx.base, `port=${P}&instance=exists-not%2Fmain`);
        assert.equal(nix.status, 404);
        assert.match(JSON.parse(nix.body).error, /unknown instance/);

        // B no longer holds the port: exactly one instance holds it => it applies to the old client.
        await decoy.close();
        decoy = null;
        assert.deepEqual(await tunnelRead(ctx.base, `port=${P}`), { text: "INSTANCE\n" }, "an old client: exactly one instance holds the port");

        // Without the operating mark: 404 with the mark's wording, the old way goes to B (nothing listens there any more => 1011).
        const beforeWithout = fd.calls().length;
        await withEnvironment(withoutOps, async () => {
          const o = await tunnelRead(ctx.base, `port=${P}&instance=${k}`);
          assert.equal(o.status, 404);
          assert.equal(JSON.parse(o.body).error, ONLY_IN_OPS);
          assert.deepEqual(await tunnelRead(ctx.base, `port=${P}`), { close: 1011 }, "without operation as before: 127.0.0.1");
        });
        assert.equal(fd.calls().length, beforeWithout, "without operation no docker starts");
      });
    });
  } finally {
    for (const l of open) await l.close();
    if (decoy) await decoy.close();
    fd.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("(2) tunnelTarget: two holders => B, read error => B or 500, instance without address => 409, only living instances", async () => {
  const z = (identifier, ip) => ({ identifier, projectId: identifier.split("/")[0], instance: "main", ip, container: `cbase-p-${identifier}` });
  const A = z("pA/main", "10.0.0.2");
  const Bz = z("pB/main", "10.0.1.2");
  const targets = (list) => ({ forIdentifier: (k) => list.find((x) => x.identifier === k) || null, all: () => list });
  // A probe without network: which hosts hold the port?
  const probe = (holders) => { const asked = []; const f = async (port, _t, { host = "127.0.0.1" } = {}) => { asked.push(host); return holders.includes(host); }; f.asked = asked; return f; };
  const B = { host: "127.0.0.1", identifier: null };
  const alive = async () => true; // without operation instanceAlive would find no container - here all live, unless a case says otherwise

  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([A, Bz]), check: probe(["10.0.0.2", "10.0.1.2"]), alive }), B, "two holders: ambiguous, B");
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([A, Bz]), check: probe(["10.0.1.2"]), alive }), { host: "10.0.1.2", identifier: "pB/main" });
  const bHolds = probe(["127.0.0.1", "10.0.0.2"]);
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([A]), check: bHolds, alive }), B);
  assert.deepEqual(bHolds.asked, ["127.0.0.1"], "if B holds the port, no instance is asked");
  const without = probe(["127.0.0.1"]);
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([]), check: without, alive }), B);
  assert.deepEqual(without.asked, [], "without instances no probe - today's way");
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: { all: () => { throw new Error("SQLITE_BUSY"); } }, check: probe([]), alive }), B);
  // only LIVING instances are probed - the address of a dead one (container not running) is not asked.
  const onlyB = probe(["10.0.0.2"]);
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([A, Bz]), check: onlyB, alive: async (x) => x.identifier === "pB/main" }), B,
    "A would hold the port but does not live");
  assert.deepEqual(onlyB.asked, ["127.0.0.1", "10.0.1.2"], "the dead instance is not probed");
  const raises = probe(["10.0.1.2"]);
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: null, targets: targets([A, Bz]), check: raises, alive: async (x) => { if (x.identifier === "pA/main") throw new Error("exec"); return true; } }),
    { host: "10.0.1.2", identifier: "pB/main" }, "a question that throws means \"not living\"");
  const broken = await tunnelTarget({ port: 3000, identifier: "pA/main", targets: { forIdentifier: () => { throw new Error("SQLITE_BUSY"); } } });
  assert.equal(broken.status, 500);
  assert.equal((await tunnelTarget({ port: 3000, identifier: "pA/main", targets: targets([{ ...A, ip: "" }]) })).status, 409);
  assert.deepEqual(await tunnelTarget({ port: 3000, identifier: "", targets: targets([A]), check: probe(["10.0.0.2"]) }), B, "empty is B, without probe");
});

// ── (3) port choice ────────────────────────────────────────────────────────────────────────────────────────────────────

test("(3) /api/ports/free per instance: only the project's claims, occupied means occupied on its IP", async () => {
  const second = await secondLoopback();
  // The port choice first asks whether the instance lives (ports.js instanceAlive = its container is readable): the inside
  // needs a readable /proc/net/tcp for that (only the header line here - the probe on the IP decides, not this list).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-paths-free-"));
  const { inside, programs } = insidePrograms(tmp);
  fs.writeFileSync(path.join(inside, "tcp"), `${PROC_HEADER}\n`);
  const fd = await fakeDocker({ programs });
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const F = await freeSequence(4, ["127.0.0.1", second]);
        const box = await projectWithContainer(ctx, fd, second);
        await createService(ctx, box.p.id, "web", F);
        open.push(await listener(second, F + 1, "INSTANCE\n"), await listener("127.0.0.1", F + 2, "DECOY\n"));
        box.convert();
        const free = (addition) => request(`${ctx.base}/api/ports/free?start=${F}&end=${F + 3}${addition}`);

        const r = await free(`&instance=${encodeURIComponent(box.identifier)}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.port, F + 2, "the decoy on 127.0.0.1 occupies nothing in the instance");
        assert.deepEqual(r.body.skipped.map((u) => u.port), [F]);
        assert.equal(r.body.occupiedWithoutClaim, 1, "the listener on the instance's IP");
        assert.equal(r.body.instance, box.identifier);
        // Without `instance`: B. The claim of a CONVERTED project does not count as occupied in B - F belongs to the shop in its
        // instance and is free on 127.0.0.1.
        const b = await free("");
        assert.equal(b.body.port, F);
        assert.deepEqual(b.body.skipped, [], "in B the search does not skip the converted project's claim");
        assert.equal("instance" in b.body, false);
        assert.equal((await free("&instance=exists-not%2Fmain")).status, 404);
        // An instance whose container does not run (here never started) is not probed - 409 with its identifier, in the wording of
        // `unreachable` in /api/ports/running. Otherwise: 200 with the first port (on an address without a running container
        // every port is "free").
        const tot = await projectWithoutContainer(ctx, "Depot", second);
        const t = await free(`&instance=${encodeURIComponent(tot.identifier)}`);
        assert.equal(t.status, 409, `dead instance: ${t.status} ${JSON.stringify(t.body)}`);
        assert.equal(t.body.instance, tot.identifier);
        assert.equal(t.body.error, `Instanz ${tot.identifier} nicht erreichbar (Container läuft nicht oder fehlt)`);
      });
    });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("(3b) freePort: in an instance the backend port is never free - the number is in the entrypoint", async () => {
  // The entrypoint steers localhost:<port> in the container by OUTPUT-DNAT to the backend - the same number as INSTANCE_BACKEND_PORT.
  const entry = fs.readFileSync(path.resolve(HERE, "..", "projectbox-entry.sh"), "utf8");
  const dnat = [...entry.matchAll(/-A OUTPUT -d 127\.0\.0\.1\/32 -p tcp --dport (\d+) -j DNAT/g)].map((x) => Number(x[1]));
  assert.deepEqual(dnat, [INSTANCE_BACKEND_PORT], "projectbox-entry.sh: OUTPUT DNAT to the backend port");
  // A probe without network: nothing listens (like the probe from B - there it sees only an RST on 7718).
  const nothing = async () => false;
  const P = INSTANCE_BACKEND_PORT;
  const inInstance = await freePort({ start: P, end: P + 1, claims: [], host: "10.230.1.2", check: nothing });
  assert.equal(inInstance.status, 200);
  assert.equal(inInstance.body.port, P + 1, "in the instance the search skips the backend port");
  assert.deepEqual(inInstance.body.reserved?.map((v) => v.port), [P], "and says why");
  assert.equal((await freePort({ start: P, end: P, claims: [], host: "10.230.1.2", check: nothing })).status, 404);
  // Without an instance (B): the port as before - in B the backend itself occupies it, the probe sees that.
  const inB = await freePort({ start: P, end: P + 1, claims: [], check: nothing });
  assert.deepEqual(inB, { status: 200, body: { port: P, skipped: [], skippedTotal: 0, occupiedWithoutClaim: 0 } }, "without an instance today's answer");
  // Below the backend port nothing changes, also in the instance.
  assert.deepEqual((await freePort({ start: 3000, end: 3001, claims: [], host: "10.230.1.2", check: nothing })).body,
    { port: 3000, skipped: [], skippedTotal: 0, occupiedWithoutClaim: 0 });
});

// ── (4) MCP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// Calls the handlers of cbase_ports_running/_free in a process of their own (lib.js reads CBASE_BASE_URL at load) against a
// catcher that records every URL.
async function portToolUrls(env) {
  const urls = [];
  const catcher = http.createServer((req, res) => { urls.push(req.url); res.setHeader("Content-Type", "application/json"); res.end("{}"); });
  await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
  try {
    const script = `import { serviceTools } from ${JSON.stringify(pathToFileURL(SERVICES_TOOLS).href)};
const t = (n) => serviceTools.find((x) => x.name === n);
await t("cbase_ports_running").handler({ ports: "3000" });
await t("cbase_ports_free").handler({ start: 3000 });`;
    await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CBASE_BASE_URL: `http://127.0.0.1:${catcher.address().port}`, ...env },
    }, (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve())));
  } finally {
    catcher.closeAllConnections?.();
    await new Promise((r) => catcher.close(r));
  }
  return urls;
}

// What the handler of cbase_ports_running returns to the model when the server delivers `response` (own process, as above).
async function portsRunningResult(response) {
  const catcher = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(response)); });
  await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
  try {
    const script = `import { serviceTools } from ${JSON.stringify(pathToFileURL(SERVICES_TOOLS).href)};
process.stdout.write(JSON.stringify(await serviceTools.find((x) => x.name === "cbase_ports_running").handler({ ports: "3000" })));`;
    return await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CBASE_BASE_URL: `http://127.0.0.1:${catcher.address().port}` },
    }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(out)))));
  } finally {
    catcher.closeAllConnections?.();
    await new Promise((r) => catcher.close(r));
  }
}

test("(4) MCP: the identifier travels in CBASE_INSTANCE, and the port tools send it along", async () => {
  const inst = { projectId: "pT", instance: "main", identifier: "pT/main" };
  setBackendAccess(() => ({ backendUrl: "http://10.249.3.1:7718", token: "t".repeat(64) }));
  try {
    assert.equal(backendAccessFor(inst).instance, "pT/main");
    assert.deepEqual(backendAccessFor(null), {}, "without an instance nothing");
  } finally { setBackendAccess(null); }
  await withAgentsServer(async (ctx) => {
    const file = path.join(ctx.root, "mcp.json");
    const opts = { projectId: "pT", workspaceId: ctx.ws.id, chatId: ctx.chat.id, extraServers: [], headless: true, toolset: "", tools: null, skills: [], vision: true };
    writeMcpConfig(file, { ...opts, instance: "pT/main" });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.cbase.env.CBASE_INSTANCE, "pT/main");
    writeMcpConfig(file, opts);
    assert.equal("CBASE_INSTANCE" in JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.cbase.env, false, "without an instance it is missing");
  });
  assert.deepEqual(await portToolUrls({ CBASE_INSTANCE: "pT/main" }), [
    "/api/ports/running?ports=3000&instance=pT%2Fmain",
    "/api/ports/free?start=3000&instance=pT%2Fmain",
  ]);
  assert.deepEqual(await portToolUrls({}), ["/api/ports/running?ports=3000", "/api/ports/free?start=3000"], "without an instance today's URL");
  // `unreachable` means "an unchecked space is not an empty one" (findingsComplete is then false). The reading is in the
  // ANSWER exactly when it carries `unreachable`; the description only says that an empty findings list without
  // findingsComplete is no acquittal.
  const { serviceTools, portsInterpretation } = await import(pathToFileURL(SERVICES_TOOLS).href);
  const description = serviceTools.find((x) => x.name === "cbase_ports_running").description;
  assert.match(description, /findingsComplete/);
  assert.match(description, /`interpretation`/);
  const including = portsInterpretation({ open: [], findings: [], findingsComplete: false, unreachable: ["pT/copy-a"] });
  assert.ok(including.interpretation.some((z) => /^unreachable = .*not an empty one/.test(z)), JSON.stringify(including.interpretation));
  assert.equal(portsInterpretation({ open: [], findings: [], findingsComplete: true, unreachable: [] }).interpretation, undefined, "without the field no reading");
  // The handler appends it - that is the way the model sees it.
  const result = await portsRunningResult({ open: [], findings: [], findingsComplete: false, unreachable: ["pT/copy-a"] });
  assert.ok(result.interpretation?.some((z) => /not an empty one/.test(z)), JSON.stringify(result));
  assert.deepEqual(result.unreachable, ["pT/copy-a"], "the server's answer stays whole");
});

// ── (5) fence ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(5) Fence: from a project network port list and port choice ask only the own instance's namespace", () => {
  const instance = { projectId: "pA", instance: "main", identifier: "pA/main" };
  const view = { project: (id) => (id === "pA" ? { id: "pA", workspaceId: "w1", path: "/ws/a" } : null) };
  for (const family of ["ports-running", "ports-free"]) {
    const row = FENCE_TABLE.find((z) => z.family === family);
    const without = new URLSearchParams("ports=3000");
    assert.deepEqual(checkScope({ instance, row, query: without }, view), { ok: true }, family);
    assert.equal(without.get("instance"), "pA/main", `${family}: added`);
    const own = new URLSearchParams("instance=pA%2Fmain");
    assert.deepEqual(checkScope({ instance, row, query: own }, view), { ok: true });
    for (const foreign of ["instance=pB%2Fmain", "instance="]) {
      const r = checkScope({ instance, row, query: new URLSearchParams(foreign) }, view);
      assert.equal(r.ok, false, `${family} ${foreign}`);
      assert.match(r.reason, /\?instance: only the value of this project/);
    }
  }
});

// ── (6) copies: every instance gets the claims of its project ───────────────────────────────────────────────

test("(6) claimsPerSpace: main and copy carry their project's claims, one instance per project as before", () => {
  const a = { projectId: "pA", port: 3000 };
  const b = { projectId: "pB", port: 3001 };
  const main = { projectId: "pA", identifier: "pA/main" };
  const copy = { projectId: "pA", identifier: "pA/copy-k1" };
  const two = claimsPerSpace([a, b], [main, copy]);
  assert.deepEqual([...two.entries()], [[null, [b]], ["pA/main", [a]], ["pA/copy-k1", [a]]]);
  // One instance per project - the same map as before.
  assert.deepEqual([...claimsPerSpace([a, b], [main]).entries()], [[null, [b]], ["pA/main", [a]]]);
  assert.deepEqual([...claimsPerSpace([a, b]).entries()], [[null, [a, b]]]);
});

test("(6) /api/ports/running?instance=<copy>: the copy's port is registered, no \"unregistered\"", async () => {
  const second = await secondLoopback();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-network-paths-"));
  const { inside, programs } = insidePrograms(tmp);
  const fd = await fakeDocker({ programs });
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const P = await freeSequence(1, [second]);
        const box = await projectWithContainer(ctx, fd, second);
        const web = await createService(ctx, box.p.id, "web", P);
        box.convert();
        const copyContainer = `cbase-k-${box.p.id}-k1`;
        execFileSync(fd.bin, ["run", "-d", "--name", copyContainer, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: box.p.id, instance: "copy-k1", state: "ready", convertedAt: Date.now(), containerId: copyContainer, ip: second });
        const copy = `${box.p.id}/copy-k1`;
        open.push(await listener(second, P, "COPY\n"));
        fs.writeFileSync(path.join(inside, "tcp"), [PROC_HEADER, procRow(0, P, 454545), ""].join("\n"));
        const list = (query) => request(`${ctx.base}/api/ports/running?${query}`);

        for (const identifier of [copy, box.identifier]) {
          const r = await list(`ports=${P}&instance=${encodeURIComponent(identifier)}`);
          assert.equal(r.status, 200, JSON.stringify(r.body));
          assert.deepEqual(r.body.open.map((e) => [e.port, e.instance]), [[P, identifier]]);
          assert.equal(r.body.open[0].registered?.id, web.id, `${identifier}: the project's service holds in this instance`);
          assert.deepEqual(r.body.findings.filter((b) => b.kind === "unregistered"), [], `${identifier}: no "unregistered"`);
        }
        // Light (pill): per space its claims - main and copy both name the service.
        const light = await list("registered=1");
        assert.deepEqual(light.body.open.map((e) => [e.port, e.instance, e.registered?.id]).sort((x, y) => String(x[1]).localeCompare(String(y[1]))),
          [[P, copy, web.id], [P, box.identifier, web.id]]);
      });
    });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (7) MCP: start, stop and log of a service send the chat's instance ─────────────────────────────────

// Calls the handlers of cbase_service_log/_start/_stop in a process of their own against a catcher that delivers the service
// list (service 5 in project pT, workspace w1) and records every URL.
async function serviceToolUrls(env) {
  const urls = [];
  const catcher = http.createServer((req, res) => {
    urls.push(`${req.method} ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/project-services") res.end(JSON.stringify([{ id: 5, projectId: "pT", workspaceId: "w1" }]));
    else if (req.url === "/api/projects" || req.url === "/api/workspaces") res.end("[]");
    else res.end(JSON.stringify({ log: "x" }));
  });
  await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
  try {
    const script = `import { serviceTools } from ${JSON.stringify(pathToFileURL(SERVICES_TOOLS).href)};
const t = (n) => serviceTools.find((x) => x.name === n);
await t("cbase_service_log").handler({ id: 5 });
await t("cbase_service_start").handler({ id: 5 });
await t("cbase_service_stop").handler({ id: 5 });`;
    await new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CBASE_BASE_URL: `http://127.0.0.1:${catcher.address().port}`, CBASE_WORKSPACE_ID: "w1", ...env },
    }, (err, _out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve())));
  } finally {
    catcher.closeAllConnections?.();
    await new Promise((r) => catcher.close(r));
  }
  return urls.filter((u) => u.includes("/services/"));
}

test("(7) MCP: start, stop and log of a service send the chat's instance - only for a service of their project", async () => {
  assert.deepEqual(await serviceToolUrls({ CBASE_INSTANCE: "pT/copy-k1" }), [
    "GET /api/projects/pT/services/5/log?instance=pT%2Fcopy-k1",
    "POST /api/projects/pT/services/5/start?instance=pT%2Fcopy-k1",
    "POST /api/projects/pT/services/5/stop?instance=pT%2Fcopy-k1",
  ]);
  const today = ["GET /api/projects/pT/services/5/log", "POST /api/projects/pT/services/5/start", "POST /api/projects/pT/services/5/stop"];
  assert.deepEqual(await serviceToolUrls({ CBASE_INSTANCE: "pX/main" }), today, "a service of another project: without instance");
  assert.deepEqual(await serviceToolUrls({}), today, "without an instance today's URL");
});
