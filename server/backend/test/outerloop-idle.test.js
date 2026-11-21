// IDLE and the outer loop:
//   (1) a running run (loop engine over the fake preset endpoint — no process a oneshot detection would find) => /api/runs/active
//       `busy: true`, `open.outerLoop` 1, `quiet: false`, the list `outerLoop` with agent, chat and start; afterwards everything
//       false or empty — the field is ALWAYS there (empty is not unknown); the fence filter of a project container
//       (projectbox/fence.js FILTER.runsCounter) returns the list filtered by the observed chat
//   (2) the start: a `running` from the last server run (no core any more) is SYNCHRONOUSLY `aborted` after the restart; a
//       `parked` one stays and gets its wakeup anew in the restart grace
//   (3) project case: a run with tools works in the project container (fake docker); its external MCP server is NOT included
//       as a plain entry (the token would lie in the rw-mounted runtime folder — it is nowhere below it, and the engine does not
//       offer the server); deleting the project (projectLocks "erase") still locks — the run is aborted instead of holding the
//       delete up with 409; another reason ("relocation") keeps waiting for it
//
// COUNTER-TESTS (which sabotage turns which test red):
//   runs/routes.js `busy: ... || outerLoop.length > 0` removed => (1) red; server.js without `outerLoopAtStart()` => (2) red.
//   projectbox/idle.js `olRuns = reason === "erase" ? ... : []` -> `[]` => (3) red (open, 409);
//   toolchain/mcp-config.js airlockEntry with the headers in env => (3) red (the access lies in a file of the runtime folder).
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/outerloop-idle.test.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { FILTER } from "../electron/server/projectbox/fence.js";
import { projectLocks } from "../electron/server/projectbox/idle.js";
import { FENCE_LOCKED } from "../electron/mcp/visibility.js";
import { OUTER_LOOP_SELECTABLE } from "../electron/server/outerloop/catalog.js";
import { outerLoopCoreCount, startOuterLoopRun, outerLoopWakeParkedNow } from "../electron/server/outerloop/run.js";
import { outerLoopRestartGrace } from "../electron/server/outerloop/trigger.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";

const active = (base) => json(`${base}/api/runs/active`);

test("(1) a running run holds the idle: busy, open.outerLoop, quiet — afterwards not; the field is always there; fence filter", async () => {
  let release = null;
  const hold = new Promise((r) => { release = r; });
  const request = { arrived: false };
  await withAgentsServer(async ({ base, chat, ws, waitForTruthy, engine }) => {
    try {
      const empty = await active(base);
      assert.deepEqual(empty.outerLoop, [], "the field is there even without a run");
      assert.equal(empty.open.outerLoop, 0);
      store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
      const a = store.createOuterLoopAgent({ id: "b1000000-0000-4000-8000-000000000001", workspaceId: ws.id, name: "Watcher", trigger: [{ kind: "quiet", minutes: 5 }], provider: engine.id, model: engine.model });
      store.setOuterLoopActive(a.id, chat.id, true, 0);
      const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
      assert.equal(r.started, true, JSON.stringify(r));
      // The request OR the end of the run: a run that fails before it is red with a reason, not a silent hang.
      const w = await waitForTruthy(() => {
        const l = store.outerLoopRun(r.runId);
        return request.arrived ? { arrived: true } : !l || ["finished", "error", "aborted"].includes(l.state) ? { tooEarly: l } : null;
      }, "engine request of the outer-loop run (or its end)");
      assert.ok(w.arrived, `the run ended before its request: ${JSON.stringify(w.tooEarly)}`);
      const s = await active(base);
      assert.equal(s.busy, true, "the run holds the idle");
      assert.equal(s.runs, 0, "it is no turn");
      assert.equal(s.quiet, false);
      assert.equal(s.open.outerLoop, 1);
      assert.equal(s.outerLoop.length, 1);
      const [e] = s.outerLoop;
      assert.deepEqual({ runId: e.runId, agentId: e.agentId, agentName: e.agentName, chatId: e.chatId, title: e.title }, { runId: r.runId, agentId: a.id, agentName: "Watcher", chatId: chat.id, title: "Agent-E2E" });
      assert.equal(typeof e.startedAt, "number");
      // The fence filter of a project container: only runs on chats of its project.
      const view = (projectFromChat) => ({ P: "pA", chat: (id) => (id === chat.id ? { id, projectId: projectFromChat } : null), graphStartOfChild: () => null });
      assert.deepEqual(FILTER.runsCounter(s, view("pA")).outerLoop.map((x) => x.runId), [r.runId], "in the project: visible");
      assert.deepEqual(FILTER.runsCounter(s, view("pB")).outerLoop, [], "other project: not visible");
      release();
      await waitForTruthy(() => store.outerLoopRun(r.runId)?.state === "finished", "run finished");
      await waitForTruthy(async () => (await active(base)).busy === false, "idle");
      const afterwards = await active(base);
      assert.deepEqual(afterwards.outerLoop, []);
      assert.equal(afterwards.open.outerLoop, 0);
    } finally {
      // After a failure the harness's quiet would hang on the held request (the run counts as open work).
      release();
    }
  }, { engine: { round: async () => { request.arrived = true; await hold; return { text: "Note" }; } } });
});

