// Concurrency: ONE run per lock key. Two events fired at the same moment must not both run off; they
// work in the same folder and would overwrite each other's files, git index and branch. Checked three
// ways: the pure key logic, the store (acquire/release/reaper) and the whole chain against a fake
// GitLab server.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import * as wf from "../electron/server/workflows.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) { const e = new Error(`${res.status}: ${JSON.stringify(body)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline (a deadline would measure the machine under load). If it hangs,
// the suite deadline is the emergency stop; every 30 s a stderr line says what is being waited for.
async function waitFor(fn, what = String(fn).replace(/\s+/g, " ").slice(0, 200)) {
  const t0 = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const tick = Math.floor((Date.now() - t0) / 30_000);
    if (tick > reported) { reported = tick; process.stderr.write(`[waiting] for ${tick * 30} s: ${what}\n`); }
    await sleep(40);
  }
}

// ── 1. Pure key logic ──────────────────────────────────────────────────────────────────────────

test("The lock key derives from the scope and NEVER silently falls back to parallel", () => {
  const ctx = { workflowId: "w1", projectId: "p1", vars: { origin: "trigger", project: "group/repo", url: "http://gl/-/issues/42", title: "Bug" } };
  assert.equal(wf.lockKeyFor({ scope: "off" }, ctx), "", "off means parallel");
  assert.equal(wf.lockKeyFor({ scope: "workflow" }, ctx), "workflow:w1");
  assert.equal(wf.lockKeyFor({ scope: "project" }, ctx), "project:p1", "a bound project wins");
  assert.equal(wf.lockKeyFor({ scope: "event" }, ctx), "event:http://gl/-/issues/42");
  assert.equal(wf.lockKeyFor({ scope: "custom", template: "{{project}}" }, ctx), "own:group/repo");
  // Without a bound project the GitLab path identifies the repo.
  assert.equal(wf.lockKeyFor({ scope: "project" }, { ...ctx, projectId: "" }), "project:group/repo");
  // If the value is missing entirely (manual run, empty template), the workflow key locks; otherwise a
  // setting that is MEANT to serialize would silently run in parallel.
  const bare = { workflowId: "w1", projectId: "", vars: {} };
  assert.equal(wf.lockKeyFor({ scope: "project" }, bare), "workflow:w1");
  assert.equal(wf.lockKeyFor({ scope: "event" }, bare), "workflow:w1");
  assert.equal(wf.lockKeyFor({ scope: "custom", template: "{{title}}" }, bare), "workflow:w1");
  // The default is "project" (also for nonsense in the field).
  assert.equal(wf.normalizeLock({ scope: "nonsense" }).scope, "project");
  assert.equal(wf.lockKeyFor(undefined, ctx), "project:p1");
  // Case and whitespace must not turn one thing into two keys.
  assert.equal(
    wf.lockKeyFor({ scope: "custom", template: "  Group/Repo  " }, { workflowId: "w1", vars: {} }),
    "own:group/repo",
  );
});

// ── 2. Store: acquire, re-entry, release, reaper ───────────────────────────────────────────────

