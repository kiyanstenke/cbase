// Run settings per workflow: provider, model, permissions, effort (and ultracode). A triggered run has no user
// choosing these in the composer — so they must hang on the workflow and take effect when the chat is created.
// Also: the entry (start node) is optional.
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
// Wait for an EVENT, without a deadline: under load a deadline measures the machine. If it hangs, the
// suite deadline is the emergency brake; every 30 s a line on stderr says what is being waited for.
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

// ── Pure logic ────────────────────────────────────────────────────────────────────────────────

test("Run settings: nonsense drops out, empty fields overwrite nothing", () => {
  const s = wf.normalizeRunSettings({ provider: "codex", model: "gpt-5.6-sol", permissionMode: "nonsense", effort: "turbo", todos: "yes" });
  assert.equal(s.provider, "codex");
  assert.equal(s.model, "gpt-5.6-sol");
  assert.equal(s.permissionMode, "", "unknown mode must drop out");
  assert.equal(s.effort, "", "unknown effort must drop out");
  // `todos` ("may create todos") no longer exists — an old field drops out on normalizing.
  assert.equal("todos" in s, false, "the field todos is gone");
  assert.equal("todos" in wf.normalizeRunSettings({ todos: true }), false, "even a real true is silently discarded");
  // The compaction, completion-check and cap fields ALWAYS stand in the output — with their defaults: compaction
  // "default" (null), "check all work steps" ON, 3 rounds, a question at both caps.
  assert.deepEqual(wf.normalizeRunSettings(null), {
    provider: "", model: "", permissionMode: "", effort: "", ultracode: false, doneProvider: "", doneModel: "",
    autocompact: null, autocompactMax: null, doneAll: true, doneRounds: 3, doneCapAuto: false, loopCapAuto: false,
  });
  // Only SET fields become chat fields — otherwise an empty field would erase a chat choice.
  assert.deepEqual(wf.chatFieldsFromRun({ provider: "claude", model: "", permissionMode: "plan", effort: "", todos: true }),
    { provider: "claude", permissionMode: "plan" });
  // The model of the completion check belongs to the gate, never to the chat: it must appear in no
  // chat field — otherwise the agent itself would run with the checking model.
  const gate = wf.normalizeRunSettings({ doneProvider: " claude ", doneModel: " claude-opus-5 " });
  assert.equal(gate.doneProvider, "claude");
  assert.equal(gate.doneModel, "claude-opus-5");
  assert.deepEqual(wf.chatFieldsFromRun({ provider: "", model: "", permissionMode: "", effort: "", doneProvider: "claude", doneModel: "claude-opus-5" }), {});
  assert.deepEqual(wf.chatFieldsFromRun(null), {});
  // Ultracode is the fifth chat field: on ⇒ the switch, the run's level stays beside it
  // (independent); off ⇒ nothing (the chat keeps its switch).
  assert.equal(wf.normalizeRunSettings({ ultracode: "yes" }).ultracode, false, "ultracode is on only for a real true");
  assert.deepEqual(wf.chatFieldsFromRun({ effort: "low", ultracode: true }), { effort: "low", ultracode: true });
  assert.deepEqual(wf.chatFieldsFromRun({ ultracode: true }), { ultracode: true }, "the switch brings no level");
  assert.deepEqual(wf.chatFieldsFromRun({ effort: "low", ultracode: false }), { effort: "low" });
});

test("The entry is optional: without a start node the run begins at the first free step", () => {
  const g = wf.normalizeGraph({
    nodes: [
      { id: "a", type: "instruction", title: "First", text: "do" },
      { id: "b", type: "instruction", title: "Second", text: "do more" },
    ],
    edges: [{ from: "a", to: "b" }],
  });
  assert.equal(wf.entryNodeId(g), "a", "without a start the step without an incoming edge must be the entry");
  assert.equal(wf.initialCursor(g, "Input").at, "a");
  // A start node wins as soon as there is one (order in the graph does not matter).
  const withStart = wf.normalizeGraph({
    nodes: [
      { id: "a", type: "instruction", title: "First", text: "do" },
      { id: "s", type: "start", title: "Start" },
    ],
    edges: [{ from: "s", to: "a" }],
  });
  assert.equal(wf.entryNodeId(withStart), "s");
  // And without nodes there is no entry (the editor warns, the run ends immediately).
  assert.equal(wf.entryNodeId(wf.normalizeGraph({ nodes: [], edges: [] })), null);
  const problems = wf.checkGraph({ nodes: [], edges: [] });
  assert.ok(problems.some((p) => /keine Schritte/.test(p.text)), `Hint missing: ${JSON.stringify(problems)}`);
});

