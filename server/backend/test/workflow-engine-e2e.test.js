// Extensive end-to-end tests of the workflow MACHINERY (no network, no real LLM): loop, condition in both
// directions, question with answer, parallel branches, skipping, cancelling, step limit on a cycle, a
// workflow deleted in mid-run, placeholders. Everything is driven through the real HTTP routes; the fake
// CLI answers depending on the prompt, so that branches are really decided and not just "something happens".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
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
// After a failure: stop open runs instead of waiting for quiet (a run hanging at the limit or never
// finishing would otherwise hold the file until the suite deadline). Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

// Fake CLI that THINKS ALONG:
//  - Turn (stream-json): echoes the prompt (shortened) and appends it to a log file, so that the test
//    can see WHAT each step was sent off with.
//  - Oneshot (runOnce, for verdicts/lists): answers depending on the question:
//      list/items  -> JSON list
//      condition with marker JA-PLEASE -> {"yes": true}, with NO-PLEASE -> {"yes": false}
//      (NO word heuristic: a plain word would hit inside other words of the prompt text itself)
//      marker UNCLEAR-PLEASE (switch OR list) -> {"unclear": "... UNCLEAR-REASON"}, list with EMPTY-PLEASE -> []
const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
const log = (s) => { try { fs.appendFileSync(process.env.CBASE_TEST_PROMPTS, s.replace(/\\s+/g, " ") + "\\n"); } catch {} };
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    // The verdict's arguments BEFORE the prompt: so right above every ONESHOT row it says WHICH model it was
    // asked with (completion gate vs. switch).
    log("VERDICT-ARGV " + argv.join(" "));
    log("ONESHOT " + stdin.slice(0, 400));
    let result = "Title";
    // Compacting at the usage limit (only when the test asks for it): fails with the wording of the real
    // CLI including a reset hint. After that a normal summary comes.
    if (/compacting the chat history/i.test(stdin)) {
      const cap = Number(process.env.CBASE_TEST_COMPACT_LIMIT || 0);
      const state = process.env.CBASE_TEST_COMPACT_STATE || "";
      let n = 0; try { n = Number(fs.readFileSync(state, "utf8")) || 0; } catch {}
      if (cap && n < cap) {
        try { fs.writeFileSync(state, String(n + 1)); } catch {}
        process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 2000).toISOString() + "\\n");
        clearTimeout(guard);
        process.exit(1);
      }
      result = "SUMMARY of the history";
      process.stdout.write(JSON.stringify({ result }));
      clearTimeout(guard);
      process.exit(0);
    }
    // A verdict (switch/list/answer reading) at the usage limit; only when the test asks for it.
    if (Number(process.env.CBASE_TEST_JUDGE_LIMIT || 0) > 0 && /condition|list|JSON array|work step is DONE/i.test(stdin)) {
      const state = process.env.CBASE_TEST_JUDGE_STATE || "";
      let n = 0; try { n = Number(fs.readFileSync(state, "utf8")) || 0; } catch {}
      if (n < Number(process.env.CBASE_TEST_JUDGE_LIMIT)) {
        try { fs.writeFileSync(state, String(n + 1)); } catch {}
        process.stderr.write("Claude usage limit reached · resets at " + new Date(Date.now() + 2000).toISOString() + "\\n");
        clearTimeout(guard);
        process.exit(1);
      }
    }
    if (/work step is DONE/.test(stdin)) {
      let prior = 0;
      // Only the gate prompt contains "work step is DONE"; turn lines write "ERLEDIGT: ...".
      try { prior = (fs.readFileSync(process.env.CBASE_TEST_PROMPTS, "utf8").match(/work step is DONE/g) || []).length; } catch {}
      // "never" = the step is NEVER done (cap cases). Otherwise: at the FIRST verdict prior is exactly 1 (its
      // own line is already in), from the second on the step counts as done.
      const rework = process.env.CBASE_TEST_GATE === "never" || prior <= 1;
      result = rework ? '{"done": false, "note": "the report is missing"}' : '{"done": true, "note": ""}';
    }
    else if (/UNCLEAR-PLEASE/.test(stdin)) result = '{"unclear": "the material does not name it UNCLEAR-REASON"}';
    else if (/EMPTY-PLEASE/.test(stdin) && /JSON array/.test(stdin)) result = '[]';
    else if (/list|JSON array/i.test(stdin)) result = '["Alpha", "Beta", "Gamma"]';
    else if (/condition/i.test(stdin)) result = /JA-PLEASE/.test(stdin) ? '{"yes": true, "note": "Marker YES"}' : '{"yes": false, "note": "Marker NO"}';
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  log("ARGV " + argv.join(" "));
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    log("TURN " + text.slice(0, 900));
    if (/ASK AGENT QUESTION/.test(text)) {
      const response = await fetch(process.env.CBASE_TEST_BASE + "/api/chats/" + process.env.CBASE_TEST_CHAT + "/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions: [{ header: "Decision", question: "Which direction?", options: [
          { label: "A", description: "Direction A" }, { label: "B", description: "Direction B" }
        ] }] }),
      });
      const out = "AGENTQUESTION: " + response.status;
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "engine-e2e" });
      return;
    }
    const out = "ERLEDIGT: " + text.replace(/\\s+/g, " ").slice(0, 120);
    // With a gate the turn answers only once the test creates the file: an ordering, not a duration.
    const gate = process.env.CBASE_TEST_TURN_HOLD || "";
    const respond = () => {
      if (gate && !fs.existsSync(gate)) return setTimeout(respond, 20);
      setTimeout(() => {
        say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
        say({ type: "result", result: out, session_id: "engine-e2e" });
      }, Number(process.env.CBASE_TEST_DELAY || 120));
    };
    respond();
  });
}
`;

// The Anthropic usage endpoint is the preferred reset source of the Claude path; in the test it would
// query the REAL account and make the run depend on the current balance (with a really exhausted window
// it waits for the real reset). Empty HOME + a `security` that finds nothing: then only the reset hint
// from the error message remains, and that is what should carry here.
function isolateCredentials(root) {
  const binDir = path.join(root, "shim");
  fs.mkdirSync(binDir, { recursive: true });
  const security = path.join(binDir, "security");
  fs.writeFileSync(security, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(security, 0o755);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

async function withServer(fn, { delayMs = 120, compactLimit = 0, judgeLimit = 0, isolate = false, gate = "second", turnGate = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-engine-"));
  const bin = path.join(root, "fake-claude");
  const prompts = path.join(root, "prompts.log");
  const prev = {
    bin: process.env.CLAUDE_BIN, poll: process.env.CBASE_TRIGGER_POLL,
    prompts: process.env.CBASE_TEST_PROMPTS, delay: process.env.CBASE_TEST_DELAY,
    base: process.env.CBASE_TEST_BASE, chat: process.env.CBASE_TEST_CHAT,
    compactLimit: process.env.CBASE_TEST_COMPACT_LIMIT, compactState: process.env.CBASE_TEST_COMPACT_STATE,
    judgeLimit: process.env.CBASE_TEST_JUDGE_LIMIT, judgeState: process.env.CBASE_TEST_JUDGE_STATE,
    gate: process.env.CBASE_TEST_GATE, turnHold: process.env.CBASE_TEST_TURN_HOLD,
    restartGrace: process.env.CBASE_RESTART_GRACE_MS,
    home: process.env.HOME, envPath: process.env.PATH, token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  let server, base = "", finished = false;
  const gateFile = path.join(root, "turn-gate");
  try {
    if (isolate) isolateCredentials(root);
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    fs.writeFileSync(prompts, "");
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    process.env.CBASE_TEST_PROMPTS = prompts;
    process.env.CBASE_TEST_DELAY = String(delayMs);
    process.env.CBASE_TEST_COMPACT_LIMIT = String(compactLimit);
    process.env.CBASE_TEST_COMPACT_STATE = path.join(root, "compact-runs.txt");
    process.env.CBASE_TEST_JUDGE_LIMIT = String(judgeLimit);
    process.env.CBASE_TEST_JUDGE_STATE = path.join(root, "judge-runs.txt");
    process.env.CBASE_TEST_GATE = gate;
    if (turnGate) process.env.CBASE_TEST_TURN_HOLD = gateFile; else delete process.env.CBASE_TEST_TURN_HOLD;
    // No restart follow-up. It is never the subject here, and 2.5 s after the start it took a run whose
    // verdict was in flight for interrupted and drove it a second time, the cause of the double gate row
    // in the "gate at limit, auto-continue off" test below.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Engine", path: wsPath }) });
    await fn({
      base, ws,
      // Only WHOLE lines: the fake CLI writes while the test reads.
      promptsOf: () => fs.readFileSync(prompts, "utf8").split("\n").slice(0, -1).filter(Boolean),
      openGate: () => fs.writeFileSync(gateFile, ""),
    });
    finished = true;
  } finally {
    if (turnGate) { try { fs.writeFileSync(gateFile, ""); } catch {} }
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    for (const [k, v] of [["CLAUDE_BIN", prev.bin], ["CBASE_TRIGGER_POLL", prev.poll],
                          ["CBASE_TEST_PROMPTS", prev.prompts], ["CBASE_TEST_DELAY", prev.delay],
                          ["CBASE_TEST_BASE", prev.base], ["CBASE_TEST_CHAT", prev.chat],
                          ["CBASE_TEST_COMPACT_LIMIT", prev.compactLimit], ["CBASE_TEST_COMPACT_STATE", prev.compactState],
                          ["CBASE_TEST_JUDGE_LIMIT", prev.judgeLimit], ["CBASE_TEST_JUDGE_STATE", prev.judgeState],
                          ["CBASE_TEST_GATE", prev.gate], ["CBASE_TEST_TURN_HOLD", prev.turnHold],
                          ["CBASE_RESTART_GRACE_MS", prev.restartGrace],
                          ["HOME", prev.home], ["PATH", prev.envPath], ["CLAUDE_CODE_OAUTH_TOKEN", prev.token]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    // Cleanup must not tip a passed test. Child processes still write into the fake HOME when the test
    // has long checked its claims (node-gyp creating its cache made rmSync fail with ENOTEMPTY). Do NOT
    // get more patient: rimraf retries on EVERY level, and tearing down a node-gyp tree measurably took
    // 450 s with 60x250 ms. Try briefly and, when in doubt, leave a corpse in /tmp that the operating
    // system clears itself, instead of turning a green run red. It is still not hidden.
    try {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
      catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}); test unaffected.`); }
    } catch (err) {
      console.warn(`[test] temp directory was left behind (${err.code}): ${root}`);
    }
  }
}