test("Store: one lock per key, release at the end status, reaper for orphaned ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-locks-"));
  try {
    store.initStore(dir);
    const runA = store.startWorkflowRun({ id: "runA", chatId: "chatA", workflowId: "w1", workflowName: "W", workspaceId: "ws1" });
    const runB = store.startWorkflowRun({ id: "runB", chatId: "chatB", workflowId: "w1", workflowName: "W", workspaceId: "ws1" });
    assert.equal(runA.status, "running");
    assert.equal(runB.status, "running");

    const first = store.acquireLock("project:p1", { runId: "runA", chatId: "chatA", workflowId: "w1", workflowName: "W" });
    assert.equal(first.ok, true);
    // ANOTHER run does not get it, and learns who holds it.
    const second = store.acquireLock("project:p1", { runId: "runB", chatId: "chatB", workflowId: "w1" });
    assert.equal(second.ok, false);
    assert.equal(second.lock.runId, "runA");
    assert.equal(second.lock.chatId, "chatA");
    // The same run may acquire again (the trigger secures the lock before the chat, the driver checks
    // it once more later) and fills in the chat on the way.
    store.releaseLock("runA");
    store.acquireLock("project:p1", { runId: "runA", workflowId: "w1" });      // without chat
    assert.equal(store.getLock("project:p1").chatId, "");
    assert.equal(store.acquireLock("project:p1", { runId: "runA", chatId: "chatA" }).ok, true);
    assert.equal(store.getLock("project:p1").chatId, "chatA", "chat was filled in");
    // Another key is free (different repos run in parallel).
    assert.equal(store.acquireLock("project:p2", { runId: "runB", chatId: "chatB" }).ok, true);

    // The end status releases the lock, at the one central place.
    store.updateWorkflowRunById("runA", { status: "done" });
    assert.equal(store.getLock("project:p1") ?? null, null, "lock still there after done");
    assert.equal(store.acquireLock("project:p1", { runId: "runB", chatId: "chatB" }).ok, true, "now the next one may go");

    // Orphaned lock (run no longer exists: crash/restart/deleted history).
    store.acquireLock("project:p3", { runId: "runWay", chatId: "chatAway" });
    assert.ok(store.getLock("project:p3"), "lock was set");
    const gone = store.reapStaleLocks();
    assert.ok(gone >= 1, "reaper did not remove the orphaned lock");
    assert.equal(store.getLock("project:p3") ?? null, null);
    // The lock of an OPEN run survives the reaper (otherwise a restart would lose it).
    assert.ok(store.getLock("project:p2"), "lock of an open run was removed wrongly");

    // Deleted chat: the run is concluded, the lock goes with it.
    store.abandonWorkflowRuns("chatB", "chat deleted");
    assert.equal(store.getLock("project:p2") ?? null, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ── 3. Whole chain: two events at the same time ────────────────────────────────────────────────

// Fake CLI with a gate: a turn answers only once the gate file exists; only this way can one observe
// that the second run WAITS instead of running along (a delay would be over under load before the
// test looked).
const fakeClaude = (gate) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
if (!process.argv.slice(2).includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ result: '{"yes": true, "note": "ok"}' }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const respond = () => {
      if (!fs.existsSync(${JSON.stringify(gate)})) return setTimeout(respond, 20);
      say({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
      say({ type: "result", result: "OK", session_id: "lock-test" });
    };
    respond();
  });
}
`;

function fakeGitlab() {
  const state = { mrs: [], token: "glpat-test" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gitlab.test");
    const reply = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["private-token"] !== state.token) return reply(401, { message: "401 Unauthorized" });
    if (url.pathname === "/api/v4/user") return reply(200, { id: 7, username: "maintainer", name: "Maintainer" });
    if (url.pathname === "/api/v4/projects") return reply(200, [{ id: 42, path_with_namespace: "group/project", name: "Project" }]);
    if (url.pathname === "/api/v4/projects/42/merge_requests") {
      const after = Date.parse(url.searchParams.get("created_after") || url.searchParams.get("updated_after") || "1970-01-01") || 0;
      return reply(200, state.mrs.filter((mr) => Date.parse(mr.created_at) > after));
    }
    return reply(404, { message: "404 Not Found" });
  });
  return { state, server };
}

const mr = (iid, title, createdAt) => ({
  id: 1000 + iid, iid, project_id: 42, title, state: "opened",
  created_at: new Date(createdAt).toISOString(), updated_at: new Date(createdAt).toISOString(),
  web_url: `http://gitlab.test/group/project/-/merge_requests/${iid}`,
  source_branch: `feature/${iid}`, target_branch: "main", labels: [],
  description: "Description", author: { id: 9, username: "colleague" },
  references: { full: `group/project!${iid}` },
});

