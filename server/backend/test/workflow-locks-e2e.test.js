// Hard end-to-end tests of concurrency: the cases in which a lock CAN go wrong:
//   - two DIFFERENT workflows in the same repo must exclude each other
//   - three events on one key: all three run, one after the other, none disappears
//   - the watermark must not run past a waiting event (regression trap)
//   - an open QUESTION holds the lock; the follow-up waits for the human
//   - cap per poll: the rest comes in the next round, nothing is swallowed
//   - backend restart: orphaned locks fall, the one of the resumed run stays
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { resumeInterruptedWork } from "../electron/server/runs/resume.js";
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
// After a failure: stop open runs instead of waiting for quiet. Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

// With a gate (CBASE_TEST_TURN_HOLD) a turn answers only once the test creates the file; a delay as
// ordering ("the holder is still running when the second polls") would be over under load.
const fakeClaude = `#!/usr/bin/env node
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
    const gate = process.env.CBASE_TEST_TURN_HOLD || "";
    const respond = () => {
      if (gate && !fs.existsSync(gate)) return setTimeout(respond, 20);
      setTimeout(() => {
        say({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
        say({ type: "result", result: "OK", session_id: "locks-e2e" });
      }, Number(process.env.CBASE_TEST_DELAY || 0));
    };
    respond();
  });
}
`;

// Fake GitLab server with several projects: the only way to check that different repos KEEP RUNNING
// while one waits.
function fakeGitlab() {
  const state = { mrs: {}, token: "glpat-test" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gitlab.test");
    const reply = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["private-token"] !== state.token) return reply(401, { message: "401 Unauthorized" });
    if (url.pathname === "/api/v4/user") return reply(200, { id: 7, username: "maintainer", name: "Maintainer" });
    if (url.pathname === "/api/v4/projects") {
      return reply(200, [
        { id: 42, path_with_namespace: "group/one", name: "One" },
        { id: 43, path_with_namespace: "group/two", name: "Two" },
      ]);
    }
    const m = url.pathname.match(/^\/api\/v4\/projects\/(\d+)\/merge_requests$/);
    if (m) {
      const after = Date.parse(url.searchParams.get("created_after") || url.searchParams.get("updated_after") || "1970-01-01") || 0;
      return reply(200, (state.mrs[m[1]] || []).filter((mr) => Date.parse(mr.created_at) > after));
    }
    return reply(404, { message: "404 Not Found" });
  });
  return { state, server };
}
// IMPORTANT for lock keys: the project path in the event comes from `references.full` (gitlab.js:
// projectName), so it MUST read like real GitLab ("group/name!iid"; otherwise the test checks a key
// that never exists in reality).
const PATH = { 42: "group/one", 43: "group/two" };
const mr = (projectId, iid, title, createdAt) => ({
  id: projectId * 1000 + iid, iid, project_id: projectId, title, state: "opened",
  created_at: new Date(createdAt).toISOString(), updated_at: new Date(createdAt).toISOString(),
  web_url: `http://gitlab.test/${PATH[projectId]}/-/merge_requests/${iid}`,
  source_branch: `feature/${iid}`, target_branch: "main", labels: [],
  description: "Description", author: { id: 9, username: "colleague" },
  references: { full: `${PATH[projectId]}!${iid}` },
});