test("(2) the start: a `running` from the last server run becomes `aborted`, a `parked` one stays and gets its wakeup in the restart grace", async () => {
  await withAgentsServer(async ({ base, chat, ws, restart, waitForTruthy }) => {
    const a = store.createOuterLoopAgent({ id: "b2000000-0000-4000-8000-000000000002", workspaceId: ws.id, name: "Restart", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "claude-haiku-4-5-20251001" });
    store.createOuterLoopRun({ id: "l-running", agentId: a.id, chatId: chat.id, trigger: "quiet" });
    store.createOuterLoopRun({ id: "l-parked", agentId: a.id, chatId: chat.id, trigger: "quiet" });
    store.outerLoopRunState("l-parked", "parked", { parkedUntil: Date.now() + 3_600_000, error: "credit gate" });
    try {
      assert.equal((await active(base)).busy, true, "the `running` row holds the idle");
      // The idle before the restart would see the row — only the turns are waited for.
      await restart({ withBackground: true });
      assert.equal(store.outerLoopRun("l-running").state, "aborted", "synchronously in the listen callback");
      assert.match(store.outerLoopRun("l-running").error, /Server neu gestartet/);
      assert.equal(store.outerLoopRun("l-parked").state, "parked", "parked stays");
      assert.equal((await active(base)).busy, false, "afterwards nothing holds any more");
      assert.equal(outerLoopWakeParkedNow(), 0, "no wakeup before the restart grace");
      outerLoopRestartGrace();
      // The wakeup is set; once woken the run checks its activation — the agent is not active on the chat => aborted, not started.
      assert.equal(outerLoopWakeParkedNow(), 1, "the restart grace set the wakeup");
      await waitForTruthy(() => store.outerLoopRun("l-parked").state === "aborted", "woken");
      assert.match(store.outerLoopRun("l-parked").error, /nicht mehr aktiv/);
    } finally {
      // A made-up `running` row without a core counts as open work — after a failure the quiet would otherwise wait forever.
      store.abortOuterLoopRuns("test end");
    }
  });
});

// Operation with a running project container (built like projectbox-idle.test.js inOpsWithContainer).
const OPS = ["CBASE_CONTAINER", "CBASE_DIND", "CBASE_DOCKER_BIN", "CBASE_IN_PROJECT_ESCALATION_MS", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
async function inOpsWithContainer(fd, fn) {
  const saved = Object.fromEntries(OPS.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin, CBASE_IN_PROJECT_ESCALATION_MS: "200",
      CLAUDE_CONFIG_DIR: path.join(fd.dir, "b-home", ".claude"), CODEX_HOME: path.join(fd.dir, "b-home", ".codex") });
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const allFiles = (root) => {
  const out = [];
  const go = (d) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const q = path.join(d, x.name); if (x.isDirectory()) go(q); else if (x.isFile()) out.push(q); } };
  go(root);
  return out;
};

