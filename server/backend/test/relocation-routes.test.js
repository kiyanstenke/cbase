// The relocation routes (projectbox/relocation/routes.js, a sub-slice of projectRoutes) over the main seam `withAgentsServer` and
// the fake docker (fake-docker.mjs).
//
// What holds here:
//   (1) Without the operating marks, GET .../relocation/plan, POST .../relocation, GET .../relocation and POST
//       .../relocation/resume answer 404 "only in server mode" - no docker call, the procedure is never called.
//   (2) The plan route collects over the REAL seam (projectbox/docker.js -> fake docker program) and plans: the container
//       under the project folder is in the plan, no "data-missing", and the answer carries no `.env*` value and no value
//       of the MCP environment (counter-proof: both values stand in the fixture resp. the store and are found there).
//   (3) From a project network: without a token 401 (before any docker), with a valid token of the own instance 403 with the
//       row "project-relocation" - counter-proof: the same instance gets the scope for a released project route (context); so
//       the 403 comes from the row, not from an invalid instance.
//   (4) POST with an injected fake of the procedure (test seam `setRelocationProcedure`) that holds lock and heavy load like
//       the real one and stands at a gate: 202 with the state; meanwhile `busy:true` with `projectWork`, a second POST is 409
//       (heavy load), a message to a chat of the project starts NO turn (queued/locked, runs 0); after the gate the turn
//       runs. An open journal without a living procedure is also 409 (RELOCATION_RUNNING).
//   (5) The half relocation of ANOTHER project, which the restart has not yet decided on, stops POST .../relocation (409
//       RELOCATION_ELSEWHERE with a way out) - the restart of the half one would otherwise find the heavy load taken. A failed
//       decider leaves reason and way out (row `hold-resume`, `state.resumeError`, `state.wayOut`) and frees the other
//       projects; POST .../relocation/resume is the second way (real procedure without an open journal: 409
//       NO_OPEN_RELOCATION).
//   (6) The POST body carries the receipts (`receiptsFromBody`); an empty body means none, any other form is a 400 before the
//       procedure is called - never silently "no receipt".
// No clock: waiting is on gates, events and quiet (quiet.mjs), never on a duration.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { ONLY_IN_OPS } from "../electron/server/projectbox/ops.js";
import { instancesRestartGrace, setRelocationDecider, relocationResumeError } from "../electron/server/projectbox/instances.js";
import { projectLocks } from "../electron/server/projectbox/idle.js";
import { withHeavyLoad, heavyLoadStatus } from "../electron/server/projectbox/heavyLoad.js";
import { receiptsFromBody, setRelocationProcedure } from "../electron/server/projectbox/relocation/routes.js";
import { setFenceSource, fenceVerdict } from "../electron/server/projectbox/fence.js";
import { fakeDocker } from "./fake-docker.mjs";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { setProcessSeam } from "../electron/server/projectbox/relocation/processes.js";
import { emptyProc } from "./fake-proc.mjs";

// Plan and step 4 read /proc (projectbox/relocation/processes.js) - here a fake one holding only B (macOS has none;
// without a look at the processes the plan would stop with data-missing).
const EMPTY_PROC = emptyProc();
setProcessSeam({ root: EMPTY_PROC, quietMs: 0 });
test.after(() => fs.rmSync(EMPTY_PROC, { recursive: true, force: true }));

const SECRET_ENV = "routes-secret-5150";
const SECRET_MCP = "routes-mcp-secret-77";

async function withEnvironment(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const ops = (fd) => ({ CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin });
const withoutOps = (fd) => ({ CBASE_CONTAINER: undefined, CBASE_DIND: undefined, CBASE_DOCKER_BIN: fd.bin });

async function raw(url, init = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body, text };
}

async function project(ctx, name, { withChat = false } = {}) {
  const filePath = path.join(ctx.root, "workspace", name.toLowerCase());
  fs.mkdirSync(filePath, { recursive: true });
  const p = await json(`${ctx.base}/api/workspaces/${ctx.ws.id}/projects`, { method: "POST", body: JSON.stringify({ name, path: filePath }) });
  if (withChat) await json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
  return { p, path: filePath };
}