// `keep` hands out the data directory (for the restart test) instead of deleting it, and leaves the
// run and its gate standing. The gate lies in the root folder and so applies to both servers there.
async function withServer(fn, { delayMs = 0, dataRoot = null, keep = false, withGate = false } = {}) {
  const root = dataRoot ? path.dirname(dataRoot) : fs.mkdtempSync(path.join(os.tmpdir(), "cbase-locke2e-"));
  const data = dataRoot || path.join(root, "data-root");
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "turn-gate");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL, delay: process.env.CBASE_TEST_DELAY,
    gate: process.env.CBASE_TEST_TURN_HOLD, restartGrace: process.env.CBASE_RESTART_GRACE_MS,
  };
  const gl = fakeGitlab();
  let server, base = "", finished = false;
  try {
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_DELAY = String(delayMs);
    if (withGate) process.env.CBASE_TEST_TURN_HOLD = gate; else delete process.env.CBASE_TEST_TURN_HOLD;
    // No restart follow-up by itself: where it is the subject (restart test), the test calls it, so
    // "afterwards" is a point in time the test knows.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    await new Promise((r) => gl.server.listen(0, "127.0.0.1", r));
    const glBase = `http://127.0.0.1:${gl.server.address().port}`;
    const wsPath = path.join(root, "workspace");
    if (!fs.existsSync(wsPath)) fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: data, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const wss = await json(`${base}/api/workspaces`);
    const ws = wss.length ? wss[0] : await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Locks-E2E", path: wsPath }) });
    const accounts = await json(`${base}/api/gitlab/accounts`);
    const acc = accounts.length ? accounts[0] : await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ label: "Fake", host: glBase, token: "glpat-test" }) });
    const result = await fn({ base, ws, acc, gl: gl.state, dataRoot: data, root, openGate: () => fs.writeFileSync(gate, "") });
    finished = true;
    return result;
  } finally {
    if (!keep) { try { fs.writeFileSync(gate, ""); } catch {} }
    if (base && !keep && finished) await waitForQuiet(base);
    else if (base && !keep) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    gl.server.closeAllConnections?.();
    await new Promise((r) => gl.server.close(r));
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll], ["CBASE_TEST_DELAY", prev.delay],
                          ["CBASE_TEST_TURN_HOLD", prev.gate], ["CBASE_RESTART_GRACE_MS", prev.restartGrace]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // A test must not fail because its temp directory does not go away: a child process still writing
    // causes ENOTEMPTY, which says something about the cleanup, not about the product. It is still not
    // hidden, otherwise garbage piles up unnoticed in /tmp.
    try { if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
  }
}

// Workflow with a trigger on ONE GitLab project + one step.
async function makeFlow(base, ws, accountId, name, { projectId = "42", projectPath = "group/one", lock, run, graph } = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  const g = graph || {
    nodes: [
      { id: "t1", type: "trigger", title: "New MRs", x: 40, y: 40,
        trigger: { source: "gitlab", accountId, scope: "project", projectId, projectPath, events: ["mr_opened"], intervalSec: 30, skipMine: false } },
      { id: "s1", type: "instruction", title: "Implement", text: "Implement {{title}}", x: 320, y: 40 },
    ],
    edges: [{ from: "t1", to: "s1" }],
  };
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    // `doneAll: false`: "check all work steps" is on by default; this is about the lock, not the
    // completion gate.
    method: "PUT", body: JSON.stringify({ graph: g, ...(lock ? { lock } : {}), run: { doneAll: false, ...(run || {}) } }),
  });
}
const arm = (base, ws, id) => json(`${base}/api/workspaces/${ws.id}/workflows/${id}`, { method: "PUT", body: JSON.stringify({ active: true }) });
const poll = (base, ws, id) => json(`${base}/api/workspaces/${ws.id}/workflows/${id}/trigger-test`, { method: "POST", body: JSON.stringify({ fire: true }) });
const runs = (base, ws) => json(`${base}/api/workflow-runs?workspaceId=${ws.id}&limit=50`).then((r) => r.runs);
const active = (base) => json(`${base}/api/active-runs`);

test("Two DIFFERENT workflows in the same repo exclude each other", async () => {
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    // Both listen to the same GitLab project, hence the same key "project:group/one".
    const a = await makeFlow(base, ws, acc.id, "Review-A");
    const b = await makeFlow(base, ws, acc.id, "Update-B");
    await arm(base, ws, a.id);
    await arm(base, ws, b.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [mr(42, 1, "Topic A", now), mr(42, 2, "Topic B", now + 1)];

    // Workflow A grabs it ...
    assert.equal((await poll(base, ws, a.id)).fired, 1);
    // ... and workflow B does NOT get its turn, although it is a different workflow.
    const bRes = await poll(base, ws, b.id);
    assert.equal(bRes.fired, 0, "the second workflow should have waited");
    assert.match(bRes.error, /Sperre|lock/i, `hint missing: ${bRes.error}`);
    assert.equal((await active(base)).counts.total, 1, "only ONE run may be open");

    // After A ends, B may go, and the waiting event is still there.
    openGate();
    await waitFor(async () => (await runs(base, ws)).some((r) => r.status === "done"));
    await waitForQuiet(base);
    assert.equal((await poll(base, ws, b.id)).fired, 1, "B was not caught up");
    const both = await waitFor(async () => {
      const l = await runs(base, ws);
      return l.length === 2 && l.every((r) => r.status === "done") ? l : null;
    });
    assert.equal(both.length, 2);
    assert.deepEqual([...new Set(both.map((r) => r.name))].sort(), ["Review-A", "Update-B"]);
    const [fresh, old] = both;
    assert.ok(fresh.startedAt >= old.endedAt, `the runs overlap: ${old.endedAt} → ${fresh.startedAt}`);
  }, { withGate: true });
});