// ── Whole chain ────────────────────────────────────────────────────────────────────────────────

// With a gate (CBASE_TEST_TURN_HOLD) a turn reports "<gate>.reached" and answers only once the test creates
// the gate — "the step is running right now" is thus a state the test can wait for.
const fakeClaude = (delayMs) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ result: '{"yes": true, "note": "ok"}' }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  // The call's arguments land in a file next to it — so the test checks WITH which model and
  // which permissions the step was really started.
  try { require("node:fs").writeFileSync(process.env.CBASE_TEST_ARGV_OUT || "/dev/null", argv.join(" ")); } catch {}
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const gate = process.env.CBASE_TEST_TURN_HOLD || "";
    if (gate) { try { fs.writeFileSync(gate + ".reached", ""); } catch {} }
    const respond = () => {
      if (gate && !fs.existsSync(gate)) return setTimeout(respond, 20);
      setTimeout(() => {
        say({ type: "assistant", message: { content: [{ type: "text", text: "OK" }] } });
        say({ type: "result", result: "OK", session_id: "run-settings" });
      }, ${delayMs});
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

async function withServer(fn, { delayMs = 0, withGate = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-runset-"));
  const bin = path.join(root, "fake-claude");
  const argvOut = path.join(root, "argv.txt");
  const gate = path.join(root, "turn-gate");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL, argv: process.env.CBASE_TEST_ARGV_OUT,
    gate: process.env.CBASE_TEST_TURN_HOLD, restartGrace: process.env.CBASE_RESTART_GRACE_MS,
  };
  const gl = fakeGitlab();
  let server, base = "", finished = false;
  try {
    fs.writeFileSync(bin, fakeClaude(delayMs));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_ARGV_OUT = argvOut;
    if (withGate) process.env.CBASE_TEST_TURN_HOLD = gate; else delete process.env.CBASE_TEST_TURN_HOLD;
    // No restart: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    await new Promise((r) => gl.server.listen(0, "127.0.0.1", r));
    const glBase = `http://127.0.0.1:${gl.server.address().port}`;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Settings", path: wsPath }) });
    const acc = await json(`${base}/api/gitlab/accounts`, { method: "POST", body: JSON.stringify({ label: "Fake", host: glBase, token: "glpat-test" }) });
    await fn({
      base, ws, acc, gl: gl.state, argvOut,
      gate: {
        reached: () => fs.existsSync(`${gate}.reached`),
        open: () => fs.writeFileSync(gate, ""),
        close: () => { fs.rmSync(gate, { force: true }); fs.rmSync(`${gate}.reached`, { force: true }); },
      },
    });
    finished = true;
  } finally {
    if (withGate) { try { fs.writeFileSync(gate, ""); } catch {} }
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    gl.server.closeAllConnections?.();
    await new Promise((r) => gl.server.close(r));
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll], ["CBASE_TEST_ARGV_OUT", prev.argv],
                          ["CBASE_TEST_TURN_HOLD", prev.gate], ["CBASE_RESTART_GRACE_MS", prev.restartGrace]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // A test must not fail because its temp directory cannot be removed: a child process still
    // writing causes ENOTEMPTY, which says something about cleanup, not about the product. It is
    // still reported — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// Workflow with trigger + one step. `run` = run settings, `graph` overridable.
async function makeFlow(base, ws, accountId, { run, lock, graph } = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, {
    method: "POST", body: JSON.stringify({ name: `Sett-${Math.random().toString(36).slice(2, 7)}` }),
  });
  const g = graph || {
    nodes: [
      { id: "t1", type: "trigger", title: "New MRs", x: 40, y: 40,
        trigger: { source: "gitlab", accountId, scope: "project", projectId: "42", projectPath: "group/project", events: ["mr_opened"], intervalSec: 30, skipMine: false } },
      { id: "s1", type: "instruction", title: "Implement", text: "Implement {{title}}", x: 320, y: 40 },
    ],
    edges: [{ from: "t1", to: "s1" }],
  };
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
    // `doneAll: false`: "check all work steps" is on by default; these tests check the transfer of the
    // settings, not the closing gate.
    method: "PUT", body: JSON.stringify({ graph: g, run: { doneAll: false, ...(run || {}) }, ...(lock ? { lock } : {}) }),
  });
}
const arm = (base, ws, id) => json(`${base}/api/workspaces/${ws.id}/workflows/${id}`, { method: "PUT", body: JSON.stringify({ active: true }) });
const poll = (base, ws, id) => json(`${base}/api/workspaces/${ws.id}/workflows/${id}/trigger-test`, { method: "POST", body: JSON.stringify({ fire: true }) });