// `run: { doneAll: false }`: "check all work steps" is ON by default; a test that does not switch it off
// explicitly would see a verdict at every work step. The gate tests set `doneCheck: true` (legacy, becomes
// `doneMode: "on"`) and so keep checking exactly ONE node.
async function makeFlow(base, ws, name, graph, extra = {}) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph, ...extra, run: { doneAll: false, ...(extra.run || {}) } }) });
}
async function newChat(base, ws, title = "Engine chat") {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}
const start = (base, chatId, workflowId, input = "") =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input }) });
const runOf = (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilStatus = (base, runId, ...want) =>
  waitFor(async () => { const d = await runOf(base, runId); return want.includes(d.run.status) ? d : null; });

test("A node command runs before the node: native /clear and free message", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "With-start-command", {
      nodes: [
        { id: "s0", type: "start", title: "Start", command: "/clear", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", command: "/go {{input}}", text: "NOW THE NODE", x: 200, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Command-chat");
    const r = await start(base, chat.id, flow.id, "my job");
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    const turns = promptsOf().filter((line) => line.startsWith("TURN"));
    assert.equal(turns.length, 2, `command and node make two turns, got ${turns.length}`);
    assert.match(turns[0], /\/go my job/);
    assert.match(turns[1], /NOW THE NODE/);
    const commands = done.steps.filter((step) => step.kind === "command");
    assert.equal(commands.length, 2);
    assert.equal(commands[0].detail.native, true);
    assert.equal(commands[1].detail.native, false);

    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(log.some((entry) => entry.role === "clear"), "/clear must set a persistent context boundary");
    assert.ok(log.some((entry) => entry.role === "user" && entry.text === "/go my job"), "free commands must be visible as a normal message");
  });
});

// A coding skill, as Coding -> Skills creates it (pattern chat-skills.test.js; a `.test.js` never imports
// another, hence rebuilt instead of shared). The workspace level requires the area.
const skill = (base, scope, id, name, description) =>
  json(`${base}/api/${scope}/${id}/skills`, { method: "POST", body: JSON.stringify({ name, area: "coding", description, body: "Do something." }) });

// Raw recording of the chat stream: every `data:` line as an event. The reader is aborted in the test's
// `finally`; an open stream would otherwise hold `server.close()` forever, and the first red case would
// turn into a hang without a word.
async function recording(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream" } });
  assert.equal(res.status, 200);
  const events = [];
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* heartbeat frame or the like */ }
        }
      }
    } catch { /* the abort on closing is expected */ }
  })();
  return { events, close: () => ac.abort() };
}

// A "/skillname" as a node command must not go RAW to the CLI ("Unknown command" and the whole job
// swallowed without an error message). The chat route resolves the same line; the driver must do the
// same: the model reads the job to load the skill, the history keeps showing the typed line. The rest
// behind the name (here a placeholder) stays in the turn, rendered, not as "{{input}}".
// Counter-test: without the resolution in the driver, "/receipt my job" stands literally as the first turn.
test("Node command /skill: the turn carries the skill job, the history the typed line", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    await skill(base, "workspaces", ws.id, "receipt", "Formats a receipt.");
    const flow = await makeFlow(base, ws, "With-skill-command", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", command: "/receipt {{input}}", text: "NOW THE NODE", x: 200, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Skill-command-chat");
    // The stream BEFORE the start: the command's `user_message` event would otherwise come before anyone listens.
    const stream = await recording(`${base}/api/chats/${chat.id}/stream`);
    try {
      const r = await start(base, chat.id, flow.id, "my job");
      const done = await untilStatus(base, r.run.id, "done", "failed");
      assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

      const turns = promptsOf().filter((line) => line.startsWith("TURN"));
      assert.equal(turns.length, 2, `command and node make two turns, got ${turns.length}`);
      // What the MODEL reads: the resolved job with the rendered rest, not the raw slash line.
      assert.match(turns[0], /Use the skill `receipt` — load it with cbase_skill/, "the command turn must carry the skill job");
      assert.match(turns[0], /my job/, "the rest behind the skill name must stay in the turn");
      assert.doesNotMatch(turns[0], /\{\{input\}\}/, "the placeholder must be rendered before the skill is resolved");
      assert.doesNotMatch(turns[0], /^TURN \/receipt/, "/receipt must not go raw to the CLI");
      assert.match(turns[1], /NOW THE NODE/);

      // What the HUMAN sees: history, step log and stream show the typed line.
      const commands = done.steps.filter((step) => step.kind === "command");
      assert.equal(commands.length, 1);
      assert.equal(commands[0].detail.native, false);
      assert.equal(commands[0].detail.command, "/receipt my job");
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      assert.ok(log.some((entry) => entry.role === "user" && entry.text === "/receipt my job"), "the history shows the typed line, not the resolved prompt");
      assert.ok(!log.some((entry) => entry.role === "user" && /Use the skill/.test(entry.text)), "the resolved prompt does not belong in the history");
      // Two `user_message` in the stream: the input of the start ("my job", from the route) and the
      // driver's command; the second is the one measured.
      const userRows = () => stream.events.filter((e) => e.type === "harness" && e.subtype === "user_message").map((e) => e.text);
      await waitFor(() => userRows().length >= 2);
      assert.deepEqual(userRows(), ["my job", "/receipt my job"], "the stream event carries the typed line, not the resolved prompt");
    } finally {
      stream.close();
    }
  });
});