test("(3) project case: a run with tools in the project container — external server only as airlock wrapper, no access in a file; deleting aborts it instead of 409", async () => {
  const fd = await fakeDocker();
  let release = null;
  const hold = new Promise((r) => { release = r; });
  const request = { arrived: false, tools: null };
  try {
    await withAgentsServer(async ({ base, chat, ws, root, dataRoot, waitForTruthy, waitForQuiet, engine, projectWithoutInstance }) => {
      await inOpsWithContainer(fd, async () => {
        const filePath = path.join(root, "workspace", "till");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await projectWithoutInstance({ name: "Till", path: filePath });
        const name = `cbase-p-${p.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
        const free = OUTER_LOOP_SELECTABLE.find((t) => !Object.hasOwn(FENCE_LOCKED, t));
        // A coding server with an access in the header — the value never leaves the backend.
        const now = Date.now();
        const srv = store.createMcpServer({ id: "teams-ol-3", workspaceId: ws.id, name: "teams", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer SECRET-IN-PROJECT" }, createdAt: now, updatedAt: now });
        const a = store.createOuterLoopAgent({ id: "b3000000-0000-4000-8000-000000000003", workspaceId: ws.id, name: "Project watcher", trigger: [{ kind: "quiet", minutes: 5 }],
          provider: engine.id, model: engine.model, tools: [free], mcp: { [srv.id]: ["read"] } });
        store.setOuterLoopActive(a.id, chat.id, true, 0);
        const r = await startOuterLoopRun({ agent: a, chat: store.getChat(chat.id), trigger: "quiet" });
        assert.equal(r.started, true, JSON.stringify(r));
        try {
          const w = await waitForTruthy(() => {
            const l = store.outerLoopRun(r.runId);
            return request.arrived ? { arrived: true } : !l || ["finished", "error", "aborted"].includes(l.state) ? { tooEarly: l } : null;
          }, "engine request of the outer-loop run (or its end)");
          assert.ok(w.arrived, `the run ended before its request: ${JSON.stringify(w.tooEarly)}`);
          assert.equal(outerLoopCoreCount(), 1);

          // The external server in the project container (through the airlock): in the set, in the MCP file only as a wrapper with
          // a run token — its access is in no file of the runtime folder.
          const l = store.outerLoopRun(r.runId);
          assert.deepEqual(l.set.extern, [{ key: "teams", name: "teams", tools: ["read"] }], JSON.stringify(l.set));
          assert.deepEqual(l.set.dropped.fence, [], JSON.stringify(l.set.dropped));
          const location = path.join(dataRoot, "data", "projects", p.id);
          const files = allFiles(location).map((f) => { try { return [f, fs.readFileSync(f, "utf8")]; } catch { return [f, ""]; } });
          assert.deepEqual(files.filter(([, t]) => t.includes("SECRET-IN-PROJECT")).map(([f]) => f), [], "the access is in no file of the runtime folder");
          const wrapper = files.find(([f, t]) => f.endsWith(".mcp.json") && t.includes("teams"));
          assert.ok(wrapper, "the MCP file of the run lies in the runtime folder of the project");
          const entry = JSON.parse(wrapper[1]).mcpServers.teams;
          assert.ok(/airlock\.js$/.test(entry.args[0]) && entry.args.includes(srv.id) && entry.env.CBASE_AIRLOCK, JSON.stringify(entry));

          // Another reason waits for the run as before ...
          const relocation = projectLocks(p.id, { reason: "relocation" });
          assert.equal(relocation.ok, false, JSON.stringify(relocation));
          assert.ok(relocation.open.some((o) => o.reason === "outerloop"), JSON.stringify(relocation.open));
          // ... deleting aborts it.
          const s = projectLocks(p.id, { reason: "erase" });
          assert.equal(s.ok, true, `deleting waited for the outer-loop run: ${JSON.stringify(s.open)}`);
          s.resolve();
          assert.equal(store.outerLoopRun(r.runId).state, "aborted");
          assert.match(store.outerLoopRun(r.runId).error, /Projekt gelöscht/);
          assert.equal(outerLoopCoreCount(), 0, "the core is quiet");
          assert.equal(store.outerLoopAgent(a.id)?.id, a.id, "the agent stays (it keeps running on other chats)");
          release();
          await waitForQuiet();
          assert.equal(store.outerLoopRun(r.runId).state, "aborted", "a returning run writes nothing");
        } finally { release(); }
      });
    }, { engine: { round: async (b) => { request.tools = (b?.tools || []).map((t) => t.function?.name || t.name); request.arrived = true; await hold; return { text: "too late" }; } } });
  } finally { release(); fd.cleanUp(); }
});

// An agent with ONLY a coding MCP server, on the chat of a converted project. The servers are the coding servers of the project
// (store.effectiveMcpServers with its project) — wrapper and forwarding belong in the instance as in a coding chat. Counter-test:
// if outerloop/set.js (needsProject) ignores the external selection, the MCP file is not in the project's runtime folder and the
// delete/relocation gate sees no run in the project — both checks red.
test("(4) only a coding server selected, chat of a converted project: the run takes the location of the chat (instance, runtime folder)", async () => {
  const fd = await fakeDocker();
  let release = null;
  const hold = new Promise((r) => { release = r; });
  const request = { arrived: false };
  try {
    await withAgentsServer(async ({ base, chat, ws, root, dataRoot, waitForTruthy, waitForQuiet, engine, projectWithoutInstance }) => {
      await inOpsWithContainer(fd, async () => {
        const filePath = path.join(root, "workspace", "till");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await projectWithoutInstance({ name: "Till", path: filePath });
        const name = `cbase-p-${p.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        store.addMessage(chat.id, "user", "Please rebuild the checkout.", 1000);
        const now = Date.now();
        // A project-owned server: in the set of the project chat, at home in the project container.
        const srv = store.createMcpServer({ id: "project-ol-4", workspaceId: ws.id, projectId: p.id, name: "till-server", transport: "http", url: "http://127.0.0.1:9/mcp", createdAt: now, updatedAt: now });
        const a = store.createOuterLoopAgent({ id: "b4000000-0000-4000-8000-000000000004", workspaceId: ws.id, name: "External only", trigger: [{ kind: "quiet", minutes: 5 }],
          provider: engine.id, model: engine.model, tools: [], builtin: [], mcp: { [srv.id]: ["read"] } });
        store.setOuterLoopActive(a.id, chat.id, true, 0);
        const r = await startOuterLoopRun({ agent: a, chat: store.getChat(chat.id), trigger: "quiet" });
        assert.equal(r.started, true, JSON.stringify(r));
        try {
          const w = await waitForTruthy(() => {
            const l = store.outerLoopRun(r.runId);
            return request.arrived ? { arrived: true } : !l || ["finished", "error", "aborted"].includes(l.state) ? { tooEarly: l } : null;
          }, "engine request of the outer-loop run (or its end)");
          assert.ok(w.arrived, `the run ended before its request: ${JSON.stringify(w.tooEarly)}`);
          const l = store.outerLoopRun(r.runId);
          assert.deepEqual(l.set.extern, [{ key: "till-server", name: "till-server", tools: ["read"] }], JSON.stringify(l.set));
          const location = path.join(dataRoot, "data", "projects", p.id);
          const wrapper = allFiles(location).find((f) => f.endsWith(".mcp.json") && fs.readFileSync(f, "utf8").includes("till-server"));
          assert.ok(wrapper, "the MCP file of the run lies in the runtime folder of the project (location of the chat, instance)");
          // The run works in the project: a relocation waits for it.
          const relocation = projectLocks(p.id, { reason: "relocation" });
          assert.equal(relocation.ok, false, JSON.stringify(relocation));
          assert.ok(relocation.open.some((o) => o.reason === "outerloop"), JSON.stringify(relocation.open));
          release();
          await waitForTruthy(() => ["finished", "error", "aborted"].includes(store.outerLoopRun(r.runId)?.state), "run finished");
          await waitForQuiet();
        } finally { release(); }
      });
    }, { engine: { round: async () => { request.arrived = true; await hold; return { text: "Note." }
; } } });
  } finally { release(); fd.cleanUp(); }
});