// A fake of the procedure with the contract `{ startRelocation, relocationStatus }` that holds what the real one holds (lock, heavy load).
function wrongProcedure() {
  let open;
  const gate = new Promise((r) => { open = r; });
  const state = new Map();
  const started = [];
  const receipts = [];
  return {
    started, receipts, open,
    // Like the real one: `started` reports as soon as "the journal stands" - the route answers only then.
    async startRelocation(pid, { started: journalStands, acknowledged } = {}) {
      started.push(pid);
      receipts.push(acknowledged);
      const s = projectLocks(pid, { reason: "relocation" });
      if (!s.ok) throw Object.assign(new Error("not idle"), { code: "LOCKED" });
      try {
        await withHeavyLoad("relocation", { projectId: pid }, async () => {
          state.set(pid, { phase: "running" });
          journalStands?.({ id: 0, location: null });
          await gate;
          state.set(pid, { phase: "finished" });
        });
      } finally { s.resolve(); }
    },
    relocationStatus: (pid) => ({ projectId: pid, ...(state.get(pid) || { phase: "none" }) }),
  };
}

const PATHS = (pid) => [["GET", `/api/projects/${pid}/relocation/plan`], ["POST", `/api/projects/${pid}/relocation`], ["GET", `/api/projects/${pid}/relocation`],
  ["POST", `/api/projects/${pid}/relocation/resume`]];

test("(1) without operating marks 404 \"only in server mode\" on all four routes - no docker, no procedure", async () => {
  const fd = await fakeDocker();
  const procedure = wrongProcedure();
  setRelocationProcedure(procedure);
  try {
    await withAgentsServer(async (ctx) => {
      const { p } = await project(ctx, "Without");
      await withEnvironment(withoutOps(fd), async () => {
        for (const [m, filePath] of PATHS(p.id)) {
          const r = await raw(`${ctx.base}${filePath}`, { method: m });
          assert.deepEqual([r.status, r.body.error], [404, ONLY_IN_OPS], `${m} ${filePath}`);
        }
      });
      assert.deepEqual(fd.calls(), [], "no docker");
      assert.deepEqual(procedure.started, [], "the procedure was not called");
    });
  } finally {
    setRelocationProcedure(null);
    fd.cleanUp();
  }
});

test("(2) plan route: collects over the real seam and plans - container in the plan, no data-missing, no .env or MCP value in the answer", async () => {
  const fd = await fakeDocker({ images: { "demo-web:1": crypto.createHash("sha256").update("image").digest("hex") } });
  try {
    await withAgentsServer(async (ctx) => {
      const { p, path: filePath } = await project(ctx, "Demo");
      fs.writeFileSync(path.join(filePath, "docker-compose.yml"), "services:\n  web:\n    image: demo-web:1\n");
      fs.writeFileSync(path.join(filePath, ".env"), `SECRET=${SECRET_ENV}\n`);
      const now = Date.now();
      store.createMcpServer({ id: crypto.randomUUID(), workspaceId: ctx.ws.id, projectId: p.id, name: "tool", command: "node", args: [], env: { TOKEN: SECRET_MCP }, createdAt: now, updatedAt: now });
      const labels = {
        "com.docker.compose.project": "demo", "com.docker.compose.project.working_dir": filePath,
        "com.docker.compose.project.config_files": path.join(filePath, "docker-compose.yml"), "com.docker.compose.service": "web",
        "com.docker.compose.config-hash": "abc", "com.docker.compose.oneoff": "False",
      };
      execFileSync(fd.bin, ["run", "-d", "--name", "demo-web-1", ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]), "demo-web:1"], { env: { ...process.env, ...fd.env } });
      const prior = fd.calls().length;

      await withEnvironment(ops(fd), async () => {
        const r = await raw(`${ctx.base}/api/projects/${p.id}/relocation/plan`);
        assert.equal(r.status, 200, r.text);
        const { plan } = r.body;
        assert.deepEqual(Object.keys(r.body), ["plan"], "the answer is ONLY the plan - no raw data");
        assert.deepEqual(plan.container.map((c) => c.name), ["demo-web-1"]);
        assert.deepEqual([...plan.holdReasons, ...plan.hints].filter((x) => x.kind === "data-missing"), []);
        assert.equal(r.text.includes(SECRET_ENV), false, "a .env value is in the answer");
        assert.equal(r.text.includes(SECRET_MCP), false, "a value of the MCP environment is in the answer");
      });
      // Counter-proof: the values exist - in the fixture and in the store - the search above would have found them.
      assert.ok(fs.readFileSync(path.join(filePath, ".env"), "utf8").includes(SECRET_ENV));
      assert.ok(JSON.stringify(store.listProjectMcpServers(p.id)).includes(SECRET_MCP));
      const commands = new Set(fd.calls().slice(prior).map((a) => a.args.slice(0, 2).join(" ")));
      const webId = Object.values(fd.state().container).find((c) => c.name === "demo-web-1").id;
      for (const b of ["ps -a", "inspect --type", "images -q", "image inspect", "volume ls", "system df", "network ls", `diff ${webId}`]) {
        assert.ok(commands.has(b), `${b} missing in the log: ${JSON.stringify([...commands])}`);
      }
    });
  } finally { fd.cleanUp(); }
});