// A `/compact` before a node is a model call; if it hits the subscription limit the run must not end at
// once as "failed". It must wait instead and continue afterwards.
test("Command /compact at the usage limit: the run does not fail, it waits and continues", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Compact-at-limit", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        // A real turn first; otherwise there would be too little history and /compact would be a no-op
        // without any model call (and so without a limit).
        { id: "n0", type: "instruction", title: "Preparation", text: "FIRST STEP", x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Danach", command: "/compact", text: "SECOND STEP", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "n0" }, { from: "n0", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Compact-limit-chat");
    const r = await start(base, chat.id, flow.id, "go");

    // 1) The run waits: the status stays "running", the wait row means the compaction.
    const waiting = await waitFor(async () => {
      const s = await json(`${base}/api/chats/${chat.id}/auto-continue`);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "the compaction was not parked");
    assert.equal(waiting.wait.kind, "compact");
    assert.equal(waiting.wait.workflow, true, "the wait row must know the workflow");
    assert.equal((await runOf(base, r.run.id)).run.status, "running", "the run must not fail at the limit");

    // 2) After the reset it is compacted and the workflow runs through to the end (before continuing
    //    there is auto-continue's minimum wait, 2 s in the gate).
    const done = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return ["done", "failed"].includes(d.run.status) ? d : null;
    });
    assert.ok(done, "the run did not continue after the reset");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    const turns = promptsOf().filter((line) => line.startsWith("TURN"));
    assert.ok(turns.some((line) => /SECOND STEP/.test(line)), "the node behind the command did not run");
    // And compacted exactly ONCE, not again on re-entry into the driver.
    const compacts = promptsOf().filter((line) => line.startsWith("ONESHOT") && /compacting the chat history/i.test(line));
    assert.equal(compacts.length, 2, "expected: one failed attempt at the limit + one successful catch-up run");
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const compacted = log.filter((e) => e.role === "meta" && (() => { try { return JSON.parse(e.text).compacted; } catch { return false; } })());
    assert.equal(compacted.length, 1, "the history must carry exactly one compaction marker");
  }, { compactLimit: 1, isolate: true });
});

// A switch at the usage limit: the run must not end here with "condition could not be decided" (the graph
// aborted because of a full quota although nothing was wrong). It waits and then judges the SAME output.
test("Switch at the usage limit: the run waits and decides after the reset", async (t) => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Switch-at-limit", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n0", type: "instruction", title: "Work", text: "DO SOMETHING", x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Condition JA-PLEASE", text: "Is it so? JA-PLEASE", x: 400, y: 0 },
        { id: "yes", type: "instruction", title: "Yes branch", text: "YES-BRANCH RAN", x: 600, y: -60 },
        { id: "no", type: "instruction", title: "No branch", text: "NO-BRANCH RAN", x: 600, y: 80 },
      ],
      edges: [
        { from: "s0", to: "n0" }, { from: "n0", to: "c1" },
        { from: "c1", to: "yes", branch: "true" }, { from: "c1", to: "no", branch: "false" },
      ],
    });
    const chat = await newChat(base, ws, "Switch-limit-chat");
    const r = await start(base, chat.id, flow.id, "go");

    const waiting = await waitFor(async () => {
      const s = await json(`${base}/api/chats/${chat.id}/auto-continue`);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "the switch verdict was not parked");
    assert.equal(waiting.wait.kind, "judge");
    // An OBSERVATION POINT, not a deadline: between reading the wait row and this line the reset (the fake
    // announces it 2 s ahead) may already be through; then the run has caught up its verdict and stands
    // quite legitimately on "done". Demanding "running" here turned red under load without anything
    // being wrong. The substantive claim stays complete: it must NEVER have failed (that was the error:
    // "condition could not be decided"), and "failed" is final. That it decided correctly and did not
    // guess is checked by the branch and the history below.
    const statusAtLimit = (await runOf(base, r.run.id)).run.status;
    t.diagnostic(`run when looking at the parked wait row: ${statusAtLimit}`);
    assert.ok(["running", "done"].includes(statusAtLimit), `the run must not fail at the limit; was: ${statusAtLimit}`);

    const done = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return ["done", "failed"].includes(d.run.status) ? d : null;
    });
    assert.ok(done, "the run did not continue after the reset");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    // The RIGHT branch: the verdict was caught up, not guessed.
    const turns = promptsOf().filter((line) => line.startsWith("TURN"));
    assert.ok(turns.some((line) => /YES-BRANCH RAN/.test(line)), "the yes branch did not run");
    assert.ok(!turns.some((line) => /NO-BRANCH RAN/.test(line)), "the wrong branch was taken");
    // The history records both: the reason for waiting and the later decision.
    const decisions = done.steps.filter((s) => s.kind === "decision");
    assert.equal(decisions.length, 2, "expected: one parked row and one real decision");
    assert.equal(decisions[0].detail.limited, true);
    assert.equal(decisions[1].detail.yes, true);
  }, { judgeLimit: 1, isolate: true });
});

// If the limit STILL stands on continuing, the verdict parks itself a second time, deep inside the resumed
// flow (continuation, driver, verdict). The continuation above must then NOT clean the wait row up as
// done: it already belongs to the next round. That is exactly what this test checks; without the marker
// the waiting state would vanish and the run would hang on "running" forever with nothing ever touching it.
test("Verdict twice at the limit: the wait row survives the continuation and the run then runs through", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Switch-twice-at-limit", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n0", type: "instruction", title: "Work", text: "DO SOMETHING", x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Condition JA-PLEASE", text: "Is it so? JA-PLEASE", x: 400, y: 0 },
        { id: "yes", type: "instruction", title: "Yes branch", text: "YES-BRANCH RAN", x: 600, y: -60 },
        { id: "no", type: "instruction", title: "No branch", text: "NO-BRANCH RAN", x: 600, y: 80 },
      ],
      edges: [
        { from: "s0", to: "n0" }, { from: "n0", to: "c1" },
        { from: "c1", to: "yes", branch: "true" }, { from: "c1", to: "no", branch: "false" },
      ],
    });
    const chat = await newChat(base, ws, "Switch-twice-chat");
    const r = await start(base, chat.id, flow.id, "go");
    const judgeCalls = () => promptsOf().filter((l) => l.startsWith("ONESHOT") && /ONE condition in a workflow/.test(l)).length;
    const waitNow = () => json(`${base}/api/chats/${chat.id}/auto-continue`).then((s) => s.wait);

    // 1) First parking.
    const first = await waitFor(async () => (await waitNow()) || null);
    assert.ok(first, "the verdict was not parked");
    assert.equal(first.attempts, 0, "before the first continuation no attempt is counted yet");

    // 2) The continuation runs into the same limit. Afterwards a SECOND wait row must stand: the same chat,
    //    one counted attempt, and a due time in the near future. That is the proof that it really parked
    //    anew: between "due" and "rescheduled" the continuation pushes the row far back (hours), so that
    //    the sweeper does not interfere.
    const second = await waitFor(async () => {
      const w = await waitNow();
      return w && w.attempts >= 1 && w.dueAt < Date.now() + 60_000 ? w : null;
    });
    assert.ok(second, "after the second refusal the waiting state is missing; the row was cleaned up wrongly");
    assert.equal(second.kind, "judge");
    assert.equal(judgeCalls(), 2, "expected: two refused verdicts");
    assert.equal((await runOf(base, r.run.id)).run.status, "running", "the run must not fail the second time either");

    // 3) At the third attempt the limit no longer stands: the run decides and runs through.
    const done = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return ["done", "failed"].includes(d.run.status) ? d : null;
    });
    assert.ok(done, "the run did not continue after the second reset");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.equal(judgeCalls(), 3, "expected: two refusals and one valid verdict");
    const turns = promptsOf().filter((line) => line.startsWith("TURN"));
    assert.ok(turns.some((line) => /YES-BRANCH RAN/.test(line)), "the yes branch did not run");
    assert.ok(!turns.some((line) => /NO-BRANCH RAN/.test(line)), "the wrong branch was taken");
    assert.equal((await waitNow()) ?? null, null, "no waiting state may remain at the end");
  }, { judgeLimit: 2, isolate: true });
});

