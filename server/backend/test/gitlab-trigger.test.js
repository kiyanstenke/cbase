// Trigger nodes: a GitLab event starts a workflow BY ITSELF.
// The whole chain is checked against a fake GitLab server (no network, no token): connect account -> arm trigger -> event appears ->
// new chat + run with the event variables in the prompt -> the same event does NOT fire twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

// The tick of the poller is fixed at MODULE LOAD (workflows/triggers.js, TRIGGER_TICK_MS): the fast value must be set before the
// import, and the server follows dynamically. The poller itself starts only where CBASE_TRIGGER_POLL is not "0".
process.env.CBASE_TRIGGER_TICK_MS ??= "150";
const { startServer } = await import("../electron/server/server.js");
const { triggerCycles } = await import("../electron/server/workflows/triggers.js");
// The chats WITHOUT the filter of the client list (GET /api/chats shows only chats with at least one message). What is measured here
// is whether a trigger CREATES a chat — a created but still empty one (waiting at the lock, half failed) must count, otherwise "no
// chat" and "not past the lock" would pass silently.
const store = await import("../electron/server/store.js");
const chatList = () => store.listChats(undefined);

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for an EVENT, without a deadline: under load a deadline measures the machine. If it hangs, the suite deadline is the
// emergency brake; every 30 s a line on stderr says what is being waited for.
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

