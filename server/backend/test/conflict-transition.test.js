// Conflicts in the transition. Until all projects are relocated, two worlds live side by side: unconverted projects share B's
// loopback and can fight over a port (conflict display and old prompt sentence stay); a converted one listens in its own
// namespace, its ports belong to it, nothing is reassigned.
//
// The setup, without a clock: a real server (agent-harness.mjs withAgentsServer), ops marker and fake docker AFTER the start
// (fake-docker.mjs — only so that an accidental docker call would show: no path needs one except the liveness question of the
// port list, ports#2), projects and services through the real routes, "converted" is the instance row with `converted_at`
// (store), its IP the second loopback address (127.0.0.2, ::1 on macOS). A DECOY on 127.0.0.1 at the same port shows that a probe
// at the instance does not land in B.
//
// The promises, each with the way that breaks it:
//   (1) ONE computation without converted projects: two projects with the same port, one converted => /api/ports/conflicts empty,
//       no "conflict" finding in /api/ports/running, /api/ports/free does not count the converted one's port as taken, and
//       GET /api/ports carries the hint on its claims. Before (no row) and without an ops marker everything is as before —
//       conflict, taken, no hint — and no docker call.
//   (2) PATCH /api/project-services/:id (cbase_service_update): on a converted project's service a new port without a listener in
//       the instance => 409 (the decoy on 127.0.0.1 does not count), `null` => 409, a port with a listener in the instance =>
//       accepted, with hint; an unconverted project and operation without a marker as before. Plus the tool itself in its own
//       process (with the workspace barrier, like every chat): hint in the result, rejection as error text.
//   (3) cbase_ports_list passes the hint through — also on an entry of a foreign workspace, which otherwise shows only
//       `{port, external}`.
//   (4) Only ONE place in the backend computes conflicts (store/projects.js), and every caller names the set of converted
//       projects (a call without it would throw only at runtime) — with built-in sabotage.
//
// Counter-tests (which sabotage turns which test red):
//   store/projects.js + projects/routes.js without the filter (all claims into the computation)  => (1) red: conflict stays, port taken
//   projectbox/transition.js portChange "reject every port change on a converted one"             => (2) red: the port with a listener gets 409
//   projectbox/transition.js portChange without `host` (checkPort on 127.0.0.1)                   => (2) red: the decoy is accepted
//   mcp/tools/services.js in the old state                                                        => (3) red: the foreign entry without hint
// Every `finally` closes connections and listeners; the server closes through the harness (closeAllConnections before close).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as store from "../electron/server/store.js";
import { PORT_HINT } from "../electron/server/projectbox/transition.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker, secondLoopback } from "./fake-docker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..", "electron", "server");
const SERVICES_TOOLS = path.resolve(HERE, "..", "electron", "mcp", "tools", "services.js");

// ── Helpers (a test file never imports another) ────────────────────────────────────────────────────────────

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

async function request(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const patch = (ctx, id, body) => request(`${ctx.base}/api/project-services/${id}`, { method: "PATCH", body: JSON.stringify(body) });

function listener(host, port) {
  return new Promise((resolve, reject) => {
    const socks = new Set();
    const srv = net.createServer((s) => { socks.add(s); s.on("close", () => socks.delete(s)); s.on("error", () => {}); });
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
// n consecutive ports that are free on ALL addresses (the port choice searches upward).
async function freeSequence(n, addresses) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = 42000 + Math.floor(Math.random() * 16000);
    let gut = true;
    for (let i = 0; i < n && gut; i++) for (const a of addresses) if (!(await bindable(a, base + i))) { gut = false; break; }
    if (gut) return base;
  }
  throw new Error("no free port sequence found");
}

async function project(ctx, name) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  return ctx.projectWithoutInstance({ name, path: filePath });
}
const service = (ctx, projectId, name, port) =>
  json(`${ctx.base}/api/project-services`, { method: "POST", body: JSON.stringify({ projectId, name, port, kind: "frontend" }) });
const convert = (projectId, ip) =>
  store.createProjectInstance({ projectId, state: "ready", convertedAt: Date.now(), containerId: `cbase-p-${projectId}`, ip });
const conflictPorts = (running) => running.findings.filter((b) => b.kind === "conflict").map((b) => b.port);

// A tool of the MCP in its own process (lib.js reads CBASE_BASE_URL at load): `{ result }` or `{ error }`.
function tool(name, args, env) {
  const script = `import { serviceTools } from ${JSON.stringify(pathToFileURL(SERVICES_TOOLS).href)};
try { console.log(JSON.stringify({ result: await serviceTools.find((x) => x.name === ${JSON.stringify(name)}).handler(${JSON.stringify(args)}) })); }
catch (e) { console.log(JSON.stringify({ error: String(e?.message || e) })); }`;
  return new Promise((resolve, reject) => execFile(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  }, (err, out, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(String(out).trim().split("\n").pop())))));
}

// A fake CLI that ends every turn at once (no case here starts one; the harness needs one).
const claude = fakeClaude({ main: `
  finished();
  say({ type: "result", result: "ok", session_id: "s-reg" });` });