test("Loop with a fixed list: body per element, in order, {{element}} in the prompt", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Loop", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "l1", type: "loop", title: "Per file", items: ["one.txt", "two.txt", "three.txt"], maxIterations: 20, x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Process", text: "Process {{element}}", x: 400, y: -60 },
        { id: "n2", type: "instruction", title: "Conclusion", text: "Summarize everything", x: 400, y: 80 },
      ],
      edges: [
        { from: "s0", to: "l1" },
        { from: "l1", to: "n1", branch: "each" },
        { from: "l1", to: "n2", branch: "done" },
      ],
    });
    const chat = await newChat(base, ws);
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    // Four turns: three body passes + conclusion.
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 4, `expected 4 turns, got ${turns.length}`);
    assert.match(turns[0], /Process one\.txt/);
    assert.match(turns[1], /Process two\.txt/);
    assert.match(turns[2], /Process three\.txt/);
    assert.match(turns[3], /Summarize everything/);
    // The loop head stands as a row of its own in the log, with the elements.
    const loopStep = done.steps.find((s) => s.kind === "loop");
    assert.ok(loopStep, `no loop row: ${done.steps.map((s) => s.kind).join(",")}`);
    assert.deepEqual(loopStep.detail.items, ["one.txt", "two.txt", "three.txt"]);
    assert.equal(loopStep.detail.fixed, true, 'a fixed list must not ask a model');
  });
});

test("A condition decides in BOTH directions", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    // Two runs with the same graph but different condition text: the fake CLI judges by a marker IN the
    // condition text, so it really branches and does not guess.
    const mk = (name, text) => makeFlow(base, ws, name, {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "c1", type: "condition", title: "Check", text, x: 200, y: 0 },
        { id: "yes", type: "instruction", title: "Yes path", text: "MERGE", x: 420, y: -60 },
        { id: "no", type: "instruction", title: "No path", text: "REPAIR", x: 420, y: 80 },
      ],
      edges: [{ from: "s0", to: "c1" }, { from: "c1", to: "yes", branch: "true" }, { from: "c1", to: "no", branch: "false" }],
    }, { lock: { scope: "off", template: "" } });

    const green = await mk("Condition-yes", "The tests are green (JA-PLEASE).");
    const red = await mk("Condition-no", "The build is broken (NO-PLEASE).");

    const chatA = await newChat(base, ws, "Yes-chat");
    const rA = await start(base, chatA.id, green.id);
    const doneA = await untilStatus(base, rA.run.id, "done", "failed");
    assert.equal(doneA.run.status, "done");
    const decA = doneA.steps.find((s) => s.kind === "decision");
    assert.equal(decA.detail.yes, true, 'JA-PLEASE must yield yes');
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /MERGE/);

    const chatB = await newChat(base, ws, "No-chat");
    const rB = await start(base, chatB.id, red.id);
    const doneB = await untilStatus(base, rB.run.id, "done", "failed");
    assert.equal(doneB.run.status, "done");
    const decB = doneB.steps.find((s) => s.kind === "decision");
    assert.equal(decB.detail.yes, false, 'NO-PLEASE must yield no');
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /REPAIR/);
    // Both verdicts carry their prompt and the model's answer (debugging material).
    for (const d of [decA, decB]) {
      assert.ok(d.detail.prompt.length > 20, "verdict prompt missing");
      assert.ok(Array.isArray(d.detail.tries) && d.detail.tries.length >= 1, "raw output missing");
    }
  });
});

// "unclear" (unclear) instead of guessing. Switch and loop list judge sandboxed (runs/sandboxing.js) and cannot
// look anything up; the prompts say so, and if what is shown does not suffice, the verdict answers
// {"unclear": "<reason>"}. The run then fails VISIBLY the same way as an unreadable verdict (`failed`, log row
// with `unclear`, end note WITH the reason in the chat), without a second attempt, and no branch and no round
// runs. A real `[]` stays the empty list (third test).
// Counter-test map:
//   - driver.js judgeWorkflowCondition without the unclear check: test 1 turns red (end note without reason, two oneshots)
//   - driver.js produceWorkflowList without the unclear check: test 2 turns red (the same at the list)
//   - workflows.js conditionPrompt or loopListPrompt without "You can look up NOTHING": test 1 or 2 turns red
//   - produceWorkflowList with `if (arr && arr.length)` (empty list treated like unclear): test 3 turns red
const endRow = async (base, chatId) => (await json(`${base}/api/chats/${chatId}/log`))
  .filter((e) => e.role === "workflow").map((e) => JSON.parse(e.text)).find((z) => z.kind === "end");

test("Switch unclear: the run fails visibly with a reason, no branch, no second attempt", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Switch-unclear", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n0", type: "instruction", title: "Work", text: "DO SOMETHING", x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Check", text: "Are there open packages? UNCLEAR-PLEASE", x: 400, y: 0 },
        { id: "yes", type: "instruction", title: "Yes branch", text: "YES-BRANCH RAN", x: 600, y: -60 },
        { id: "no", type: "instruction", title: "No branch", text: "NO-BRANCH RAN", x: 600, y: 80 },
      ],
      edges: [
        { from: "s0", to: "n0" }, { from: "n0", to: "c1" },
        { from: "c1", to: "yes", branch: "true" }, { from: "c1", to: "no", branch: "false" },
      ],
    });
    const chat = await newChat(base, ws, "Switch-unclear-chat");
    const r = await start(base, chat.id, flow.id, "go");
    const end = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(end.run.status, "failed", `an unclear verdict must not choose a branch; run ended as ${end.run.status}: ${end.run.note}`);
    assert.match(end.run.note, /Bedingung konnte nicht entschieden werden/);
    assert.match(end.run.note, /UNCLEAR-REASON/, "the verdict's reason belongs in the end note");
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.ok(!turns.some((l) => /JA-BRANCH|NO-BRANCH/.test(l)), "no branch may run");
    assert.equal(promptsOf().filter((l) => l.startsWith("ONESHOT") && /ONE condition/.test(l)).length, 1, "unclear is not asked a second time");
    const dec = end.steps.filter((s) => s.kind === "decision");
    assert.equal(dec.length, 1, `expected exactly one decision row, got ${dec.length}`);
    assert.equal(dec[0].detail.failed, true);
    assert.match(dec[0].detail.unclear, /UNCLEAR-REASON/);
    assert.equal(dec[0].detail.yes, undefined, "an unclear verdict carries no yes/no");
    assert.match(dec[0].detail.prompt, /You can look up NOTHING/);
    assert.match(dec[0].detail.prompt, /"unclear"/);
    const row = await endRow(base, chat.id);
    assert.equal(row?.status, "failed", "the end row must stand in the chat");
    assert.match(row.note, /UNCLEAR-REASON/);
  });
});

test("Loop list unclear: the run fails visibly with a reason, no silent zero round", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "List-unclear", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "l1", type: "loop", title: "Per package", text: "All packages under packages/ UNCLEAR-PLEASE", maxIterations: 20, x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Process", text: "Process {{element}}", x: 400, y: -60 },
        { id: "n2", type: "instruction", title: "Conclusion", text: "CONCLUSION RAN", x: 400, y: 80 },
      ],
      edges: [{ from: "s0", to: "l1" }, { from: "l1", to: "n1", branch: "each" }, { from: "l1", to: "n2", branch: "done" }],
    });
    const chat = await newChat(base, ws, "List-unclear-chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(end.run.status, "failed", `an unclear list is not an empty one; run ended as ${end.run.status}: ${end.run.note}`);
    assert.match(end.run.note, /Liste der Schleife konnte nicht erzeugt werden/);
    assert.match(end.run.note, /UNCLEAR-REASON/, "the verdict's reason belongs in the end note");
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN")).length, 0, "neither body nor exit may run");
    assert.equal(promptsOf().filter((l) => l.startsWith("ONESHOT") && /workflow loop/.test(l)).length, 1, "unclear is not asked a second time");
    const loopStep = end.steps.find((s) => s.kind === "loop");
    assert.equal(loopStep?.detail.failed, true);
    assert.match(loopStep.detail.unclear, /UNCLEAR-REASON/);
    assert.equal(loopStep.detail.items, undefined, "an unclear list carries no elements");
    assert.match(loopStep.detail.prompt, /You can look up NOTHING/);
    assert.match(loopStep.detail.prompt, /"unclear"/);
    const row = await endRow(base, chat.id);
    assert.equal(row?.status, "failed", "the end row must stand in the chat");
    assert.match(row.note, /UNCLEAR-REASON/);
  });
});