// The fake CLI answers with the start of the prompt it received — so the chat log shows what the trigger actually gave the agent
// (placeholders resolved?). With a gate (CBASE_TEST_TURN_HOLD) it answers only once the test creates the file.
const fakeClaudeEcho = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const c = msg.message && msg.message.content;
  const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
  const out = "PROMPT>>> " + text.replace(/\\s+/g, " ").slice(0, 400);
  const gate = process.env.CBASE_TEST_TURN_HOLD || "";
  const respond = () => {
    if (gate && !fs.existsSync(gate)) return setTimeout(respond, 20);
    say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
    say({ type: "result", result: out, session_id: "trig-session" });
  };
  respond();
});
`;

// Fake GitLab server. `state.mrs`/`state.issues`/`state.events` decide what the lists deliver — like GitLab ordered by `order_by`
// (`created_at` or `updated_at`) in direction `sort` (default descending), filtered from `created_after`/`updated_after` ("on or
// after", like GitLab for MRs and issues) and paged (`page`, `per_page`, default 20); the event feed by `created_at`, its
// day-precise `after` is ignored (a lead-in before the line is the normal case there). `state.error[path] = n` makes the next n
// requests of that path fail with 502; `state.beforeRequest(call)` runs before every answer (a test changes an entry IN THE MIDDLE
// of reading with it). Every call is recorded so the test can check the "since" limits and the pages.
function fakeGitlab() {
  const state = { mrs: [], issues: [], events: [], error: {}, calls: [], token: "glpat-test", beforeRequest: null };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://gitlab.test");
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams) };
    state.calls.push(call);
    const reply = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["private-token"] !== state.token) return reply(401, { message: "401 Unauthorized" });
    if (state.error[url.pathname] > 0) { state.error[url.pathname]--; return reply(502, { message: "502 Bad Gateway" }); }
    state.beforeRequest?.(call);
    const pageValue = (rows, field) => {
      const per = Number(url.searchParams.get("per_page")) || 20;
      const page = Number(url.searchParams.get("page")) || 1;
      const on = url.searchParams.get("sort") === "asc";
      const t = (r) => Date.parse(r[field]);
      return rows.slice().sort((a, b) => (on ? t(a) - t(b) : t(b) - t(a))).slice((page - 1) * per, page * per);
    };
    const list = (rows) => {
      const field = url.searchParams.get("order_by") === "updated_at" ? "updated_at" : "created_at";
      const limit = url.searchParams.get(field === "updated_at" ? "updated_after" : "created_after");
      const start = limit ? Date.parse(limit) : -Infinity;
      return pageValue(rows.filter((r) => Date.parse(r[field]) >= start), field);
    };
    if (url.pathname === "/api/v4/user") return reply(200, { id: 7, username: "maintainer", name: "Maintainer", web_url: "http://gitlab.test/maintainer" });
    if (url.pathname === "/api/v4/projects") {
      return reply(200, [{ id: 42, path_with_namespace: "group/project", name: "Project", web_url: "http://gitlab.test/group/project" }]);
    }
    if (url.pathname === "/api/v4/projects/42/merge_requests") return reply(200, list(state.mrs));
    if (url.pathname === "/api/v4/projects/42/issues") return reply(200, list(state.issues));
    if (url.pathname === "/api/v4/projects/42/events") return reply(200, pageValue(state.events, "created_at"));
    return reply(404, { message: "404 Not Found" });
  });
  return { state, server };
}

async function withServer(fn, { withGate = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-trigger-"));
  const bin = path.join(root, "fake-claude");
  const gate = path.join(root, "turn-gate");
  const prevBin = process.env.CLAUDE_BIN;
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  const prevTick = process.env.CBASE_TRIGGER_TICK_MS;
  const prevGate = process.env.CBASE_TEST_TURN_HOLD;
  const prevRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  const gl = fakeGitlab();
  let server;
  let base = "";
  let finished = false;
  try {
    fs.writeFileSync(bin, fakeClaudeEcho);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    if (withGate) process.env.CBASE_TEST_TURN_HOLD = gate; else delete process.env.CBASE_TEST_TURN_HOLD;
    // No restart: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    await new Promise((r) => gl.server.listen(0, "127.0.0.1", r));
    const glBase = `http://127.0.0.1:${gl.server.address().port}`;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"),
      pickDirectory: null, notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Trigger-Test", path: wsPath }) });
    await fn({ base, ws, glBase, gl: gl.state, openGate: () => fs.writeFileSync(gate, "") });
    finished = true;
  } finally {
    if (withGate) { try { fs.writeFileSync(gate, ""); } catch {} }
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    gl.server.closeAllConnections?.();
    await new Promise((r) => gl.server.close(r));
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL; else process.env.CBASE_TRIGGER_POLL = prevPoll;
    if (prevTick === undefined) delete process.env.CBASE_TRIGGER_TICK_MS; else process.env.CBASE_TRIGGER_TICK_MS = prevTick;
    if (prevGate === undefined) delete process.env.CBASE_TEST_TURN_HOLD; else process.env.CBASE_TEST_TURN_HOLD = prevGate;
    if (prevRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = prevRestartGrace;
    // A test must not fail because its temp directory does not go away: a child process still writing causes ENOTEMPTY, which is a
    // statement about the cleanup, not about the product. It is still not hidden — otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

const mr = (iid, title, createdAt) => ({
  id: 1000 + iid, iid, project_id: 42, title, state: "opened",
  created_at: new Date(createdAt).toISOString(), updated_at: new Date(createdAt).toISOString(),
  web_url: `http://gitlab.test/group/project/-/merge_requests/${iid}`,
  source_branch: "feature/x", target_branch: "main", labels: ["review"],
  description: "Description of the MR", author: { id: 9, username: "colleague" },
  references: { full: `group/project!${iid}` },
});

const issue = (iid, title, createdAt) => ({
  id: 2000 + iid, iid, project_id: 42, title, state: "opened",
  created_at: new Date(createdAt).toISOString(), updated_at: new Date(createdAt).toISOString(),
  web_url: `http://gitlab.test/group/project/-/issues/${iid}`, labels: [],
  description: "Description of the issue", author: { id: 9, username: "colleague" },
  references: { full: `group/project#${iid}` },
});

// Create a workflow with a trigger node + one instruction step. `lock: { scope: "off" }` lets events of the same project run side by
// side (the default `project` would put every further one at the lock).
async function makeFlow(base, ws, accountId, { events = ["mr_opened"], intervalSec = 30, lock = undefined } = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, {
    method: "POST", body: JSON.stringify({ name: `MR-Review-${Math.random().toString(36).slice(2, 7)}` }),
  });
  const graph = {
    nodes: [
      { id: "t1", type: "trigger", title: "New MRs", x: 40, y: 40,
        trigger: { source: "gitlab", accountId, scope: "project", projectId: "42", projectPath: "group/project", events, intervalSec } },
      { id: "s1", type: "instruction", title: "Review", text: "Review {{title}} at {{url}}", x: 320, y: 40 },
    ],
    edges: [{ from: "t1", to: "s1" }],
  };
  const saved = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    // `doneAll: false`: "check all work steps" is on by default; here the trigger is the subject.
    method: "PUT", body: JSON.stringify({ graph, run: { doneAll: false }, ...(lock ? { lock } : {}) }),
  });
  return saved;
}