test("Different repos KEEP RUNNING while one waits (default key)", async () => {
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    const one = await makeFlow(base, ws, acc.id, "Repo-One", { projectId: "42", projectPath: "group/one" });
    const two = await makeFlow(base, ws, acc.id, "Repo-Two", { projectId: "43", projectPath: "group/two" });
    await arm(base, ws, one.id);
    await arm(base, ws, two.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [mr(42, 10, "First repo A", now), mr(42, 11, "First repo B", now + 1)];
    gl.mrs["43"] = [mr(43, 20, "Second repo", now)];

    assert.equal((await poll(base, ws, one.id)).fired, 1, "repo one: one runs");
    assert.equal((await poll(base, ws, two.id)).fired, 1, "repo two may run in parallel");
    const view = await active(base);
    assert.equal(view.counts.total, 2, "two repos = two simultaneous runs");
    assert.deepEqual([...new Set(view.items.map((i) => i.lockKey))].sort(), ["project:group/one", "project:group/two"]);
    // Within repo one the second MR still waits.
    assert.equal((await poll(base, ws, one.id)).fired, 0);
    openGate();
    await waitFor(async () => (await runs(base, ws)).filter((r) => r.status === "done").length === 2);
    await waitForQuiet(base);
    assert.equal((await poll(base, ws, one.id)).fired, 1, "the straggler in repo one is missing");
    await waitFor(async () => (await runs(base, ws)).filter((r) => r.status === "done").length === 3);
  }, { withGate: true });
});