test("Loop list: a real [] stays the empty list, zero rounds, onwards at the exit", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "List-empty", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "l1", type: "loop", title: "Per package", text: "All open packages EMPTY-PLEASE", maxIterations: 20, x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Process", text: "Process {{element}}", x: 400, y: -60 },
        { id: "n2", type: "instruction", title: "Conclusion", text: "CONCLUSION RAN", x: 400, y: 80 },
      ],
      edges: [{ from: "s0", to: "l1" }, { from: "l1", to: "n1", branch: "each" }, { from: "l1", to: "n2", branch: "done" }],
    });
    const chat = await newChat(base, ws, "List-empty-chat");
    const r = await start(base, chat.id, flow.id);
    const end = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(end.run.status, "done", `run ended as ${end.run.status}: ${end.run.note}`);
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 1, `only the exit may run, got ${turns.length} turns`);
    assert.match(turns[0], /CONCLUSION RAN/);
    const loopStep = end.steps.find((s) => s.kind === "loop");
    assert.deepEqual(loopStep?.detail.items, []);
    assert.equal(loopStep.detail.failed, undefined);
    assert.equal(loopStep.detail.unclear, undefined);
  });
});

test("Question: the run waits, the user message IS the answer and is in the follow-up prompt", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "With-question", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "a1", type: "ask", title: "Approval", text: "Shall I merge into {{input}}?", x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Afterwards", text: "The user said: {{answer}}", x: 420, y: 0 },
      ],
      edges: [{ from: "s0", to: "a1" }, { from: "a1", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Question-chat");
    const r = await start(base, chat.id, flow.id, "main");

    const waiting = await untilStatus(base, r.run.id, "waiting", "failed", "done");
    assert.equal(waiting.run.status, "waiting", "the run must wait for the answer");
    assert.equal(waiting.run.question, "Shall I merge into main?", "{{input}} was not replaced");
    // No turn has run up to here (a question costs no model).
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN")).length, 0);

    // Answer like a user: a normal chat message.
    const answered = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Yes, please merge" }) });
    assert.equal(answered.workflow, true, "the message should have been recognized as an answer");
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /The user said: Yes, please merge/);
    // Question AND answer stand in the log.
    const askStep = done.steps.find((s) => s.kind === "ask");
    const ansStep = done.steps.find((s) => s.kind === "answer");
    assert.match(askStep.detail.question, /Shall I merge into main/);
    assert.match(ansStep.detail.answer, /Yes, please merge/);
  });
});

test("cbase_ask from an agent node holds the same node and continues it after the answer", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Skill with question", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Interview", text: "ASK AGENT QUESTION", x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE AGENT QUESTION", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Agent-question-chat");
    process.env.CBASE_TEST_BASE = base;
    process.env.CBASE_TEST_CHAT = chat.id;
    const r = await start(base, chat.id, flow.id);

    const waiting = await untilStatus(base, r.run.id, "waiting", "failed", "done");
    assert.equal(waiting.run.status, "waiting", "the workflow must wait at the same agent node");
    assert.equal(waiting.run.nodeId, "n1");
    assert.equal(waiting.run.question, "Which direction?");
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN")).length, 1,
      "the next workflow node must not start before the answer");

    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const request = JSON.parse(log.find((row) => row.role === "ask").text);
    await json(`${base}/api/chats/${chat.id}/ask-answer`, {
      method: "POST",
      body: JSON.stringify({ requestId: request.requestId, answers: [{ selected: ["A"] }] }),
    });

    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 3, "expected: start turn, continuation of the same node and follow-up step");
    assert.match(turns[1], /Answer to your question/);
    assert.match(turns[2], /AFTER THE AGENT QUESTION/);
    const agentAnswer = done.steps.find((s) => s.kind === "answer" && s.detail.agent === true);
    assert.equal(agentAnswer.detail.requestId, request.requestId);
  });
});

// The case: the question of an agent node was answered not by a click but by an interjection as free text
// ("where did you see the mockup?"). The agent answered it and posed no new card, and the run jumped to the
// next node although the actual decision was still open. An interjection must not consume a node's decision
// point: the card stays open, the step stays put.
test("An interjection as free text does NOT answer the question; the node stays put", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Interview with interjection", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Interview", text: "ASK AGENT QUESTION", x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE AGENT QUESTION", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Interjection-chat");
    process.env.CBASE_TEST_BASE = base;
    process.env.CBASE_TEST_CHAT = chat.id;
    const r = await start(base, chat.id, flow.id);

    const waiting = await untilStatus(base, r.run.id, "waiting", "failed", "done");
    assert.equal(waiting.run.status, "waiting");
    assert.equal(waiting.run.nodeId, "n1");
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const request = JSON.parse(log.find((row) => row.role === "ask").text);

    // Free text instead of a selection. The fake CLI answers it WITHOUT a new question, exactly the case.
    const sent = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST", body: JSON.stringify({ text: "Interjection: where did you get that from?" }),
    });
    assert.equal(sent.workflow, true, "the line must arrive at the waiting run");
    // Wait for the continuation turn (the status alone does not do: waiting, running, waiting could not be
    // told from the old state).
    await waitFor(() => promptsOf().filter((l) => l.startsWith("TURN")).length >= 2);
    await waitForQuiet(base);

    const again = await runOf(base, r.run.id);
    assert.equal(again.run.status, "waiting", "the step must keep hanging at the open card");
    assert.equal(again.run.nodeId, "n1", "the run must not jump to the next node");
    assert.equal(again.run.question, "Which direction?", "the open question stays the old one");
    // The reason for stopping is the agent question again (the history view does not carry it; the chat
    // view does, it also drives the strip in the client).
    const view = await json(`${base}/api/chats/${chat.id}/workflow`);
    assert.equal(view.run.pending, "agent_ask");
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 2, `expected 2 turns, got ${turns.length}`);
    assert.ok(!turns.some((l) => /AFTER THE AGENT QUESTION/.test(l)), "the follow-up node ran too early");
    // History: the interjection stands there as such (otherwise it reads like the answer) ...
    const interjection = again.steps.find((s) => s.kind === "answer" && s.detail.interjection === true);
    assert.ok(interjection, "the interjection must be marked as an interjection in the log");
    assert.match(interjection.detail.answer, /where did you get that/);
    // ... and the resumed stop does not repeat the ask row.
    assert.equal(again.steps.filter((s) => s.kind === "ask").length, 1);

    // Only the selection answers the card; then the workflow continues.
    await json(`${base}/api/chats/${chat.id}/ask-answer`, {
      method: "POST", body: JSON.stringify({ requestId: request.requestId, answers: [{ selected: ["A"] }] }),
    });
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /AFTER THE AGENT QUESTION/);
  });
});

// Checkbox "check completion" on a node: after the turn a model judges. "Not done" gives the SAME step a
// continuation turn instead of advancing; without the checkbox "turn over = node done" still holds. The
// fake CLI answers the gate prompt with {"done": false} the first time and with {"done": true} afterwards.
test("Completion gate: not done lets the same step keep working and advances only afterwards", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "With completion gate", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    // Work, continuation of the same node (gate), only then the follow-up step.
    assert.equal(turns.length, 3, `expected 3 turns, got ${turns.length}: ${turns.map((x) => x.slice(0, 60)).join(" | ")}`);
    assert.match(turns[0], /DO THE WORK/);
    assert.match(turns[1], /Completion gate · round 1\/3/);
    assert.match(turns[1], /Missing: the report is missing/, "the verdict's reason belongs in the continuation job");
    assert.match(turns[2], /AFTER THE WORK/);

    // Log: first the negative, then the positive verdict, both with a prompt.
    const gates = done.steps.filter((s) => s.kind === "gate");
    assert.equal(gates.length, 2, `expected 2 gate rows, got ${gates.length}`);
    assert.equal(gates[0].detail.done, false);
    assert.equal(gates[0].detail.round, 1);
    assert.equal(gates[1].detail.done, true);
    assert.match(gates[0].detail.prompt, /ERLEDIGT/);
    // The counter must not outlive the run.
    assert.ok(!done.run.note || !/Runde|round/i.test(done.run.note));
  });
});