test("a new merge request starts the workflow by itself — with the event in the prompt", async () => {
  process.env.CBASE_TRIGGER_POLL = "0"; // tick off: this test drives the poll itself
  await withServer(async ({ base, ws, glBase, gl }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, {
      method: "POST", body: JSON.stringify({ label: "Fake-GitLab", host: glBase, token: "glpat-test" }),
    });
    // The account comes back WITH the account name from GitLab and WITHOUT the token.
    assert.equal(acc.userName, "maintainer");
    assert.equal(acc.hasToken, true);
    assert.equal("token" in acc, false);

    const flow = await makeFlow(base, ws, acc.id);
    assert.equal(flow.problems.length, 0, `problems: ${JSON.stringify(flow.problems)}`);
    assert.equal(flow.triggers.length, 1);
    assert.equal(flow.triggers[0].missing, "");

    // An MR from the PAST (before arming) must trigger nothing.
    gl.mrs.push(mr(11, "Old MR", Date.now() - 3 * 86_400_000));
    const active = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT", body: JSON.stringify({ active: true }),
    });
    assert.equal(active.active, true);
    const beforeChats = chatList().length;
    let dry = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, { method: "POST", body: "{}" });
    assert.deepEqual(dry.events, [], "history must not trigger");

    // Now the new MR.
    gl.mrs.push(mr(23, "Fix flaky test", Date.now()));
    dry = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, { method: "POST", body: "{}" });
    assert.equal(dry.events.length, 1);
    assert.match(dry.events[0].summary, /New merge request !23 in group\/project: Fix flaky test/);
    assert.equal(dry.fired, 0, "the dry run must start nothing");
    assert.equal(chatList().length, beforeChats, "the dry run must not create a chat");

    // And now really fire.
    const fired = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, {
      method: "POST", body: JSON.stringify({ fire: true }),
    });
    assert.equal(fired.fired, 1);

    const chats = await waitFor(async () => {
      const list = chatList();
      return list.length > beforeChats ? list : null;
    });
    const chat = chats.find((c) => c.title.includes("Fix flaky test"));
    assert.ok(chat, `no chat for the event: ${chats.map((c) => c.title).join(" | ")}`);
    assert.equal(chat.title, "!23 Fix flaky test");

    // The history shows the trigger, the step and the resolved prompt.
    const log = await waitFor(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant") ? l : null;
    });
    const trig = log.filter((m) => m.role === "workflow").map((m) => JSON.parse(m.text)).find((w) => w.kind === "trigger");
    assert.ok(trig, "the trigger line is missing in the history");
    assert.equal(trig.source, "gitlab");
    assert.match(trig.event.summary, /!23/);
    const prompt = log.find((m) => m.role === "assistant").text;
    assert.match(prompt, /Review Fix flaky test at http:\/\/gitlab.test\/group\/project\/-\/merge_requests\/23/);
    assert.match(prompt, /Triggered by GitLab/);
    assert.match(prompt, /Actor: colleague/);

    // The same event does NOT fire again (de-duplication via the event key).
    await waitForQuiet(base);
    const again = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, {
      method: "POST", body: JSON.stringify({ fire: true }),
    });
    assert.equal(again.fired, 0, "the MR fired a second time");
    assert.equal(chatList().length, chats.length);

    // Status: one firing counted, no error.
    const status = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-status`);
    assert.equal(status.active, true);
    assert.equal(status.triggers[0].fires, 1);
    assert.equal(status.triggers[0].lastError, "");
  });
});

// The trigger alarm: an event waiting for the lock of a running workflow must not lie around until the next regular tick — the
// trigger's interval is 300 s here. The tick is COMPLETELY off in this test (CBASE_TRIGGER_POLL=0 at server start, so no poller and
// no initial tick); only after the forced start is the switch set to "1", and `scheduleTriggerDrain` reads it at CALL time. So the
// forced poll after the run ends is the only one in the whole test that can start the second MR. The way there is a setter wired in
// the registration list in `server.js`; an unwired setter does NOTHING, silently — this test is the only one that notices (without
// the registration it fails, the others stay green).
test("the alarm starts the event that waited for the lock as soon as the holder is done", async () => {
  process.env.CBASE_TRIGGER_POLL = "0"; // no poller, no initial tick: only the alarm should poll
  await withServer(async ({ base, ws, glBase, gl, openGate }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, {
      method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }),
    });
    // 300 s minimum interval: a second poll only goes through forced (`force`).
    const flow = await makeFlow(base, ws, acc.id, { intervalSec: 300 });
    // Both MRs lie a few seconds in the future: the waterline only arises at arming, and `created_after` is strict — an event
    // EXACTLY on the line does not count.
    const baseValue = Date.now() + 2_000;
    gl.mrs.push(mr(41, "First MR", baseValue), mr(42, "Second MR", baseValue + 1_000));
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT", body: JSON.stringify({ active: true }),
    });

    // One forced poll: the older MR starts, the younger runs into the lock (default `project` — both events belong to
    // group/project, so the same key).
    const fired = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, {
      method: "POST", body: JSON.stringify({ fire: true }),
    });
    assert.equal(fired.fired, 1, `exactly one should have started: ${JSON.stringify(fired)}`);
    assert.match(fired.error, /warten auf die Sperre|waiting for the lock/, "the second MR should have hung at the lock");
    // From now on the alarm may wake. The poller itself does NOT run (it was never created at server start) —
    // `scheduleTriggerDrain` calls `pollAllTriggers` directly.
    process.env.CBASE_TRIGGER_POLL = "1";

    // A snapshot while the holder runs (its turn holds at the gate): the second must not be in it yet.
    const list = await waitFor(async () => {
      const l = chatList();
      return l.some((c) => c.title.includes("First MR")) ? l : null;
    });
    assert.equal(list.some((c) => c.title.includes("Second MR")), false, "the second MR got past the lock");

    // The holder finishes -> lock free -> emitWorkflowRun wakes the trigger (400 ms later a forced poll). Without the alarm the
    // second MR would lie around for 300 s — this test would then hang until the suite deadline, and the [waiting] line says on what.
    openGate();
    await waitFor(async () => chatList().some((c) => c.title.includes("Second MR")), "the alarm starts the second MR");
  }, { withGate: true });
});

test("arming without a finished trigger is rejected", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  await withServer(async ({ base, ws }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, {
      method: "POST", body: JSON.stringify({ name: "No trigger" }),
    });
    // No trigger in the graph.
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({ graph: { nodes: [{ id: "s1", type: "instruction", title: "Do", text: "Do something" }], edges: [] } }),
    });
    await assert.rejects(
      () => json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) }),
      /400/,
    );
    // Trigger without account/event: also rejected, and the problems say what is missing.
    const half = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({ graph: { nodes: [{ id: "t1", type: "trigger", title: "Raw", trigger: { source: "gitlab" } }], edges: [] } }),
    });
    assert.ok(half.problems.some((p) => /kein GitLab-Konto/.test(p.text)));
    await assert.rejects(
      () => json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) }),
      /400/,
    );
    assert.equal((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`)).active, false);
  });
});