test("A triggered run inherits provider, model, permissions and effort of the workflow", async () => {
  await withServer(async ({ base, ws, acc, gl, argvOut }) => {
    const flow = await makeFlow(base, ws, acc.id, {
      run: { provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "plan", effort: "high" },
    });
    assert.deepEqual(flow.run, {
      provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "plan", effort: "high", ultracode: false, doneProvider: "", doneModel: "",
      autocompact: null, autocompactMax: null, doneAll: false, doneRounds: 3, doneCapAuto: false, loopCapAuto: false,
    });
    await arm(base, ws, flow.id);
    gl.mrs.push(mr(1, "With settings", Date.now() + 1000));
    assert.equal((await poll(base, ws, flow.id)).fired, 1);

    // The triggered chat carries the settings — it came into being without a composer.
    const chat = await waitFor(async () => {
      const list = await json(`${base}/api/chats?workspaceId=${ws.id}`);
      return list.find((c) => c.title.includes("With settings")) || null;
    });
    assert.ok(chat, "no triggered chat found");
    assert.equal(chat.provider, "claude");
    assert.equal(chat.model, "claude-haiku-4-5-20251001");
    assert.equal(chat.permissionMode, "plan");
    assert.equal(chat.effort, "high");

    // And the turn was REALLY started with it (CLI arguments written along).
    // Read only once the arguments are in (the file comes into being with the spawn).
    const argv = await waitFor(() => {
      const t = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8") : "";
      return t.includes("--permission-mode") ? t : null;
    });
    assert.match(argv, /--model claude-haiku-4-5-20251001/, `Model missing in the call: ${argv}`);
    assert.match(argv, /--permission-mode plan/, `Permissions missing in the call: ${argv}`);
  });
});

test("A manual run switches its chat to the workflow settings", async () => {
  await withServer(async ({ base, ws, acc }) => {
    const flow = await makeFlow(base, ws, acc.id, {
      run: { provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "acceptEdits", effort: "" },
      // Manual start: the trigger does not interfere here (workflow stays inactive).
      graph: {
        nodes: [{ id: "s0", type: "start", title: "Start", x: 40, y: 40 },
                { id: "n1", type: "instruction", title: "Do", text: "Do something", x: 300, y: 40 }],
        edges: [{ from: "s0", to: "n1" }],
      },
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions" }),
    });
    assert.equal(chat.model, "claude-sonnet-5");
    await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "go" }) });

    const converted = await waitFor(async () => {
      const c = await json(`${base}/api/chats/${chat.id}`);
      return c.model === "claude-haiku-4-5-20251001" ? c : null;
    });
    assert.ok(converted, "the chat was not switched to the workflow model");
    assert.equal(converted.permissionMode, "acceptEdits");
  });
});

// The run setting "may create todos" (`run.todos`) is gone together with the task list (route POST /api/todos, tools
// cbase_todo_*). What remains: an OLD definition that still sends `todos: true` loses the field on saving, and the
// creation path no longer exists.
test("Todos: the old field todos:true of the run settings is discarded — and the creation path no longer exists", async () => {
  await withServer(async ({ base, ws, acc }) => {
    const on = await makeFlow(base, ws, acc.id, {
      run: { provider: "", model: "", permissionMode: "", effort: "", todos: true },
      lock: { scope: "off", template: "" },
    });
    assert.equal("todos" in on.run, false, "the old field is not stored");
    const way = await json(`${base}/api/todos`, { method: "POST", body: JSON.stringify({ agent: true, workspaceId: ws.id, title: "Must not" }) })
      .then(() => null, (e) => e);
    assert.ok(way, "POST /api/todos answered");
    assert.equal(way.status, 404, "the route is gone");
  });
});