// The model of the completion check is selectable per workflow (run settings). Counter-test against the
// earlier state: there EVERY oneshot judged with the app agent "workflow"; the gate would carry Haiku here
// instead of Opus, and the switch must KEEP Haiku (only the gate is meant, not every verdict of the run).
test("Completion gate judges with the workflow's check model; the switch still with the app agent", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate with own model", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "c1", type: "condition", title: "Switch", text: "JA-PLEASE", x: 440, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 660, y: 0 },
        { id: "e0", type: "end", title: "End", x: 880, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "n2", branch: "true" }, { from: "c1", to: "e0", branch: "false" }, { from: "n2", to: "e0" }],
    }, { run: { doneProvider: "claude", doneModel: "claude-opus-5" } });
    const chat = await newChat(base, ws, "Gate-model-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    // Above each ONESHOT row stands its call.
    const rows = promptsOf();
    const argvOf = (pattern) => rows
      .map((l, i) => (l.startsWith("ONESHOT") && pattern.test(l) ? rows[i - 1] : null))
      .filter((l) => l && l.startsWith("VERDICT-ARGV"));
    const gates = argvOf(/work step is DONE/);
    assert.equal(gates.length, 2, `expected 2 gate verdicts, got ${gates.length}`);
    for (const a of gates) assert.match(a, /--model claude-opus-5/, `the gate does not judge with the check model: ${a}`);
    const switches = argvOf(/ONE condition in a workflow/);
    assert.equal(switches.length, 1, `expected 1 switch verdict, got ${switches.length}`);
    assert.match(switches[0], /--model claude-haiku-4-5-20251001/, `the switch must stay with the app agent: ${switches[0]}`);
    // The history names the verdict's model; otherwise one searches in the dark with a too lax gate.
    const gateRows = done.steps.filter((s) => s.kind === "gate");
    assert.equal(gateRows.length, 2);
    for (const g of gateRows) assert.equal(g.detail.model, "claude::claude-opus-5");
    // And the AGENT did not run with the check model: the field belongs to the gate, not the chat. (Only the
    // `--model` argument counts: the system prompt in the same call names the model catalog.)
    const agentsModels = rows.filter((l) => l.startsWith("ARGV")).map((l) => (l.match(/--model (\S+)/) || [])[1]);
    assert.equal(agentsModels.length, 3, `expected 3 agent turns, got ${agentsModels.length}`);
    for (const m of agentsModels) assert.equal(m, "claude-haiku-4-5-20251001", `the agent ran with ${m} instead of the chat model`);
  });
});

// "Check all" OFF and every node "like workflow": turn over = node done. Set explicitly, not left to the
// helper; the default is ON.
test("Check all OFF, nodes like workflow: one turn, then onwards", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Without completion gate", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    }, { run: { doneAll: false } });
    assert.equal(flow.graph.nodes.find((n) => n.id === "n1").doneMode, "inherit");
    const chat = await newChat(base, ws, "Without-gate-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done");
    assert.equal(promptsOf().filter((l) => l.startsWith("TURN")).length, 2);
    assert.equal(done.steps.filter((s) => s.kind === "gate").length, 0, "check all off and the node like workflow: no verdict");
  });
});

// The cap of the completion gate: after `run.doneRounds` rounds (default 3) the reworking stops. Without
// "continue without asking" the run stops and ASKS; "weiter" (continue) releases the step. (The fake CLI
// never judges "done" here: `gate: "never"`.)
test("Completion gate at the cap: the run stops and asks, continue advances", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate with cap", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-cap-chat");
    const r = await start(base, chat.id, flow.id);

    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting", `at the cap the run must ask, was ${waiting.run.status}`);
    assert.equal(waiting.run.nodeId, "n1", "the question comes at THE step that is not done");
    assert.match(waiting.run.question, /nicht als erledigt/);
    const view = await json(`${base}/api/chats/${chat.id}/workflow`);
    assert.equal(view.run.pending, "done", "the reason for stopping must be recognizable as a completion gate");
    // Three verdicts (round 1-3) and two continuation turns; after that the budget is used up.
    assert.deepEqual(waiting.steps.filter((s) => s.kind === "gate").map((s) => s.detail.round), [1, 2, 3]);
    const heldTurns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(heldTurns.length, 3, `expected work + 2 reworks, got ${heldTurns.length}`);
    assert.ok(!heldTurns.some((l) => /AFTER THE WORK/.test(l)), "the follow-up node ran before the release");

    const answered = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "weiter" }) });
    assert.equal(answered.workflow, true, "the answer must arrive at the waiting run");
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /AFTER THE WORK/);
    const release = done.steps.find((s) => s.kind === "answer" && s.detail.gate === true);
    assert.ok(release, "the release belongs in the log");
    assert.equal(release.detail.go, true);
  }, { gate: "never" });
});

// Free text at the cap is no release but a JOB to the same step, and it resets the step's round budget (the
// human has just steered).
test("Completion gate at the cap: free text keeps the same step working and gives a new budget", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate with job", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-job-chat");
    const r = await start(base, chat.id, flow.id);
    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting");
    const soFar = waiting.steps.filter((s) => s.kind === "gate").length;

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "The report is missing, write it now." }) });
    await waitFor(() => promptsOf().some((l) => l.startsWith("TURN") && /write it now/.test(l)));
    // The budget starts anew: the next verdict is round 1 of 3 again.
    const further = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      const fresh = d.steps.filter((s) => s.kind === "gate").slice(soFar);
      return fresh.length && fresh[0].detail.round === 1 ? d : null;
    });
    assert.ok(further, "after the job the gate must count from round 1 again");
    assert.equal(further.run.nodeId, "n1", "the job must not advance the run");
    assert.ok(!promptsOf().some((l) => l.startsWith("TURN") && /AFTER THE WORK/.test(l)));

    // The run would rework forever here (the fake CLI never finishes); end it cleanly.
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST" });
    await untilStatus(base, r.run.id, "cancelled", "done", "failed");
  }, { gate: "never" });
});

// For runs without a spectator: with the checkbox "continue without asking after the cap" (capAuto, the
// same as for the round cap) the run advances at the gate cap by itself instead of asking.
test("Completion gate with continue without asking: the run advances at the cap by itself", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate without supervision", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, capAuto: true, x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-auto-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed", "waiting");
    assert.equal(done.run.status, "done", `expected without asking, was ${done.run.status}: ${done.run.note}`);
    assert.deepEqual(done.steps.filter((s) => s.kind === "gate").map((s) => s.detail.round), [1, 2, 3]);
    assert.ok(!done.steps.some((s) => s.kind === "answer" && s.detail.gate === true), "nobody may be asked");
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /AFTER THE WORK/);
  }, { gate: "never" });
});

// Skipping at the gate cap: the stop belongs to the skipped step and must NOT travel on in the cursor.
// Otherwise the answer to the next question node lands in the branch of the old stop (an ask node sets no
// `pending` itself, so the old one would still be there).
test("Skipping at the completion gate leaves no stop in the cursor", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate skip", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "a1", type: "ask", title: "Direction", text: "Which direction?", x: 440, y: 0 },
        { id: "n3", type: "instruction", title: "Danach", text: "ANSWER: {{answer}}", x: 660, y: 0 },
        { id: "e0", type: "end", title: "End", x: 880, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "a1" }, { from: "a1", to: "n3" }, { from: "n3", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-skip-chat");
    const r = await start(base, chat.id, flow.id);
    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting");
    assert.equal(waiting.run.nodeId, "n1");

    await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    const atAsk = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return d.run.status === "waiting" && d.run.nodeId === "a1" ? d : null;
    });
    assert.ok(atAsk, "after skipping the question node must wait");
    const view = await json(`${base}/api/chats/${chat.id}/workflow`);
    assert.equal(view.run.pending, "", "the gate's stop must not have travelled along");

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "GREEN" }) });
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    assert.match(promptsOf().filter((l) => l.startsWith("TURN")).at(-1), /ANSWER: GREEN/,
      "the answer belongs as {{answer}} into the follow-up step, not into the gate");
  }, { gate: "never" });
});