test("a wrong token is rejected on connecting (no half-connected account)", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  await withServer(async ({ base, glBase }) => {
    await assert.rejects(
      () => json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ host: glBase, token: "wrong" }) }),
      /401/,
    );
    assert.deepEqual((await json(`${base}/api/gitlab/accounts`)).accounts, []);
  });
});

// ── Waterline, pages and cap ───────────────────────────────────────────────────────────────────────────────────
// Counter-test: against the old versions the following tests are red (the issue never fires; 20 instead of 150 events, the backlog
// silently drops; 2 instead of 3 starts in the first poll; a kind with more than 1,000 entries stood still for good, the preview
// showed nothing).

const feuer = async (base, ws, flow) => json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, {
  method: "POST", body: JSON.stringify({ fire: true }),
});
const titleList = async (base) => chatList().map((c) => c.title);

// With ONE waterline for all kinds a newer MR lifted it above the issue whose poll had just failed — the issue never came back, and
// the error stood in the status for one tick only. Now every kind has its own line.
test("when one event kind fails, ITS waterline stays put — the others carry on, the error stays visible until it reads again", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  await withServer(async ({ base, ws, glBase, gl }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }) });
    const flow = await makeFlow(base, ws, acc.id, { events: ["mr_opened", "issue_opened"], lock: { scope: "off" } });
    const baseValue = Date.now() + 2_000;
    gl.issues.push(issue(5, "Older issue", baseValue));
    gl.mrs.push(mr(6, "Newer MR", baseValue + 1_000));
    gl.error["/api/v4/projects/42/issues"] = 2; // the next TWO issue polls fail
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) });

    const a = await feuer(base, ws, flow);
    assert.equal(a.fired, 1, JSON.stringify(a));
    assert.match(a.error, /issue_opened: GitLab-Fehler 502/);
    // Another tick with an error and one more MR: the MR line moves on, the error is there again.
    gl.mrs.push(mr(7, "Yet another MR", baseValue + 2_000));
    const b = await feuer(base, ws, flow);
    assert.equal(b.fired, 1, JSON.stringify(b));
    assert.match(b.error, /issue_opened: GitLab-Fehler 502/, "the error stands as long as the kind does not read");
    assert.match((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-status`)).triggers[0].lastError, /issue_opened/);

    // The issue poll works again: the issue from BEFORE both MRs fires now, the MRs not a second time.
    const c = await feuer(base, ws, flow);
    assert.equal(c.fired, 1, `the older issue did not come back after the error: ${JSON.stringify(c)}`);
    assert.equal(c.error, "");
    const title = await titleList(base);
    assert.ok(title.includes("#5 Older issue"), title.join(" | "));
    assert.equal(title.filter((t) => t === "!6 Newer MR").length, 1);
    assert.equal((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-status`)).triggers[0].lastError, "");
  });
});