test("A freshly created workflow is EMPTY (no start node) and can be saved without an entry", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Empty" }) });
    assert.deepEqual(flow.graph, { nodes: [], edges: [] }, "a new workflow must not prefill anything");
    assert.ok(flow.problems.some((p) => /keine Schritte/.test(p.text)));
    // Only one step, no start: saveable, and the run would begin there.
    const saved = await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({ graph: { nodes: [{ id: "n1", type: "instruction", title: "Alone", text: "do" }], edges: [] } }),
    });
    assert.equal(saved.graph.nodes.length, 1);
    assert.equal(saved.problems.filter((p) => p.level === "error").length, 0, `no errors expected: ${JSON.stringify(saved.problems)}`);
  });
});

// ── Back to default ─────────────────────────────────────────────────
// Setting provider, permissions or effort back to "default" after a choice must save: three statements per field —
// missing = unchanged (partial patch), empty = back to default, unknown and non-empty = 400 with wording. (The check
// "only what changed" must not see the EMPTY field as a change to an unknown value.) We wait here for the event,
// never for a clock — if a path hangs, the suite deadline ends it.
const SET = { provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "plan", effort: "high" };
const STANDARD = { provider: "", model: "", permissionMode: "", effort: "" };
const four = (run) => ({ provider: run.provider, model: run.model, permissionMode: run.permissionMode, effort: run.effort });
async function response(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function wait(fn) {
  for (;;) { const v = await fn(); if (v) return v; await sleep(40); }
}

test("Back to default: empty is stored, missing means unchanged, only an unknown value is a 400", async () => {
  await withServer(async ({ base, ws, acc }) => {
    const flow = await makeFlow(base, ws, acc.id, { run: SET });
    assert.deepEqual(four(flow.run), SET, "the test setup is wrong");
    const url = `${base}/api/workspaces/${ws.id}/workflows/${flow.id}`;
    const put = (run, extra = {}) => response(url, { method: "PUT", body: JSON.stringify({ ...extra, run }) });
    const saved = () => four(wf.normalizeRunSettings(store.getWorkflow(flow.id).run));

    // 1) All three together — like the editor: "Default (global)" at the provider takes the model along.
    let r = await put(STANDARD);
    assert.equal(r.status, 200, `Reset rejected: ${JSON.stringify(r.body)}`);
    assert.deepEqual(four(r.body.run), STANDARD);
    assert.deepEqual(four(store.getWorkflow(flow.id).run), STANDARD, "stored means: the row holds empty");
    assert.deepEqual(four((await json(url)).run), STANDARD, "after reloading it is default");

    // 2) Each field ALONE — not only all three together.
    for (const field of ["provider", "permissionMode", "effort"]) {
      assert.equal((await put(SET)).status, 200);
      r = await put({ [field]: "" });
      assert.equal(r.status, 200, `${field} reset alone: ${JSON.stringify(r.body)}`);
      assert.deepEqual(saved(), { ...SET, [field]: "" }, `${field}: only this field becomes empty`);
    }

    // 3) A MISSING field is no statement: the stored value stays.
    assert.equal((await put(SET)).status, 200);
    // The body carries only a FOREIGN field — now the old `todos` ("may create todos", gone):
    // 200, the four fields stay, and the field itself is silently discarded (an old client gets no 400).
    r = await put({ todos: true });
    assert.equal(r.status, 200);
    assert.deepEqual(saved(), SET, "missing means unchanged");
    assert.equal("todos" in r.body.run, false, "an old todos is not stored");

    // 4) An unknown, NON-empty value stays a 400 — with wording, and nothing is written.
    for (const [field, value, wording] of [
      ["provider", "nonexistent", /Unbekannter Anbieter „nonexistent“/],
      ["permissionMode", "nonsense", /Unbekannte Rechte-Stufe „nonsense“/],
      ["effort", "turbo", /Unbekannte Denkstufe „turbo“/],
      // Whitespace is not "empty" for the level — the save verdict knows only "" (effort storable).
      ["effort", " ", /Unbekannte Denkstufe „ “/],
    ]) {
      r = await put({ [field]: value });
      assert.equal(r.status, 400, `${field} = ${JSON.stringify(value)} must be rejected`);
      assert.match(String(r.body?.error), wording);
      assert.deepEqual(saved(), SET, `${field}: rejected means nothing stored`);
    }

    // 5) "Check only what changed" stays: a stored value that has become unknown (the provider is gone —
    // created past the store, the route cannot produce it) does not lock the workflow out if the editor
    // sends it back unchanged.
    store.updateWorkflow(flow.id, { run: { ...store.getWorkflow(flow.id).run, provider: "provider-of-yesterday" } });
    const loaded = await json(url);
    assert.equal(loaded.run.provider, "provider-of-yesterday", "the test setup is wrong");
    r = await put(loaded.run, { name: "Renamed" });
    assert.equal(r.status, 200, `a stored value locks the workflow out: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.name, "Renamed");
    assert.equal(saved().provider, "provider-of-yesterday", "unchanged means: it stays");
    // The server normalizes permissions and level already on reading — an old value comes back empty,
    // and sending empty back is no 400 there either.
    store.updateWorkflow(flow.id, { run: { ...store.getWorkflow(flow.id).run, permissionMode: "mode-of-yesterday", effort: "ultra" } });
    const loaded2 = await json(url);
    assert.deepEqual([loaded2.run.permissionMode, loaded2.run.effort], ["", ""]);
    assert.equal((await put(loaded2.run, { name: "Again" })).status, 200);
    // And one can also reset from the stored value.
    r = await put({ ...loaded.run, provider: "" });
    assert.equal(r.status, 200);
    assert.equal(saved().provider, "");
  });
});

test("A run after the reset behaves like one whose field was never set", async () => {
  await withServer(async ({ base, ws, acc, argvOut }) => {
    const graph = {
      nodes: [{ id: "s0", type: "start", title: "Start", x: 40, y: 40 },
              { id: "n1", type: "instruction", title: "Do", text: "Do something", x: 300, y: 40 }],
      edges: [{ from: "s0", to: "n1" }],
    };
    // Two workflows: one that never had anything, and one that was set and reset.
    const never = await makeFlow(base, ws, acc.id, { graph, lock: { scope: "off", template: "" } });
    const back = await makeFlow(base, ws, acc.id, { run: SET, graph, lock: { scope: "off", template: "" } });
    const r = await response(`${base}/api/workspaces/${ws.id}/workflows/${back.id}`, { method: "PUT", body: JSON.stringify({ run: STANDARD }) });
    assert.equal(r.status, 200, `Reset rejected: ${JSON.stringify(r.body)}`);
    // What a triggered run (triggers.js) and an item (proposal-ops.js) put on their new chat is the same
    // computation as for the manual start — and it yields nothing for both.
    assert.deepEqual(wf.chatFieldsFromRun(store.getWorkflow(back.id).run), wf.chatFieldsFromRun(store.getWorkflow(never.id).run));
    assert.deepEqual(wf.chatFieldsFromRun(store.getWorkflow(back.id).run), {});

    // Started manually on a chat each with its OWN choice: neither switches it, and the CLI gets
    // the same model, the same permissions and the same level.
    const ownChoice = { provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "low" };
    const run = async (flow) => {
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, ...ownChoice }) });
      fs.rmSync(argvOut, { force: true });
      await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "go" }) });
      // The file comes into being with the spawn; read only once the arguments are in.
      const argv = await wait(() => {
        const t = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8") : "";
        return t.includes("--permission-mode") ? t : null;
      });
      // The run is finished when the server rests — `busy` alone does not see verdicts and oneshots.
      await waitForQuiet(base);
      const target = await json(`${base}/api/chats/${chat.id}`);
      const flag = (name) => (argv.match(new RegExp(`--${name} (\\S+)`)) || [])[1] || "";
      return { chat: four(target), cli: { model: flag("model"), permission: flag("permission-mode"), effort: flag("effort") } };
    };
    const a = await run(never);
    const b = await run(back);
    assert.deepEqual(b, a, "reset and never set run the same");
    assert.deepEqual(b.chat, ownChoice, "an empty field does not overwrite the chat's choice");
    assert.deepEqual(b.cli, { model: "claude-sonnet-5", permission: "bypassPermissions", effort: "low" });
  }, { delayMs: 200 });
});

// ── Ultracode in the run settings ──────────────
// Saving: on/off, a partial patch without the field leaves it, a non-boolean is a 400.
// Running: the driver sets the switch on the chat and leaves the level (independent) —
// Sonnet 5 spawns with the chat's level, Haiku 4.5 carries no levels and spawns WITHOUT `--effort`, the
// switch stands anyway. A run level does not switch off an ultracode chat. Counter-test: without the
// fifth field in chatFieldsFromRun the switch never reaches the chat — the run half turns red.
test("Ultracode in the run settings: saving as on the chat, and the switch leaves the level", async () => {
  await withServer(async ({ base, ws, acc, argvOut }) => {
    const graph = {
      nodes: [{ id: "s0", type: "start", title: "Start", x: 40, y: 40 },
              { id: "n1", type: "instruction", title: "Do", text: "Do something", x: 300, y: 40 }],
      edges: [{ from: "s0", to: "n1" }],
    };
    const flow = await makeFlow(base, ws, acc.id, { graph, lock: { scope: "off", template: "" } });
    assert.equal(flow.run.ultracode, false, "off by default");
    const url = `${base}/api/workspaces/${ws.id}/workflows/${flow.id}`;
    const put = (run) => response(url, { method: "PUT", body: JSON.stringify({ run }) });
    const saved = () => wf.normalizeRunSettings(store.getWorkflow(flow.id).run).ultracode;

    let r = await put({ ultracode: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.run.ultracode, true, "the response carries the mode");
    assert.equal(saved(), true);
    assert.equal((await json(url)).run.ultracode, true, "on after reloading");
    r = await put({ todos: true });
    assert.equal(r.status, 200);
    assert.equal(saved(), true, "missing means unchanged");
    for (const value of ["yes", 1, null, "true"]) {
      r = await put({ ultracode: value });
      assert.equal(r.status, 400, `ultracode = ${JSON.stringify(value)} must be rejected`);
      assert.match(String(r.body?.error), /Ultracode ist an oder aus/);
      assert.equal(saved(), true, "rejected means nothing stored");
    }
    r = await put({ ultracode: false });
    assert.equal(r.status, 200, `Switching off rejected: ${JSON.stringify(r.body)}`);
    assert.equal(saved(), false);

    const runItem = async (run, chatChoice) => {
      assert.equal((await put({ ...run })).status, 200);
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, ...chatChoice }) });
      assert.equal(chat.ultracode, chatChoice.ultracode === true, "the test setup is wrong");
      fs.rmSync(argvOut, { force: true });
      await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "go" }) });
      const argv = await wait(() => {
        const t = fs.existsSync(argvOut) ? fs.readFileSync(argvOut, "utf8") : "";
        return t.includes("--permission-mode") ? t : null;
      });
      await waitForQuiet(base);
      const target = await json(`${base}/api/chats/${chat.id}`);
      return { ultracode: target.ultracode, effort: target.effort, cli: (argv.match(/--effort (\S+)/) || [])[1] || "" };
    };
    const own = { provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "low" };
    assert.deepEqual(await runItem({ ultracode: true }, own), { ultracode: true, effort: "low", cli: "low" },
      "switch on the chat, the chat's level stays and goes to the CLI");
    assert.deepEqual(await runItem({ ultracode: true, effort: "max" }, own), { ultracode: true, effort: "max", cli: "max" },
      "a run level beside the switch applies as it is");
    // A model without levels carries the switch anyway.
    assert.deepEqual(await runItem({ ultracode: true, effort: "", model: "claude-haiku-4-5-20251001", provider: "claude" }, own), { ultracode: true, effort: "low", cli: "" },
      "Haiku 4.5 carries no levels: no --effort, the switch stands, the stored level stays");
    assert.deepEqual(await runItem({ ultracode: false, effort: "", model: "", provider: "" }, own), { ultracode: false, effort: "low", cli: "low" },
      "ultracode off leaves the chat's choice");
    // An ultracode CHAT, the workflow brings the run level low ⇒ the level applies, the switch stays.
    const ucChat = { provider: "claude", model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: "medium", ultracode: true };
    assert.deepEqual(await runItem({ ultracode: false, effort: "low", model: "", provider: "" }, ucChat), { ultracode: true, effort: "low", cli: "low" },
      "workflow start with run level low leaves the chat's switch");
    // … and without a run level everything stays as it is (ultracode off at the workflow is like an empty field).
    assert.deepEqual(await runItem({ ultracode: false, effort: "", model: "", provider: "" }, ucChat), { ultracode: true, effort: "medium", cli: "medium" },
      "without a run level the chat's switch and level stay");
  }, { delayMs: 200 });
});