// Skipping with an OPEN question card: the card survives every user message in the run (sticky in
// openAskOf), so skipping must close it explicitly. Without that the next step would stop at the same
// old question at once.
test("Skipping closes the open question card; the next step does not stop again", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Skip card", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Interview", text: "ASK AGENT QUESTION", x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE AGENT QUESTION", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Card-skip-chat");
    process.env.CBASE_TEST_BASE = base;
    process.env.CBASE_TEST_CHAT = chat.id;
    const r = await start(base, chat.id, flow.id);
    const waiting = await untilStatus(base, r.run.id, "waiting", "done", "failed");
    assert.equal(waiting.run.status, "waiting");
    assert.equal(waiting.run.nodeId, "n1");

    await json(`${base}/api/chats/${chat.id}/workflow/skip`, { method: "POST" });
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.length, 2, `expected only interview + follow-up step, got ${turns.length}`);
    assert.match(turns[1], /AFTER THE AGENT QUESTION/);
    // The card is closed but NOT answered: an empty selection with a reason.
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const closing = log.filter((e) => e.role === "ask_answer").map((e) => JSON.parse(e.text));
    assert.equal(closing.length, 1, "the card must get exactly one closing row");
    assert.deepEqual(closing[0].answers, [], "no answer may be invented");
    assert.equal(closing[0].dismissed, "skip");
    // And the run does not stop at the follow-up node at the same question again.
    assert.equal(done.steps.filter((s) => s.kind === "ask").length, 1);
  });
});

// The gate at the usage limit: the node's turn has already run; after the reset THIS output must be
// judged. The continuation must not set the driver on the node again (the node would run a second time,
// with everything it does).
test("Completion gate at the usage limit: after the reset it is judged, not worked anew", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Gate-at-limit", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
        { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
        { id: "e0", type: "end", title: "End", x: 660, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const chat = await newChat(base, ws, "Gate-limit-chat");
    const r = await start(base, chat.id, flow.id, "go");

    const waiting = await waitFor(async () => {
      const s = await json(`${base}/api/chats/${chat.id}/auto-continue`);
      return s.wait ? s : null;
    });
    assert.ok(waiting?.wait, "the gate's verdict was not parked");
    assert.equal(waiting.wait.kind, "judge");
    assert.equal((await runOf(base, r.run.id)).run.status, "running", "the run must not fail at the limit");

    const done = await waitFor(async () => {
      const d = await runOf(base, r.run.id);
      return ["done", "failed"].includes(d.run.status) ? d : null;
    });
    assert.ok(done, "the run did not continue after the reset");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.equal(turns.filter((l) => /DO THE WORK/.test(l)).length, 1,
      "the node must not run a second time after the reset");
    assert.equal(turns.length, 2, `expected work + follow-up step, got ${turns.length}`);
    // The history records both: the reason for waiting and the caught-up verdict.
    const gates = done.steps.filter((s) => s.kind === "gate");
    assert.equal(gates[0].detail.limited, true);
    assert.equal(gates.at(-1).detail.done, true);
  }, { judgeLimit: 1, isolate: true });
});

test("Parallel: ONE turn with all branches in the prompt, then it continues behind the join", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Parallel", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "p1", type: "parallel", title: "Simultaneously", text: "Distribute the work", x: 200, y: 0 },
        { id: "b1", type: "instruction", title: "Branch A", text: "CHECK THE TESTS", x: 400, y: -80 },
        { id: "b2", type: "instruction", title: "Branch B", text: "CHECK THE TYPES", x: 400, y: 80 },
        { id: "j1", type: "instruction", title: "Together", text: "SUMMARIZE", x: 620, y: 0 },
      ],
      edges: [
        { from: "s0", to: "p1" },
        { from: "p1", to: "b1" }, { from: "p1", to: "b2" },
        { from: "b1", to: "j1" }, { from: "b2", to: "j1" },
      ],
    });
    const chat = await newChat(base, ws, "Parallel-chat");
    const r = await start(base, chat.id, flow.id);
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done", `run ended as ${done.run.status}: ${done.run.note}`);

    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    // Two turns: the parallel one (both branches in ONE prompt) and the join.
    assert.equal(turns.length, 2, `expected 2 turns, got ${turns.length}: ${turns.map((x) => x.slice(0, 60)).join(" | ")}`);
    assert.match(turns[0], /CHECK THE TESTS/);
    assert.match(turns[0], /CHECK THE TYPES/);
    assert.match(turns[0], /Subagent|parallel/i, "the prompt must explain the branches as a subagent job");
    assert.match(turns[1], /SUMMARIZE/);
  });
});

test("Skipping and cancelling: the user keeps control over the run", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Three-steps", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "First", text: "STEP ONE", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Second", text: "STEP TWO", x: 400, y: 0 },
        { id: "n3", type: "instruction", title: "Third", text: "STEP THREE", x: 600, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
    }, { lock: { scope: "off", template: "" } });

    // Skipping: the skipped step must cost NO turn.
    const chatA = await newChat(base, ws, "Skip-chat");
    const rA = await start(base, chatA.id, flow.id);
    await waitFor(async () => (await runOf(base, rA.run.id)).run.step >= 1);
    await json(`${base}/api/chats/${chatA.id}/workflow/skip`, { method: "POST" });
    const doneA = await untilStatus(base, rA.run.id, "done", "failed");
    assert.equal(doneA.run.status, "done");
    const skipped = doneA.steps.find((s) => s.kind === "skip");
    assert.ok(skipped, `no skip row: ${doneA.steps.map((s) => s.kind).join(",")}`);
    const turnsA = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.ok(turnsA.length <= 3, `with one skip at most 3 turns are allowed, got ${turnsA.length}`);

    // Cancelling: status cancelled, afterwards no step comes any more.
    const chatB = await newChat(base, ws, "Cancel-chat");
    const rB = await start(base, chatB.id, flow.id);
    await waitFor(async () => (await runOf(base, rB.run.id)).run.step >= 1);
    await json(`${base}/api/chats/${chatB.id}/workflow/cancel`, { method: "POST" });
    const cancelled = await untilStatus(base, rB.run.id, "cancelled", "done", "failed");
    assert.equal(cancelled.run.status, "cancelled", `expected cancelled, was ${cancelled.run.status}`);
    const stepsAfter = cancelled.steps.filter((s) => s.kind === "step").length;
    // A step after the cancel would be a turn or a verdict, and quiet counts both (instead of sleeping and
    // hoping it would be there by then).
    await waitForQuiet(base);
    const later = await runOf(base, rB.run.id);
    assert.equal(later.steps.filter((s) => s.kind === "step").length, stepsAfter, "a step still ran after the cancel");
  });
});

// Two brakes, two responsibilities: the round cap STOPS and asks (default 5 rounds per step, see
// workflow-loop-cap.test.js), the step limit is the coarse ripcord behind it. A cycle with a high round
// count is therefore driven here; otherwise the cap applies first and the limit would never be checked.
test("A cycle in the graph does not run forever; behind the round cap the step limit applies", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Cycle", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "There", text: "THERE", maxVisits: 99, x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Back", text: "BACK", maxVisits: 99, x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n1" }],
    });
    const chat = await newChat(base, ws, "Cycle-chat");
    const r = await start(base, chat.id, flow.id);
    // The limit (CBASE_WORKFLOW_MAX_STEPS, default 60) is fixed at module load; the test cannot change it and
    // therefore checks against the real value.
    const ended = await untilStatus(base, r.run.id, "failed", "done", "cancelled");
    assert.equal(ended.run.status, "failed", `the cycle should have failed (was ${ended.run.status}: ${ended.run.note})`);
    assert.match(ended.run.note, /Schrittgrenze|limit of/i, `reason missing: ${ended.run.note}`);
    assert.ok(ended.run.step >= 5 && ended.run.step <= 61, `implausible limit: step ${ended.run.step}`);
  }, { delayMs: 0 });
});