// Per kind ONE page of 20 was read (the newest) and the caller took the newest 25 of that — what lay below silently dropped. Reading
// descending up to the line would put a kind with more than 1,000 entries since the line to a standstill FOR GOOD: since a line only
// entries are added, the kind would never come back, and even a brand-new MR would never fire again. Now ascending from the line, at
// most 1,000 per poll, the rest on the next tick from the read pointer. This test keeps line and pointer as workflows/triggers.js
// keeps them (`positions` -> line, `further` -> pointer); the way through the trigger itself the test goes afterwards.
// Counter-test: with the descending version red (the backlog delivers nothing, no `further`, !5000 never comes); with the one-page
// version red (20).
test("a backlog over 1,000 entries drains over several polls — nothing drops, no kind stands still, a new MR comes without re-arming", async () => {
  const gitlab = await import("../electron/server/gitlab.js");
  const gl = fakeGitlab();
  await new Promise((r) => gl.server.listen(0, "127.0.0.1", r));
  try {
    const account = { host: `http://127.0.0.1:${gl.server.address().port}`, token: "glpat-test", userId: 7 };
    const trigger = (events) => ({ scope: "project", projectId: "42", projectPath: "group/project", events, labels: "", branch: "", skipMine: false });
    const since = Date.parse("2026-10-01T00:00:00Z");
    const calls = (filePath) => gl.state.calls.filter((c) => c.path.endsWith(filePath)).length;
    // Ticks as in the trigger, per tick `afterTick(n, r)`; returns all events that arrived per key (the boundary of a backlog comes
    // twice — in the trigger `seen` holds back the second firing) and the number of ticks until "complete".
    async function ticks(kind, afterTick = () => {}) {
      const arrival = new Map();
      let line = since;
      let pointer;
      for (let n = 1; n <= 5; n++) {
        gl.state.calls.length = 0;
        const r = await gitlab.pollTrigger(account, trigger([kind]), () => line, { further: () => pointer });
        assert.deepEqual(r.errors, [], `tick ${n}`);
        for (const e of r.events) if (!arrival.has(e.key)) arrival.set(e.key, e);
        afterTick(n, r);
        if (Object.hasOwn(r.positions, kind)) return { arrival, ticks: n, line: r.positions[kind] };
        assert.ok(Object.hasOwn(r.further ?? {}, kind), `tick ${n}: neither read completely nor a read pointer — the kind would stand still`);
        pointer = r.further[kind];
      }
      assert.fail(`not read completely after 5 ticks (${arrival.size} events arrived)`);
    }

    // 150 MRs: one tick, oldest first, the line at the newest.
    for (let i = 1; i <= 150; i++) gl.state.mrs.push(mr(i, `MR ${i}`, since + i * 1_000));
    const r = await gitlab.pollTrigger(account, trigger(["mr_opened"]), since);
    assert.equal(r.events.length, 150, `only ${r.events.length} of 150 MRs arrived`);
    assert.deepEqual(r.events.slice(0, 2).map((e) => e.ref), ["!1", "!2"], "oldest first — they fire first");
    assert.equal(r.positions.mr_opened, since + 150_000, "the kind is read up to the newest");
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.hints ?? [], []);

    // 1,001 MRs since the line: the first tick reads the oldest (at most ten calls; at every page boundary the keyset reads one entry
    // twice), returns the read pointer and says in the status that more comes; ONLY THEN !5000 arises, newer than all — it comes on the
    // next tick, without re-arming.
    gl.state.mrs.length = 0;
    for (let i = 1; i <= 1_001; i++) gl.state.mrs.push(mr(i, `MR ${i}`, since + i * 1_000));
    const mrs = await ticks("mr_opened", (n, t) => {
      assert.ok(calls("/merge_requests") <= 10, `tick ${n}: ${calls("/merge_requests")} calls`);
      if (n !== 1) return;
      assert.ok(t.events.length >= 900, `only ${t.events.length} in the first tick`);
      assert.deepEqual(t.events.map((e) => e.ref), Array.from({ length: t.events.length }, (_, i) => `!${i + 1}`), "the oldest first, gapless");
      assert.equal(t.hints.length, 1);
      assert.match(t.hints[0], /^mr_opened: mehr als 1000 Einträge seit \S+ — die weiteren im nächsten Takt\.$/);
      gl.state.mrs.push(mr(5000, "Brand-new MR", since + 5_000_000));
    });
    assert.equal(mrs.ticks, 2);
    assert.equal(mrs.arrival.size, 1_002, `${mrs.arrival.size} of 1,002 MRs arrived`);
    for (let i = 1; i <= 1_001; i++) assert.ok(mrs.arrival.has(`mr_opened:42:${i}`), `!${i} is missing`);
    assert.ok(mrs.arrival.has("mr_opened:42:5000"), "!5000 (after the cap) never came");
    assert.equal(mrs.line, since + 5_000_000);

    // Keyset instead of page offset: ascending by `updated_at` an entry that is changed WHILE reading moves to the end. With an offset
    // everything would then move up one place, and !101 would fall through between page 1 and 2.
    gl.state.mrs.length = 0;
    for (let i = 1; i <= 250; i++) gl.state.mrs.push({ ...mr(i, `MR ${i}`, since - 86_400_000 + i), updated_at: new Date(since + i * 1_000).toISOString() });
    let mrRequests = 0;
    gl.state.beforeRequest = (c) => {
      if (c.path.endsWith("/merge_requests") && ++mrRequests === 2) gl.state.mrs[49].updated_at = new Date(since + 900_000).toISOString();
    };
    const changed = await ticks("mr_updated");
    gl.state.beforeRequest = null;
    assert.equal(mrRequests >= 2, true, "the change did not come between two pages");
    for (let i = 1; i <= 250; i++) assert.ok(changed.arrival.has(`mr_updated:42:${i}:${since + i * 1_000}`), `the change to !${i} is missing`);
    assert.ok(changed.arrival.has(`mr_updated:42:50:${since + 900_000}`), "the second change to !50 is missing");

    // The feed (comments) knows only a day-precise `after`: a lead-in lies before the line. 100 before, 1,050 after: two ticks, every
    // comment after the line once, none before.
    const comment = (i, at) => ({ id: 5000 + i, created_at: new Date(at).toISOString(), author: { id: 9, username: "k" },
      target_type: "MergeRequest", target_iid: 1, target_title: "MR 1", note: { body: `Comment ${i}` } });
    for (let i = 1; i <= 1_150; i++) gl.state.events.push(comment(i, since + (i - 100) * 1_000));
    const feed = await ticks("comment", (n, t) => {
      if (n === 1) assert.match(t.hints[0] ?? "", /^comment: mehr als 1000 Einträge seit \S+ — die weiteren im nächsten Takt\.$/);
    });
    assert.equal(feed.ticks, 2);
    assert.equal(feed.arrival.size, 1_050, `${feed.arrival.size} of 1,050 comments after the line`);
    assert.ok([...feed.arrival.values()].every((e) => e.at > since), "a comment from before the line arrived");

    // A lead-in over 1,000 entries (a busy project in one day) does not eat the page budget: skipped in a gallop, the 10 comments
    // after it come in the first tick — with few calls instead of 26.
    gl.state.events.length = 0;
    for (let i = 1; i <= 2_510; i++) gl.state.events.push(comment(i, since + (i - 2_500) * 10));
    const leadTime = await ticks("comment", (n) => assert.ok(calls("/events") <= 12, `tick ${n}: ${calls("/events")} calls`));
    assert.equal(leadTime.ticks, 1);
    assert.deepEqual([...leadTime.arrival.values()].map((e) => e.key), Array.from({ length: 10 }, (_, i) => `comment:${7_501 + i}`));
  } finally {
    gl.server.closeAllConnections?.();
    await new Promise((r) => gl.server.close(r));
  }
});