// After a failure: stop open runs instead of waiting for quiet. Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-lockrun-"));
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "turn-gate");
  const prevBin = process.env.CLAUDE_BIN;
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  const prevRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  const gl = fakeGitlab();
  let server, base = "", finished = false;
  try {
    fs.writeFileSync(bin, fakeClaude(gate));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0"; // clock off: the test polls itself
    // No restart follow-up: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    await new Promise((r) => gl.server.listen(0, "127.0.0.1", r));
    const glBase = `http://127.0.0.1:${gl.server.address().port}`;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Locks", path: wsPath }) });
    const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ label: "Fake", host: glBase, token: "glpat-test" }) });
    await fn({ base, ws, acc, gl: gl.state, openGate: () => fs.writeFileSync(gate, "") });
    finished = true;
  } finally {
    try { fs.writeFileSync(gate, ""); } catch {}
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    gl.server.closeAllConnections?.();
    await new Promise((r) => gl.server.close(r));
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL; else process.env.CBASE_TRIGGER_POLL = prevPoll;
    if (prevRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = prevRestartGrace;
    // A test must not fail because its temp directory does not go away: a child process still writing
    // causes ENOTEMPTY, which says something about the cleanup, not about the product. It is still not
    // hidden, otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
  }
}

// Workflow with a trigger + one step; `lock` sets the lock scope.
async function makeFlow(base, ws, accountId, { lock } = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, {
    method: "POST", body: JSON.stringify({ name: `Lock-test-${Math.random().toString(36).slice(2, 7)}` }),
  });
  const graph = {
    nodes: [
      { id: "t1", type: "trigger", title: "New MRs", x: 40, y: 40,
        trigger: { source: "gitlab", accountId, scope: "project", projectId: "42", projectPath: "group/project", events: ["mr_opened"], intervalSec: 30, skipMine: false } },
      { id: "s1", type: "instruction", title: "Implement", text: "Implement {{title}}", x: 320, y: 40 },
    ],
    edges: [{ from: "t1", to: "s1" }],
  };
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    // `doneAll: false`: "check all work steps" is on by default; this is about the lock, not the
    // completion gate.
    method: "PUT", body: JSON.stringify({ graph, run: { doneAll: false }, ...(lock ? { lock } : {}) }),
  });
}
const arm = (base, ws, flowId) =>
  json(`${base}/api/workspaces/${ws.id}/workflows/${flowId}`, { method: "PUT", body: JSON.stringify({ active: true }) });
const poll = (base, ws, flowId) =>
  json(`${base}/api/workspaces/${ws.id}/workflows/${flowId}/trigger-test`, { method: "POST", body: JSON.stringify({ fire: true }) });
const runs = (base, ws) => json(`${base}/api/workflow-runs?workspaceId=${ws.id}&limit=50`).then((r) => r.runs);

test("Two events at once: only ONE runs, the other waits and comes AFTER", async () => {
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    const flow = await makeFlow(base, ws, acc.id); // default: one lock per project/repo
    assert.equal(flow.lock.scope, "project", "default lock scope");
    await arm(base, ws, flow.id);

    // Two MRs appear at the same moment.
    const now = Date.now() + 1000;
    gl.mrs.push(mr(1, "First topic", now), mr(2, "Second topic", now + 1));

    const first = await poll(base, ws, flow.id);
    assert.equal(first.fired, 1, `exactly ONE run may start, started: ${first.fired}`);
    assert.match(first.error, /warte[nt].*Sperre|waiting for the lock/i, `hint missing: ${first.error}`);

    // The holder is visible, including its key.
    const active = await json(`${base}/api/active-runs`);
    assert.equal(active.counts.total, 1, "exactly one active run");
    assert.equal(active.items[0].lockKey, "project:group/project");

    // While it runs, polling again changes nothing either.
    const again = await poll(base, ws, flow.id);
    assert.equal(again.fired, 0, "nothing may start while the lock is held");
    assert.equal((await runs(base, ws)).length, 1);

    // First run done, lock free: the waiting event now gets its turn.
    openGate();
    const done1 = await waitFor(async () => {
      const list = await runs(base, ws);
      return list.length === 1 && list[0].status === "done" ? list[0] : null;
    });
    assert.ok(done1, "first run did not finish");
    await waitForQuiet(base);
    const third = await poll(base, ws, flow.id);
    assert.equal(third.fired, 1, "the waiting event was not caught up");

    const list = await waitFor(async () => {
      const l = await runs(base, ws);
      return l.length === 2 && l.every((r) => r.status === "done") ? l : null;
    });
    assert.equal(list.length, 2, "in the end BOTH events must have run");
    // The proof of serialization: the runs do not overlap.
    const [fresh, old] = list; // newest first
    assert.ok(fresh.startedAt >= old.endedAt, `runs overlap: ${old.endedAt} → ${fresh.startedAt}`);
    // And the events were different (no double firing of the same MR).
    const titles = list.map((r) => r.trigger?.summary || "").join(" | ");
    assert.match(titles, /First topic/);
    assert.match(titles, /Second topic/);
  });
});