test("If the workflow is deleted in mid-run, the run ends with a clear reason", async () => {
  await withServer(async ({ base, ws, promptsOf, openGate }) => {
    const flow = await makeFlow(base, ws, "Vanishes", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "Erster", text: "ONE", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Zweiter", text: "TWO", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }],
    });
    const chat = await newChat(base, ws, "Delete-chat");
    const r = await start(base, chat.id, flow.id);
    // "Mid-run" is a state: the first turn waits at the gate until the deletion is done (a fake delay would be
    // over under load).
    await waitFor(() => promptsOf().some((l) => l.startsWith("TURN") && /ONE/.test(l)));
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "DELETE" });
    openGate();
    const ended = await untilStatus(base, r.run.id, "failed", "done", "cancelled");
    assert.equal(ended.run.status, "failed");
    assert.match(ended.run.note, /gelöscht|deleted/i, `reason missing: ${ended.run.note}`);
    // The run's history stays readable all the same (that is its purpose).
    assert.ok(ended.steps.length >= 2, "the step log vanished with the workflow");
  }, { turnGate: true });
});

test("Placeholders and head: the first step knows the input, every step name and progress", async () => {
  await withServer(async ({ base, ws, promptsOf }) => {
    const flow = await makeFlow(base, ws, "Placeholder", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "First", text: "Take {{input}} and do something", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Second", text: "And now onwards", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }],
    });
    const chat = await newChat(base, ws, "Placeholder-chat");
    const r = await start(base, chat.id, flow.id, "the file README.md");
    const done = await untilStatus(base, r.run.id, "done", "failed");
    assert.equal(done.run.status, "done");
    const turns = promptsOf().filter((l) => l.startsWith("TURN"));
    assert.match(turns[0], /Take the file README\.md and do something/, "{{input}} was not replaced");
    assert.match(turns[0], /Placeholder/, "the workflow name is missing in the prompt");
    assert.match(turns[0], /step 1/);
    assert.match(turns[1], /step 2/);
    // IMPORTANT: the context between two steps is NOT in the prompt: every step is a turn in the SAME CLI
    // session, so the agent still has its own answer in the history. Checkable at the call arguments: the
    // second turn resumes the session.
    assert.doesNotMatch(turns[1], /ERLEDIGT/, "the prompt carries the old result twice");
    const argv = promptsOf().filter((l) => l.startsWith("ARGV"));
    assert.equal(argv.length, 2, `expected 2 calls, got ${argv.length}`);
    assert.doesNotMatch(argv[0], /--resume/, "the first turn must not resume a session");
    assert.match(argv[1], /--resume engine-e2e/, `the second turn does not resume the session: ${argv[1]}`);
    assert.match(argv[1], /--model claude-haiku-4-5-20251001/);
  });
});

// ── Workflow verdicts at a limit that cannot be parked ──────────────────────────────────────────
// Auto-continue OFF and the completion gate fails at the usage limit: parkJudge then does not take over.
// Falling into "not done" with `note === undefined` made updateWorkflowRun throw a SQLite bind error, and
// the run stayed on "running" without a driver, without a wait row and without a conclusion, lock included.
// Now it ends HONESTLY as "failed" with the reason "usage limit", holds no lock any more and no longer
// stands in the runs overview. The same graph as in the gate-at-limit test above, only without a reset;
// there is nothing that could continue.
const gateAtLimitGraph = {
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    { id: "n1", type: "instruction", title: "Work", text: "DO THE WORK", doneCheck: true, x: 220, y: 0 },
    { id: "n2", type: "instruction", title: "Danach", text: "AFTER THE WORK", x: 440, y: 0 },
    { id: "e0", type: "end", title: "End", x: 660, y: 0 },
  ],
  edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
};

test("Gate at limit, auto-continue OFF: the run ends honestly as failed instead of hanging", async () => {
  await withServer(async ({ base, ws }) => {
    await json(`${base}/api/auto-continue`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    const flow = await makeFlow(base, ws, "Gate-at-limit-A-off", gateAtLimitGraph);
    const chat = await newChat(base, ws, "Gate-limit-A-off");
    const r = await start(base, chat.id, flow.id, "go");
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "failed", `run ended as ${end.run.status}: ${end.run.note}`);
    assert.match(end.run.note, /Nutzungslimit|usage limit/i, `the reason does not name the limit: ${end.run.note}`);
    // The history: ONE gate verdict (at the limit, failed) and exactly ONE end; no second verdict, no bind
    // error in between.
    const gates = end.steps.filter((s) => s.kind === "gate");
    // Two gate verdicts here would be neither a too strict test nor a too tight deadline. Under load the step
    // sequence once read gate, end(failed), gate: two `workflowGateAfterRun` ran SIDE BY SIDE on the same run
    // with the same prompt. CAUSE: the restart follow-up of the test server, 2.5 s after the start.
    // `resumeInterruptedWork` (runs/resume.js) takes every workflow run on "running" without a running turn
    // as interrupted, and a verdict that is in flight does not exclude it. The test therefore runs without
    // the follow-up; in the product the window remains. The number stays 1.
    assert.equal(gates.length, 1, `expected one gate verdict, got ${gates.length}; verdict durations ${gates.map((g) => g.detail?.ms).join("/")} ms, step sequence ${end.steps.map((s) => s.kind).join(" → ")}`);
    assert.equal(gates[0].detail.limited, true);
    assert.equal(gates[0].detail.failed, true);
    assert.equal(end.steps.filter((s) => s.kind === "end").length, 1, "exactly ONE end");
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, null, "no wait row; auto-continue is off, nothing could continue");
    const active = await json(`${base}/api/active-runs`);
    assert.equal(active.items.filter((i) => i.chatId === chat.id).length, 0, "the ended run still stands in the overview");
    // No step ran afterwards: the follow-up node "AFTER THE WORK" must never have been started.
    const turns = (await json(`${base}/api/chats/${chat.id}/log`)).filter((e) => e.role === "user").map((e) => e.text);
    assert.equal(turns.some((t) => /AFTER THE WORK/.test(t)), false, "the run continued past the failed gate");
  }, { judgeLimit: 5, isolate: true });
});

// The counterpart with auto-continue ON: the verdict is parked (judge row), the run stays "running", and
// /api/active-runs lists it EXACTLY ONCE, as a workflow in phase "limit" with its wait row (before, the same
// chat stood twice in the list, once as "running"). DELETE at the strip ends the parked workflow as "failed"
// (every discarding, also the user's explicit one: a running workflow without a driver only holds its lock).
test("A parked workflow stands in /api/active-runs exactly once, as workflow with phase limit; DELETE ends it", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Gate-at-limit-A-on", gateAtLimitGraph);
    const chat = await newChat(base, ws, "Gate-limit-A-on");
    const r = await start(base, chat.id, flow.id, "go");
    const waiting = await waitFor(async () => {
      const s = await json(`${base}/api/chats/${chat.id}/auto-continue`);
      return s.wait ? s : null;
    });
    assert.equal(waiting.wait.kind, "judge");
    assert.equal(waiting.wait.workflow, true, "the row carries the workflow marker; otherwise the strip does not say that a run hangs on it");
    assert.equal((await runOf(base, r.run.id)).run.status, "running");
    const active = await json(`${base}/api/active-runs`);
    const my = active.items.filter((i) => i.chatId === chat.id);
    assert.equal(my.length, 1, `exactly one entry, got ${my.length}: ${JSON.stringify(my.map((i) => [i.kind, i.phase]))}`);
    assert.equal(my[0].kind, "workflow");
    assert.equal(my[0].phase, "limit");
    assert.equal(my[0].limit?.kind, "judge");
    assert.equal(my[0].workflow?.runId, r.run.id);
    // End the waiting: the workflow ends as failed, with exactly ONE end, and the lock falls.
    const del = await json(`${base}/api/chats/${chat.id}/auto-continue`, { method: "DELETE" });
    assert.equal(del.ok, true);
    const end = await untilStatus(base, r.run.id, "done", "failed", "cancelled");
    assert.equal(end.run.status, "failed", `DELETE at the strip ends the hanging workflow (every discarding); was ${end.run.status}`);
    assert.equal(end.steps.filter((s) => s.kind === "end").length, 1, "exactly ONE end");
    assert.equal((await json(`${base}/api/chats/${chat.id}/auto-continue`)).wait, null);
    const afterwards = await json(`${base}/api/active-runs`);
    assert.equal(afterwards.items.filter((i) => i.chatId === chat.id).length, 0, "the ended run still stands in the overview");
  }, { judgeLimit: 5, isolate: true });
});