// ── (1) The one computation ──────────────────────────────────────────────────────────────────────

test("two projects, same port, one converted: no conflict, the port is free in B, the claim carries the hint", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const P = await freeSequence(2, ["127.0.0.1", second]); // P: Till AND Warehouse; P+1: Till only
        const till = await project(ctx, "Till");
        const lager = await project(ctx, "Warehouse");
        await service(ctx, till.id, "web", P);
        await service(ctx, till.id, "api", P + 1);
        await service(ctx, lager.id, "web", P);
        const situation = async () => ({
          conflicts: (await request(`${ctx.base}/api/ports/conflicts`)).body,
          running: (await request(`${ctx.base}/api/ports/running?registered=1`)).body,
          free: await request(`${ctx.base}/api/ports/free?start=${P}&end=${P + 1}`),
          ports: (await request(`${ctx.base}/api/ports`)).body,
        });

        // Before (operation, no instance row): today's computation.
        const prior = await situation();
        assert.deepEqual(prior.conflicts[till.id].items, [{ port: P, name: "web", owner: "Warehouse" }]);
        assert.deepEqual(prior.conflicts[lager.id].items, [{ port: P, name: "web", owner: "Till" }]);
        assert.deepEqual(conflictPorts(prior.running), [P]);
        assert.equal(prior.free.status, 404, "both ports claimed");
        assert.deepEqual(prior.ports, store.listScannedPorts(), "GET /api/ports is today's list, without a hint");

        convert(till.id, second);
        const after = await situation();
        assert.deepEqual(after.conflicts, {}, "no conflict: the converted project drops out of the computation — and its partner with it");
        assert.deepEqual(conflictPorts(after.running), [], "no \"conflict\" finding in the port list");
        assert.equal(after.free.status, 200, JSON.stringify(after.free.body));
        assert.equal(after.free.body.port, P + 1, "P+1 belongs only to the converted project — not taken in B");
        assert.deepEqual(after.free.body.skipped.map((u) => [u.port, u.project]), [[P, "Warehouse"]], "P stays taken: Warehouse is not converted");
        const hints = after.ports.map((a) => [a.port, a.projectName, "hint" in a ? a.hint : "—"]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
        assert.deepEqual(hints, [[P, "Till", PORT_HINT], [P, "Warehouse", "—"], [P + 1, "Till", PORT_HINT]], "every claim of Till carries the hint, Warehouse does not");

        // Without an ops marker: the same row, but no operation — everything as before.
        await withEnvironment(withoutOps, async () => {
          const without = await situation();
          assert.deepEqual(without.conflicts[till.id]?.items, [{ port: P, name: "web", owner: "Warehouse" }]);
          assert.deepEqual(conflictPorts(without.running), [P]);
          assert.equal(without.free.status, 404);
          assert.deepEqual(without.ports, store.listScannedPorts());
        });
      });
      // Only exception since ports#2: the port list asks whether the instance IS ALIVE (`cat /proc/net/tcp…` as agent — there is no
      // container here, so it is "unreachable" and not probed). The conflict computation needs none.
      const liveQuestion = (a) => a.args.slice(0, 3).join(" ") === "exec -u agent" && a.args[4] === "cat";
      assert.deepEqual(fd.calls().filter((a) => !liveQuestion(a)), [], "no docker call on any path (except the port list's liveness question)");
    }, { claude });
  } finally {
    fd.cleanUp();
  }
});

// ── (2) cbase_service_update ─────────────────────────────────────────────────────────────────────

test("service_update on a converted project: rejected without a listener in the instance, accepted with one", async () => {
  const second = await secondLoopback();
  const fd = await fakeDocker();
  const open = [];
  try {
    await withAgentsServer(async (ctx) => {
      await withEnvironment(ops(fd), async () => {
        const P = await freeSequence(3, ["127.0.0.1", second]); // P: registered; P+1: only a decoy in B; P+2: listens in the instance
        const Q = P + 1;
        const R = P + 2;
        const till = await project(ctx, "Till");
        const lager = await project(ctx, "Warehouse");
        const kWeb = await service(ctx, till.id, "web", P);
        const lWeb = await service(ctx, lager.id, "web", P);
        open.push(await listener("127.0.0.1", Q), await listener(second, R));
        convert(till.id, second);

        const withoutListener = await patch(ctx, kWeb.id, { port: Q });
        assert.equal(withoutListener.status, 409, JSON.stringify(withoutListener.body));
        assert.match(withoutListener.body.error, new RegExp(`nothing listens on ${Q}`));
        assert.ok(withoutListener.body.error.startsWith(PORT_HINT), "the rejection carries the hint");
        assert.equal(store.getProjectService(kWeb.id).port, P, "nothing changed — the decoy on 127.0.0.1 does not count");
        const struck = await patch(ctx, kWeb.id, { port: null });
        assert.equal(struck.status, 409);
        assert.equal(store.getProjectService(kWeb.id).port, P);

        const withListener = await patch(ctx, kWeb.id, { port: R });
        assert.equal(withListener.status, 200, JSON.stringify(withListener.body));
        assert.equal(withListener.body.port, R, "the listener in the instance: the registration follows");
        assert.equal(withListener.body.hint, PORT_HINT);
        const onlyCommand = await patch(ctx, kWeb.id, { startCommand: "npm run dev", port: R });
        assert.equal(onlyCommand.status, 200, "the same port is no change");
        assert.equal(onlyCommand.body.hint, PORT_HINT, "the response carries the hint even without a port change");

        const b = await patch(ctx, lWeb.id, { port: Q });
        assert.equal(b.status, 200, "an unconverted project as before");
        assert.equal(b.body.port, Q);
        assert.equal("hint" in b.body, false);

        // The tool itself (with the chat's workspace barrier): hint in the result, rejection as error.
        const env = { CBASE_BASE_URL: ctx.base, CBASE_WORKSPACE_ID: ctx.ws.id };
        const yes = await tool("cbase_service_update", { id: kWeb.id, port: R, description: "Till web" }, env);
        assert.equal(yes.result?.hint, PORT_HINT, JSON.stringify(yes));
        const no = await tool("cbase_service_update", { id: kWeb.id, port: Q }, env);
        assert.match(String(no.error), /ports are not reassigned/, JSON.stringify(no));

        // Without an ops marker: today's path — the change goes through, without a hint.
        await withEnvironment(withoutOps, async () => {
          const o = await patch(ctx, kWeb.id, { port: Q });
          assert.equal(o.status, 200);
          assert.equal("hint" in o.body, false);
        });
      });
      assert.deepEqual(fd.calls(), [], "no docker call");
    }, { claude });
  } finally {
    for (const l of open) await l.close();
    fd.cleanUp();
  }
});