test("Lock scope issue/MR: different subjects run at the same time", async () => {
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    const flow = await makeFlow(base, ws, acc.id, { lock: { scope: "event", template: "" } });
    assert.equal(flow.lock.scope, "event");
    await arm(base, ws, flow.id);
    const now = Date.now() + 1000;
    gl.mrs.push(mr(3, "Alpha", now), mr(4, "Beta", now + 1));

    const r = await poll(base, ws, flow.id);
    assert.equal(r.fired, 2, `both events must start, started: ${r.fired}`);
    const active = await json(`${base}/api/active-runs`);
    assert.equal(active.counts.total, 2, "both runs must be open at the same time");
    assert.deepEqual(
      [...new Set(active.items.map((i) => i.lockKey))].sort().length,
      2,
      "two different keys expected",
    );
    openGate();
    await waitFor(async () => (await runs(base, ws)).filter((x) => x.status === "done").length === 2);
  });
});

test("Manual start while the lock is held: 409 with key, no silent queueing", async () => {
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    const flow = await makeFlow(base, ws, acc.id, { lock: { scope: "workflow", template: "" } });
    await arm(base, ws, flow.id);
    gl.mrs.push(mr(5, "Already running", Date.now() + 1000));
    assert.equal((await poll(base, ws, flow.id)).fired, 1);

    // The same workflow by hand in another chat: rejected, with a reason.
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
    const err = await json(`${base}/api/chats/${chat.id}/workflow`, {
      method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "by hand" }),
    }).then(() => null, (e) => e);
    assert.ok(err, "the manual start should have been rejected");
    assert.equal(err.status, 409);
    assert.equal(err.body.lockKey, `workflow:${flow.id}`);
    assert.match(err.body.error, /Sperre|lock/i);

    // After the holder ends it works; the lock is really free.
    openGate();
    await waitFor(async () => (await runs(base, ws)).some((r) => r.status === "done"));
    await waitForQuiet(base);
    const ok = await json(`${base}/api/chats/${chat.id}/workflow`, {
      method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "now though" }),
    });
    assert.ok(ok.run?.id, "after the release the manual start must work");
    await waitFor(async () => (await runs(base, ws)).filter((r) => r.status === "done").length === 2);
  });
});

test("Cancel releases the lock (the workflow no longer shows it as held afterwards)", async () => {
  await withServer(async ({ base, ws, acc, gl }) => {
    const flow = await makeFlow(base, ws, acc.id, { lock: { scope: "workflow", template: "" } });
    await arm(base, ws, flow.id);
    gl.mrs.push(mr(6, "Will be cancelled", Date.now() + 1000));
    assert.equal((await poll(base, ws, flow.id)).fired, 1);

    const held = await json(`${base}/api/workspaces/${ws.id}/workflows`);
    assert.equal(held.find((w) => w.id === flow.id).holding.length, 1, "lock is not reported as held");

    const run = (await runs(base, ws))[0];
    await json(`${base}/api/chats/${run.chatId}/workflow/cancel`, { method: "POST" });
    const free = await waitFor(async () => {
      const list = await json(`${base}/api/workspaces/${ws.id}/workflows`);
      return list.find((w) => w.id === flow.id).holding.length === 0 ? true : null;
    });
    assert.equal(free, true, "the lock was still held after the cancel");
  });
});