// The same backlog through the trigger: 1,001 MRs since the line, five of them (!1–!5) really changed, the rest only created — for
// "updated" five events, but every one must still be read. The older version then stood still for good ("cap: this kind fires
// nothing", the only way out re-arming, which discards the backlog), and even a real change to a new MR never fired. Plus the way
// only the trigger goes: the read pointer is in the DB (`continue_kind`), and it falls back behind an event that the active cap defers
// — otherwise the next tick would read on behind !4 and !5, and both would never come. Counter-test: red against the older versions.
test("the trigger works off a backlog over 1,000 entries — deferred ones come, a new change fires without re-arming", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  await withServer(async ({ base, ws, glBase, gl }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }) });
    const flow = await makeFlow(base, ws, acc.id, { events: ["mr_updated"], lock: { scope: "off" } });
    const baseValue = Date.now() + 2_000;
    for (let i = 1; i <= 1_001; i++) {
      const m = mr(i, `MR ${i}`, baseValue + i * 10);
      gl.mrs.push(i <= 5 ? { ...m, updated_at: new Date(baseValue + i * 10 + 5).toISOString() } : m);
    }
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) });

    // First tick: the oldest (up to ten pages), three starts (active cap), !4 and !5 deferred.
    const a = await feuer(base, ws, flow);
    assert.equal(a.fired, 3, JSON.stringify(a));
    assert.match(a.error, /^mr_updated: mehr als 1000 Einträge seit \S+ — die weiteren im nächsten Takt\. · 2 Ereignisse warten \(schon 3 ausgelöste Läufe aktiv\)\.$/);
    // Only AFTER the cap: an MR newer than all, and a real change to it.
    gl.mrs.push({ ...mr(5000, "Brand-new MR", baseValue + 20_000), updated_at: new Date(baseValue + 30_000).toISOString() });
    await waitForQuiet(base);
    // On, until !5000 is there — five ticks at most; none of them reports an error.
    for (let n = 2; n <= 6 && !(await titleList(base)).includes("!5000 Brand-new MR"); n++) {
      assert.ok(n < 6, "after five ticks no chat for !5000 — the kind does not get through its backlog");
      const t = await feuer(base, ws, flow);
      assert.doesNotMatch(t.error, /löst nichts aus|Fehler/, `tick ${n}: ${t.error}`);
      await waitForQuiet(base);
    }
    const title = (await titleList(base)).filter((x) => x.startsWith("!"));
    for (const i of [1, 2, 3, 4, 5]) assert.equal(title.filter((x) => x === `!${i} MR ${i}`).length, 1, `!${i}: ${title.join(" | ")}`);
    assert.equal(title.filter((x) => x === "!5000 Brand-new MR").length, 1);
    assert.equal(title.length, 6, `only the five changes and !5000 — ${title.join(" | ")}`);
    assert.equal((await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-status`)).triggers[0].lastError, "");
    assert.equal((await feuer(base, ws, flow)).fired, 0, "a change fired a second time");
  });
});

// The dry run "check now" went through the cap of the armed trigger: for a busy kind (24 h back) it showed NOTHING at all, claimed
// "this kind fires nothing" — wrong for the armed trigger, whose line stands near NOW — and cost up to ten calls per kind. Now: ONE
// page per kind, the newest, and a sentence that speaks only about the preview. Counter-test: with the old version red (no events,
// ten calls, cap sentence).
test("the dry run reads ONE page per kind (the newest) and speaks only about the preview", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  await withServer(async ({ base, ws, glBase, gl }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }) });
    const flow = await makeFlow(base, ws, acc.id);
    const baseValue = Date.now() - 3_600_000;
    for (let i = 1; i <= 1_001; i++) gl.mrs.push(mr(i, `MR ${i}`, baseValue + i * 1_000));
    gl.calls.length = 0;
    const prior = chatList().length;
    const dry = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}/trigger-test`, { method: "POST", body: "{}" });
    assert.equal(gl.calls.filter((c) => c.path.endsWith("/merge_requests")).length, 1, "one call per kind");
    assert.equal(dry.fired, 0);
    assert.equal(dry.events.length, 10, JSON.stringify(dry));
    assert.match(dry.events.at(-1).summary, /!1001/, "the preview shows the newest");
    assert.match(dry.error, /^Vorschau: je Art die neuesten 20 — mr_opened hat seit \S+ mehr\.$/);
    assert.equal(chatList().length, prior, "the dry run must start nothing");
  });
});