// ── (3) cbase_ports_list ──────────────────────────────────────────────────────────────────────

test("cbase_ports_list passes the hint through — also on the entry of a foreign workspace", async () => {
  const list = [
    { id: 1, port: 3000, projectId: "pK", projectName: "Till", workspaceId: "w1", name: "web", hint: "H" },
    { id: 2, port: 3000, projectId: "pF", projectName: "Foreign", workspaceId: "w2", name: "web", hint: "H" },
    { id: 3, port: 3001, projectId: "pG", projectName: "Guest", workspaceId: "w2", name: "web" },
  ];
  const catcher = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/api/ports" ? list : []));
  });
  await new Promise((r) => catcher.listen(0, "127.0.0.1", r));
  try {
    const r = await tool("cbase_ports_list", {}, { CBASE_BASE_URL: `http://127.0.0.1:${catcher.address().port}`, CBASE_WORKSPACE_ID: "w1" });
    assert.deepEqual(r.result, [list[0], { port: 3000, external: true, hint: "H" }, { port: 3001, external: true }]);
  } finally {
    catcher.closeAllConnections?.();
    await new Promise((r) => catcher.close(r));
  }
});

// ── (4) One place ────────────────────────────────────────────────────────────────────────

// The signature of the conflict computation: a set of a port's project ids and its size against 1 or 2.
const COMPUTATION = /new Set\([^;\n]*?\.projectId\)\)\.size\s*(?:[<>]=?|={2,3})\s*[12]\b/;
// Calls of the computation without an argument (the set of converted projects is missing).
const WITHOUT_SET = /\b(?:projectPortConflicts|portConflicts)\(\s*\)/;
function where(files, pattern) {
  return files.filter(({ text }) => pattern.test(text)).map(({ rel }) => rel);
}
function jsFiles(root) {
  const out = [];
  const run = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") run(p); } else if (e.name.endsWith(".js")) out.push({ rel: path.relative(root, p), text: fs.readFileSync(p, "utf8") });
    }
  };
  run(root);
  return out;
}

test("only store/projects.js computes conflicts, and every caller names the set of converted projects", () => {
  // Built-in sabotage: the old computation of the routes and of the registration agent, and a call without the set.
  const sabotage = [
    { rel: "old/routes.js", text: "if (new Set(arr.map((a) => a.projectId)).size < 2) continue;" },
    { rel: "old/app-agents.js", text: ".filter(([, arr]) => new Set(arr.map((a) => a.projectId)).size > 1)" },
    { rel: "old/scans.js", text: "const conflicts = store.projectPortConflicts()[proj.id] ?? [];" },
    { rel: "good.js", text: "store.projectPortConflicts(convertedProjects())" },
  ];
  assert.deepEqual(where(sabotage, COMPUTATION), ["old/routes.js", "old/app-agents.js"]);
  assert.deepEqual(where(sabotage, WITHOUT_SET), ["old/scans.js"]);

  const tree = [...jsFiles(SERVER), ...jsFiles(path.resolve(SERVER, "..", "mcp"))];
  assert.ok(tree.length > 100, `tree read: ${tree.length} files`);
  assert.deepEqual(where(tree, COMPUTATION), [path.join("store", "projects.js")], "the ONE computation");
  assert.deepEqual(where(tree, WITHOUT_SET), [], "no call without the set of converted projects");
  // And without the set it throws — loudly instead of silently the earlier state.
  assert.throws(() => store.portConflicts(undefined, []), /without the set of converted projects/);
  assert.throws(() => store.projectPortConflicts(), /without the set of converted projects/);
});