test("Three events on ONE key: all three run, one after the other, in event order", async () => {
  await withServer(async ({ base, ws, acc, gl }) => {
    const flow = await makeFlow(base, ws, acc.id, "Triple");
    await arm(base, ws, flow.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [mr(42, 1, "First", now), mr(42, 2, "Second", now + 1000), mr(42, 3, "Third", now + 2000)];

    // Until everything is through: poll, wait, poll ... (like the real clock, only faster).
    for (let i = 0; i < 12; i++) {
      await poll(base, ws, flow.id);
      await waitForQuiet(base);
      const done = (await runs(base, ws)).filter((r) => r.status === "done").length;
      if (done >= 3) break;
    }
    const list = await runs(base, ws);
    assert.equal(list.length, 3, `expected 3 runs, got ${list.length}`);
    assert.ok(list.every((r) => r.status === "done"), `all should be done: ${list.map((r) => r.status).join(",")}`);
    // Order: oldest first (the list comes newest first).
    const title = list.slice().reverse().map((r) => r.trigger?.summary || "");
    assert.match(title[0], /First/);
    assert.match(title[1], /Second/);
    assert.match(title[2], /Third/);
    // And no overlap between consecutive runs.
    const chrono = list.slice().reverse();
    for (let i = 1; i < chrono.length; i++) {
      assert.ok(chrono[i].startedAt >= chrono[i - 1].endedAt,
        `run ${i + 1} started before the end of run ${i}: ${chrono[i - 1].endedAt} → ${chrono[i].startedAt}`);
    }
  }, { delayMs: 400 });
});

test("Regression trap: a WAITING event is not lost when a newer one is already running", async () => {
  // Key per title (custom): event 1 is blocked, event 2 is free. If the watermark runs past event 1,
  // it NEVER comes back (created_after is the only resubmission). That is exactly what this test checks.
  await withServer(async ({ base, ws, acc, gl, openGate }) => {
    const flow = await makeFlow(base, ws, acc.id, "Watermark", { lock: { scope: "custom", template: "{{title}}" } });
    await arm(base, ws, flow.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [mr(42, 1, "Old", now)];

    // Round 1: "Old" starts and holds the key "own:old".
    assert.equal((await poll(base, ws, flow.id)).fired, 1);
    const oldRun = (await runs(base, ws))[0];
    assert.equal((await active(base)).items[0].lockKey, "own:old");

    // Now a NEWER event with another key arrives, and "Old" appears again (GitLab keeps delivering it
    // while the watermark stands).
    gl.mrs["42"].push(mr(42, 2, "Fresh", now + 5000));
    const second = await poll(base, ws, flow.id);
    assert.equal(second.fired, 1, "Fresh should have run (other key)");
    assert.equal((await active(base)).counts.total, 2, "both keys at the same time");

    // Both done, then poll once more: "Old" must NOT have disappeared ...
    openGate();
    await waitFor(async () => (await runs(base, ws)).filter((r) => r.status === "done").length === 2);
    await waitForQuiet(base);
    const third = await poll(base, ws, flow.id);
    // ... and it must not run TWICE either (the seen ring protects).
    const list = await runs(base, ws);
    const oldRuns = list.filter((r) => /Old/.test(r.trigger?.summary || ""));
    assert.equal(oldRuns.length, 1, `"Old" ran ${oldRuns.length}x (expected: exactly 1)`);
    assert.equal(oldRuns[0].id, oldRun.id);
    assert.equal(third.fired, 0, "there was nothing left to fire");
    assert.equal(list.length, 2);
  }, { withGate: true });
});

test("An open QUESTION holds the lock; the follow-up waits for the human", async () => {
  await withServer(async ({ base, ws, acc, gl }) => {
    const flow = await makeFlow(base, ws, acc.id, "With-question", {
      graph: {
        nodes: [
          { id: "t1", type: "trigger", title: "New MRs", x: 0, y: 0,
            trigger: { source: "gitlab", accountId: acc.id, scope: "project", projectId: "42", projectPath: "group/one", events: ["mr_opened"], intervalSec: 30, skipMine: false } },
          { id: "a1", type: "ask", title: "Approval", text: "Shall I take over {{title}}?", x: 220, y: 0 },
          { id: "n1", type: "instruction", title: "Afterwards", text: "Go on: {{answer}}", x: 440, y: 0 },
        ],
        edges: [{ from: "t1", to: "a1" }, { from: "a1", to: "n1" }],
      },
    });
    await arm(base, ws, flow.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [mr(42, 1, "Question-MR", now), mr(42, 2, "Second-MR", now + 1)];

    assert.equal((await poll(base, ws, flow.id)).fired, 1);
    // The run stands on "waiting" and is therefore OPEN, so it holds the lock.
    const waiting = await waitFor(async () => {
      const v = await active(base);
      return v.items.find((i) => i.phase === "ask") || null;
    });
    assert.ok(waiting, "the waiting run is missing in the overview");
    assert.equal(waiting.lockKey, "project:group/one");
    assert.equal((await poll(base, ws, flow.id)).fired, 0, "nothing may move up during a question");

    // The user's answer: the run continues and ends, then the second MR may go.
    await json(`${base}/api/chats/${waiting.chatId}/message`, { method: "POST", body: JSON.stringify({ text: "Yes, take it" }) });
    await waitFor(async () => (await runs(base, ws)).some((r) => r.status === "done"));
    await waitForQuiet(base);
    assert.equal((await poll(base, ws, flow.id)).fired, 1, "nothing was caught up after the answer");
    const list = await waitFor(async () => {
      const l = await runs(base, ws);
      return l.length === 2 ? l : null;
    });
    assert.equal(list.length, 2);
  }, { delayMs: 300 });
});

test("Cap per poll: of five events three run, the rest comes in the next round", async () => {
  await withServer(async ({ base, ws, acc, gl }) => {
    // Without a lock, so that the CAP (3 per poll / 3 simultaneous) applies and not the lock.
    const flow = await makeFlow(base, ws, acc.id, "Five", { lock: { scope: "off", template: "" } });
    await arm(base, ws, flow.id);
    const now = Date.now() + 1000;
    gl.mrs["42"] = [1, 2, 3, 4, 5].map((i) => mr(42, i, `Number ${i}`, now + i));

    const first = await poll(base, ws, flow.id);
    assert.ok(first.fired <= 3, `at most 3 per poll, got ${first.fired}`);
    assert.match(first.error, /warten|übersprungen|waiting|Skipped/i, `hint about the cap missing: ${first.error}`);
    await waitFor(async () => (await runs(base, ws)).filter((r) => r.status === "done").length >= first.fired);
    await waitForQuiet(base);

    for (let i = 0; i < 6; i++) {
      await poll(base, ws, flow.id);
      await waitForQuiet(base);
      if ((await runs(base, ws)).length >= 5) break;
    }
    const list = await runs(base, ws);
    assert.equal(list.length, 5, `all five events must arrive, got ${list.length}`);
    const numbers = list.map((r) => (r.trigger?.summary || "").match(/Number (\d)/)?.[1]).filter(Boolean).sort();
    assert.deepEqual(numbers, ["1", "2", "3", "4", "5"], "an event is missing (silently swallowed)");
  }, { delayMs: 250 });
});

test("Backend restart: orphaned locks fall, the resumed run keeps its own", async () => {
  // First server: start a run and close the server IN THE MIDDLE of the step (crash substitute). The
  // step waits at the gate until the second server has checked everything.
  const ctx = await withServer(async ({ base, ws, acc, gl, dataRoot, root }) => {
    const flow = await makeFlow(base, ws, acc.id, "Restart", { lock: { scope: "workflow", template: "" } });
    await arm(base, ws, flow.id);
    gl.mrs["42"] = [mr(42, 1, "Survives the restart", Date.now() + 1000)];
    assert.equal((await poll(base, ws, flow.id)).fired, 1);
    const run = await waitFor(async () => (await runs(base, ws))[0] || null);
    assert.equal(run.status, "running");
    const view = await active(base);
    assert.equal(view.items[0].lockKey, `workflow:${flow.id}`);
    return { dataRoot, root, workflowId: flow.id, runId: run.id, wsId: ws.id };
  }, { withGate: true, keep: true });

  // Second server on the SAME data directory: resumeInterruptedWork resumes the run.
  try {
    await withServer(async ({ base, ws, openGate }) => {
      const again = await waitFor(async () => {
        const l = await runs(base, ws);
        const r = l.find((x) => x.id === ctx.runId);
        return r ? r : null;
      });
      assert.ok(again, "the run was lost at the restart");
      // The restart follow-up, by hand: only AFTER it is "the lock survives the reaper" a statement;
      // before, the check below could be green before it ran.
      resumeInterruptedWork();
      // It is open, so its lock must be (back) there; otherwise a second event could start in the same
      // repo while this run keeps working.
      const flows = await json(`${base}/api/workspaces/${ws.id}/workflows`);
      const held = flows.find((f) => f.id === ctx.workflowId);
      assert.ok(held?.holding.length, `the lock was not restored at the restart (holding: ${JSON.stringify(held?.holding)})`);
      assert.equal(held.holding[0].key, `workflow:${ctx.workflowId}`);
      // And a manual start is rejected meanwhile.
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id }) });
      const err = await json(`${base}/api/chats/${chat.id}/workflow`, {
        method: "POST", body: JSON.stringify({ workflowId: ctx.workflowId }),
      }).then(() => null, (e) => e);
      assert.ok(err && err.status === 409, "the manual start should have failed at the lock");
      // Finally: the resumed run finishes and releases.
      openGate();
      await waitFor(async () => {
        const l = await runs(base, ws);
        return l.find((x) => x.id === ctx.runId && ["done", "failed", "cancelled"].includes(x.status)) || null;
      });
      const after = await json(`${base}/api/workspaces/${ws.id}/workflows`);
      assert.equal(after.find((f) => f.id === ctx.workflowId).holding.length, 0, "the lock stayed stuck after the end");
    }, { delayMs: 300, dataRoot: ctx.dataRoot, withGate: true });
  } finally {
    fs.rmSync(ctx.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