// `activeTriggerRuns() + fired` counted every just-started run twice (2 instead of 3 starts per poll), and the per-poll cap set the
// remaining events to `seen` and pushed the line over them — silently lost as soon as it stood smaller than that of the active runs.
// Both caps now only defer.
test("the cap counts every start once and defers instead of discarding — the per-poll cap too", async () => {
  process.env.CBASE_TRIGGER_POLL = "0";
  const prevFires = process.env.CBASE_TRIGGER_MAX_FIRES;
  try {
    await withServer(async ({ base, ws, glBase, gl }) => {
      const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }) });
      const flow = await makeFlow(base, ws, acc.id, { lock: { scope: "off" } });
      const baseValue = Date.now() + 2_000;
      for (let i = 1; i <= 5; i++) gl.mrs.push(mr(50 + i, `Batch ${i}`, baseValue + i * 100));
      await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) });

      const a = await feuer(base, ws, flow);
      assert.equal(a.fired, 3, `default 3 concurrent runs — ${JSON.stringify(a)}`);
      assert.match(a.error, /^2 Ereignisse warten \(schon 3 ausgelöste Läufe aktiv\)\.$/);
      await waitForQuiet(base);
      const b = await feuer(base, ws, flow);
      assert.equal(b.fired, 2, JSON.stringify(b));
      await waitForQuiet(base);

      // Per-poll cap (1) smaller than that of the active runs (3): the rest waits for the next tick.
      process.env.CBASE_TRIGGER_MAX_FIRES = "1";
      for (let i = 1; i <= 3; i++) gl.mrs.push(mr(60 + i, `Tick ${i}`, baseValue + 10_000 + i * 100));
      const c = await feuer(base, ws, flow);
      assert.equal(c.fired, 1, JSON.stringify(c));
      assert.match(c.error, /^2 Ereignisse warten auf den nächsten Takt \(Deckel 1 Starts je Abfrage\)\.$/);
      assert.equal((await feuer(base, ws, flow)).fired, 1);
      assert.equal((await feuer(base, ws, flow)).fired, 1, "the third event did not come back");
      await waitForQuiet(base);
      const title = await titleList(base);
      for (let i = 1; i <= 5; i++) assert.equal(title.filter((t) => t === `!${50 + i} Batch ${i}`).length, 1, `Batch ${i}`);
      for (let i = 1; i <= 3; i++) assert.equal(title.filter((t) => t === `!${60 + i} Tick ${i}`).length, 1, `Tick ${i}`);
    });
  } finally {
    if (prevFires === undefined) delete process.env.CBASE_TRIGGER_MAX_FIRES; else process.env.CBASE_TRIGGER_MAX_FIRES = prevFires;
  }
});