test("(3) from a project network: without a token 401 before any docker; with the own instance's token 403 from the row \"project-relocation\" (counter-proof: context route in scope)", async () => {
  const fd = await fakeDocker();
  try {
    await withAgentsServer(async (ctx) => {
      const { p } = await project(ctx, "Network");
      setFenceSource(() => "10.230.9.9");
      try {
        await withEnvironment(ops(fd), async () => {
          for (const [m, filePath] of PATHS(p.id)) {
            const r = await raw(`${ctx.base}${filePath}`, { method: m });
            assert.equal(r.status, 401, `${m} ${filePath}: ${r.text}`);
          }
        });
      } finally { setFenceSource(null); }
      assert.deepEqual(fd.calls(), [], "the fence rejects before any docker");
    });
  } finally { fd.cleanUp(); }

  const instance = { projectId: "p1", instance: "main", identifier: "p1/main", subnet: "10.230.9.0/24" };
  const verdict = (method, filePath) => fenceVerdict({ source: "10.230.9.9", token: "t", method, path: filePath, instances: [instance], identifierOfToken: () => "p1/main" });
  for (const [m, filePath] of PATHS("p1")) {
    const u = verdict(m, filePath);
    assert.equal(u.verdict, "403", `${m} ${filePath}: ${JSON.stringify(u)}`);
    assert.equal(u.row?.family, "project-relocation", `${m} ${filePath}: the row "project-relocation" must be it, not "no row"`);
    assert.match(u.reason, /relocation of a project/);
  }
  assert.equal(verdict("GET", "/api/projects/p1/context").verdict, "scope", "counter-proof: the same instance is valid, only the relocation is rejected");
});