// The tick test stands at the END of the file: its poller is module state and keeps running after the test (triggerTimer is never
// cleared) — before it, it would run into the alarm test and poll its trigger before the test does.
test("the tick fires without any call — and a deactivated workflow stays silent", async () => {
  process.env.CBASE_TRIGGER_POLL = "1";
  await withServer(async ({ base, ws, glBase, gl }) => {
    const acc = await json(`${base}/api/gitlab/accounts`, {
      method: "POST", body: JSON.stringify({ host: glBase, token: "glpat-test" }),
    });
    const flow = await makeFlow(base, ws, acc.id, { intervalSec: 30 });
    // NOT armed: the tick must do nothing. Proven by two COMPLETE polls of the poller (test seam workflows/triggers.js triggerCycles).
    gl.mrs.push(mr(31, "Silent MR", Date.now()));
    const before = chatList().length;
    const cycles = triggerCycles();
    await waitFor(() => triggerCycles() >= cycles + 2, "the tick polls twice");
    await waitForQuiet(base);
    assert.equal(chatList().length, before, "a non-armed workflow fired");

    // Arming: the interval is 30 s, but lastPollAt is set to 0 -> poll at once. The MR from above lies BEFORE arming, so a new one is
    // needed — one second ahead, because `created_after` is strict and an MR in the same millisecond as arming would never come.
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ active: true }) });
    gl.mrs.push(mr(32, "Ticked MR", Date.now() + 1000));
    const chats = await waitFor(async () => {
      const list = chatList();
      return list.some((c) => c.title.includes("Ticked MR")) ? list : null;
    }, "the tick fires the ticked MR");
    assert.ok(chats?.some((c) => c.title.includes("Ticked MR")), "the tick did not fire");
    assert.ok(chats.every((c) => !c.title.includes("Silent MR")), "the MR from before arming fired");
  });
});