test("(4) POST with an injected procedure: 202 with state; meanwhile busy + projectWork, second POST 409, a message starts no turn; afterwards it runs; open journal => 409", async () => {
  const fd = await fakeDocker();
  const procedure = wrongProcedure();
  setRelocationProcedure(procedure);
  try {
    await withAgentsServer(async (ctx) => {
      const { p } = await project(ctx, "Relocation", { withChat: true });
      await withEnvironment(ops(fd), async () => {
        const r = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST" });
        assert.equal(r.status, 202, r.text);
        assert.deepEqual(r.body, { started: true, state: { projectId: p.id, phase: "running" } });
        assert.deepEqual(procedure.started, [p.id]);

        const active = await json(`${ctx.base}/api/runs/active`);
        assert.equal(active.busy, true, "a relocation holds deploy and reaper");
        assert.deepEqual(active.projectWork.map((e) => [e.projectId, e.state, e.phase]), [[p.id, "heavyLoad", "relocation"]]);

        const second = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST" });
        assert.deepEqual([second.status, second.body.code], [409, "HEAVY_LOAD_OCCUPIED"], second.text);
        assert.deepEqual(procedure.started, [p.id], "the second POST starts nothing");
        const state = await raw(`${ctx.base}/api/projects/${p.id}/relocation`);
        assert.deepEqual([state.status, state.body.state.phase], [200, "running"]);

        const n = await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "DURING-THE-RELOCATION" }) });
        assert.equal(n.queued, true, JSON.stringify(n));
        assert.equal(n.locked, true, JSON.stringify(n));
        assert.equal((await json(`${ctx.base}/api/runs/active`)).runs, 0, "no turn during the relocation");

        procedure.open();
        await waitForTruthy(() => heavyLoadStatus() === null, "heavy load free");
        await waitForTruthy(async () => {
          const log = await json(`${ctx.base}/api/chats/${ctx.chat.id}/log`);
          const i = log.findIndex((m) => m.role === "user" && String(m.text).includes("DURING-THE-RELOCATION"));
          return i >= 0 && log.slice(i + 1).some((m) => m.role === "assistant");
        }, "the queued turn after the relocation");
        await ctx.waitForQuiet();
        assert.equal((await json(`${ctx.base}/api/runs/active`)).busy, false);

        // An open journal without a living procedure (e.g. after a crash): no second relocation for the same project.
        const j = store.createRelocation({ projectId: p.id, instance: "main", location: path.join(ctx.root, "relocation-location") });
        try {
          const open = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST" });
          assert.deepEqual([open.status, open.body.code], [409, "RELOCATION_RUNNING"], open.text);
          assert.deepEqual(procedure.started, [p.id]);
        } finally { store.endRelocation(j.id, "aborted"); }
      });
    });
  } finally {
    setRelocationProcedure(null);
    fd.cleanUp();
  }
});

test("(5) half relocation of another project => 409 RELOCATION_ELSEWHERE until decided; failed decider => reason, way out, release; POST .../relocation/resume", async () => {
  const fd = await fakeDocker();
  const procedure = wrongProcedure();
  const resumed = [];
  procedure.resumeRelocation = (pid, { started } = {}) => {
    resumed.push(pid);
    started?.({ id: 0, direction: "backward", from: null });
    return { run: Promise.resolve({ ok: false, end: "back" }) };
  };
  setRelocationProcedure(procedure);
  try {
    await withAgentsServer(async (ctx) => {
      const { p: a } = await project(ctx, "Half");
      const { p: b } = await project(ctx, "Fresh");
      // The half relocation of A from the "previous server run": journal open, row in `relocation`, no procedure.
      const j = store.createRelocation({ projectId: a.id, instance: "main", location: path.join(ctx.root, "half-location") });
      store.createProjectInstance({ projectId: a.id, instance: "main", state: "relocation", phase: "networks" });
      try {
        await withEnvironment(ops(fd), async () => {
          const r = await raw(`${ctx.base}/api/projects/${b.id}/relocation`, { method: "POST" });
          assert.deepEqual([r.status, r.body.code, r.body.elsewhere?.projectId, r.body.elsewhere?.reason], [409, "RELOCATION_ELSEWHERE", a.id, "restart-grace-pending"], r.text);
          assert.match(r.body.error, new RegExp(`/api/projects/${a.id}/relocation/resume`));
          assert.deepEqual(procedure.started, [], "the relocation of B began before the decision about A");

          // The restart decides - and the decider fails (asynchronously).
          setRelocationDecider(() => Promise.reject(new Error("decider broken")));
          try { instancesRestartGrace(); } finally { setRelocationDecider(null); }
          await waitForTruthy(() => relocationResumeError(a.id) !== null, "the decider's remembered reason");
          const row = store.projectInstance(a.id, "main");
          assert.deepEqual([row.state, row.phase], ["relocation", "hold-resume"]);
          assert.match(row.error, /decider broken/);
          assert.match(row.error, new RegExp(`/api/projects/${a.id}/relocation/resume`));

          // The real procedure: the state names reason and way out; without an open journal there is nothing to resume.
          setRelocationProcedure(null);
          try {
            const state = await raw(`${ctx.base}/api/projects/${a.id}/relocation`);
            assert.equal(state.status, 200, state.text);
            assert.equal(state.body.state.alive, false);
            assert.match(state.body.state.resumeError?.text || "", /decider broken/);
            assert.match(state.body.state.wayOut, /relocation\/resume/);
            const nothing = await raw(`${ctx.base}/api/projects/${b.id}/relocation/resume`, { method: "POST" });
            assert.deepEqual([nothing.status, nothing.body.code], [409, "NO_OPEN_RELOCATION"], nothing.text);
          } finally { setRelocationProcedure(procedure); }

          // Decided (even if failed): B is free - A stays named instead of locking all others.
          const r2 = await raw(`${ctx.base}/api/projects/${b.id}/relocation`, { method: "POST" });
          assert.equal(r2.status, 202, r2.text);
          procedure.open();
          await waitForTruthy(() => heavyLoadStatus() === null, "heavy load free");

          // The second way for A.
          const f = await raw(`${ctx.base}/api/projects/${a.id}/relocation/resume`, { method: "POST" });
          assert.deepEqual([f.status, f.body.resumed], [202, true], f.text);
          assert.deepEqual(resumed, [a.id]);
        });
      } finally {
        procedure.open(); // a red test must not hang: a started fake relocation would hold the heavy load forever
        store.deleteProjectInstance(a.id, "main");
        store.endRelocation(j.id, "aborted");
      }
    });
  } finally {
    setRelocationProcedure(null);
    fd.cleanUp();
  }
});

test("(6) POST passes `acknowledged` to the procedure; empty body = none; wrong form => 400 BODY_INVALID without procedure", async () => {
  assert.deepEqual(receiptsFromBody({}), []);
  assert.deepEqual(receiptsFromBody({ acknowledged: [{ kind: "writeLayer", container: "c", count: 3, checksum: "ab", more: 1 }] }), [{ kind: "writeLayer", container: "c", count: 3, checksum: "ab" }]);
  for (const wrong of [null, [], "x", { acknowledged: "x" }, { acknowledged: [{ kind: "writeLayer", container: "c", count: "3", checksum: "ab" }] },
    { acknowledged: [{ kind: "writeLayer", container: "c", count: 3 }] }, { acknowledged: [{ kind: "writeLayer", container: "c", count: 3, checksum: "" }] },
    { acknowledged: [{ kind: "writeLayer", container: "c", count: -1 }] }, { acknowledged: [{ kind: "writeLayer", count: 1 }] }, { receipted: [] }]) {
    assert.throws(() => receiptsFromBody(wrong), undefined, JSON.stringify(wrong));
  }
  const fd = await fakeDocker();
  const procedure = wrongProcedure();
  setRelocationProcedure(procedure);
  try {
    await withAgentsServer(async (ctx) => {
      const { p } = await project(ctx, "Receipt");
      await withEnvironment(ops(fd), async () => {
        for (const body of ["{\"receipted\":\"x\"}", "{not json", "{\"receipts\":[]}"]) {
          const r = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST", body });
          assert.deepEqual([r.status, r.body.code], [400, "BODY_INVALID"], `${body}: ${r.text}`);
        }
        assert.deepEqual(procedure.started, [], "an invalid body called the procedure");
        const q = [{ kind: "writeLayer", container: "audit-serve", count: 3490, checksum: "0123456789abcdef" }];
        const r = await raw(`${ctx.base}/api/projects/${p.id}/relocation`, { method: "POST", body: JSON.stringify({ acknowledged: q }) });
        assert.equal(r.status, 202, r.text);
        assert.deepEqual(procedure.receipts, [q]);
        procedure.open();
        await waitForTruthy(() => heavyLoadStatus() === null, "heavy load free");
      });
    });
  } finally {
    setRelocationProcedure(null);
    fd.cleanUp();
  }
});
