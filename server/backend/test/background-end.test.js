// The end of a Claude run with an open background task.
//
// Up to CLI 2.1.291 the CLI ended a background command (Bash with run_in_background, Monitor) itself 5 s after stdin
// closed. Since 2.1.292 it WAITS for it — a dev server keeps the process until the command's time limit — and then runs
// an extra turn with a model call. A chat would stay "running" after its idle deadline, a subagent would report the
// text of the follow-up turn instead of its report. The connector therefore ends every open task itself in
// `cbaseEndInput` (providers/connectors/claude.js, runChatClaude): one `control_request` `stop_task` per task, and
// only when every request is answered, stdin is closed (deadline CBASE_STOP_TASK_DEADLINE_MS).
//
// The fake CLI is the one from the agent harness (`fakeClaude`, `backgroundBash`): it reads stdin serially like the
// real one, answers `stop_task` at once in the measured order (task_updated "killed", task_notification "stopped",
// background_tasks_changed, control_response "success"), and if stdin closes with a task open it runs the follow-up
// turn "FOLLOW-UP-TURN" like 2.1.292+.
//
// Counter-tests (which sabotage turns which test red):
//   - `cbaseEndInput` closing stdin at once => tests 1, 3, 4, 5 and 6 red: result/report "FOLLOW-UP-TURN",
//     follow-up-turn.jsonl present, no control request.
//   - `cbaseInject` without the `endDecided` mark => test 1 red (the late message is accepted).
//   - the live list does not replace the book => test 2 red (stop_task for the silently vanished task); `task_updated`
//     does not remove => test 2 red (stop_task for the finished task).
//   - `control_response` passed on to onEvent => tests 1 and 3 red.
//   - stdin closed only on a SUCCESS response => test 3 ("error response") red — only after the fake CLI's ripcord
//     (120 s, exit 9); without a deadline test 3 ("silent") likewise.
//   - `cbaseEndInput` without stop_task => additionally "monitor" red (follow-up turn, no control request).
//   - makeForward takes over every later result => "subagent: ... last model request" red (report "NOTICE-TURN");
//     likewise if only the fallback in drive() takes `res.resultText` again.
//   - a later result never taken over (without the exception for messages accepted mid-turn) => "subagent (message
//     mid-turn)" red ("First report").
//   - the fake without a notice turn => "subagent: ... last model request" and "chat: ... two answers" red — the
//     tests really enter the path.
// No clock in the test: it waits for the end of the process or for idle; the deadlines set short here
// (CBASE_BG_TASK_IDLE_MS, CBASE_STOP_TASK_DEADLINE_MS) are deadlines of the PRODUCT and the subject under test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runChatClaude } from "../electron/server/providers/connectors/claude.js";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { LOCATION, endChildrenImmediately, fakeClaude, json, withAgentsServer, setLocation } from "./agent-harness.mjs";
import { RIPCORD } from "./ripcord.mjs";

const readJsonl = (root, name) => {
  const file = path.join(root, name);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((z) => JSON.parse(z)) : null;
};

async function withEnv(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// A run directly at the connector, without a server: the fake in a throwaway folder; `onEvent` calls `cbaseEndInput`
// SYNCHRONOUSLY at the result — like agent-runtime (makeForward) — and then tries one more message (`cbaseInject`).
async function connectorRun(script, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-background-end-"));
  fs.mkdirSync(path.join(root, "pids"));
  fs.mkdirSync(path.join(root, "gates"));
  const bin = path.join(root, "fake-claude");
  fs.writeFileSync(bin, setLocation(script, root));
  fs.chmodSync(bin, 0o755);
  const mcp = path.join(root, "mcp.json");
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  try {
    return await withEnv({ CLAUDE_BIN: bin, ...env }, async () => {
      const events = [];
      const late = [];
      let kind = null;
      const r = await runChatClaude({
        spec: { systemPrompt: "Test", input: "Start the dev server", cwd: root, mcpConfigPath: mcp, allowedTools: [], permissionMode: "default" },
        onSpawn: (c) => { kind = c; },
        onEvent: (evt) => {
          events.push(evt);
          if (evt.type === "result" && !late.length) {
            kind.cbaseEndInput();
            late.push(kind.cbaseInject("TOO LATE"));
          }
        },
      });
      return { r, events, late, control: readJsonl(root, "control.jsonl"), followUp: readJsonl(root, "follow-up-turn.jsonl"), stdinTo: fs.existsSync(path.join(root, "stdin-closed")) };
    });
  } finally {
    endChildrenImmediately(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("connector: an open background task is ended with stop_task at the end — no follow-up turn, the answer stays, no more messages", async () => {
  const run = await connectorRun(fakeClaude({
    main: `
  backgroundBash("sh-dev", "npm run dev");
  say({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Server running" }] } });
  finished();
  say({ type: "result", result: "Server running", session_id: "main-session" });`,
  }));
  assert.equal(run.r.code, 0, `exit ${run.r.code}: ${run.r.stderr}`);
  assert.equal(run.r.resultText, "Server running", "the answer of the turn — not that of the follow-up turn");
  assert.equal(run.followUp, null, `no follow-up turn: ${JSON.stringify(run.followUp)}`);
  assert.deepEqual(run.control?.map((s) => ({ id: s.request_id, req: s.request, open: s.open })),
    [{ id: "cbase-stop-sh-dev", req: { subtype: "stop_task", task_id: "sh-dev" }, open: ["sh-dev"] }],
    "exactly one control request, for the open task");
  assert.ok(run.events.some((e) => e.type === "system" && e.subtype === "task_updated" && e.task_id === "sh-dev" && e.patch?.status === "killed"),
    "the task ended \"killed\"");
  assert.ok(!run.events.some((e) => e.type === "control_response"), "the answer to the control request reaches no consumer");
  assert.deepEqual(run.late, [false], "once the end is decided the process accepts no more messages");
});

// An armed monitor at the turn end holds the CLI after stdin closes just like a background command (measured on 2.1.280
// AND 2.1.296): command "sleep 25; echo ping" => exit after 25.4 s with a follow-up turn. `stop_task` hits it
// (task_updated "killed", no follow-up turn, exit after 0.1 s) — it belongs in the book like any task. The fake knows no
// monitor command; what counts is the stream: tool_use Monitor, live list, task_started.
test("connector: an armed monitor at the end is ended with stop_task like a background command — no follow-up turn", async () => {
  const run = await connectorRun(fakeClaude({
    main: `
  say({ type: "assistant", message: { id: "m-0", content: [{ type: "tool_use", id: "toolu_mon", name: "Monitor", input: { command: "tail -f dev.log", description: "Dev log" } }] } });
  openTasks.set("mon-1", "Dev log");
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "mon-1", task_type: "local_bash" }] });
  say({ type: "system", subtype: "task_started", task_id: "mon-1", tool_use_id: "toolu_mon", description: "Dev log" });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_mon", content: "Monitor started (task mon-1)" }] } });
  say({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Watching the log" }] } });
  finished();
  say({ type: "result", result: "Watching the log", session_id: "main-session" });`,
  }));
  assert.equal(run.r.code, 0, `exit ${run.r.code}: ${run.r.stderr}`);
  assert.equal(run.r.resultText, "Watching the log");
  assert.equal(run.followUp, null, `no follow-up turn: ${JSON.stringify(run.followUp)}`);
  assert.deepEqual(run.control?.map((s) => [s.request.subtype, s.request.task_id]), [["stop_task", "mon-1"]], "the monitor was stopped");
});

test("connector: without an open task no control request goes out — reported done or silently vanished from the live list", async () => {
  // sh-a ends via task_updated (without a later live list), sh-b only vanishes from the live list (without task_updated).
  const run = await connectorRun(fakeClaude({
    main: `
  backgroundBash("sh-a", "npm test");
  backgroundBash("sh-b", "npm run build");
  openTasks.delete("sh-b");
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-a" }] });
  openTasks.delete("sh-a");
  say({ type: "system", subtype: "task_updated", task_id: "sh-a", patch: { status: "completed" } });
  say({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Both done" }] } });
  finished();
  say({ type: "result", result: "Both done", session_id: "main-session" });`,
  }));
  assert.equal(run.r.code, 0, `exit ${run.r.code}: ${run.r.stderr}`);
  assert.equal(run.r.resultText, "Both done");
  assert.equal(run.control, null, `no control request: ${JSON.stringify(run.control)}`);
  assert.equal(run.followUp, null);
});

// A CLI that does NOT answer stop_task with success: "error" answers with an error response, "silent" not at all. At
// stdin end it exits (exit 0) and records it.
const fakeWithoutStop = (kind) => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const LOCATION = ${JSON.stringify(LOCATION)};
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => { fs.writeFileSync(path.join(LOCATION, "stdin-closed"), "1"); process.exit(0); });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "control_request") {
    fs.appendFileSync(path.join(LOCATION, "control.jsonl"), JSON.stringify(msg) + "\\n");
    ${kind === "error" ? "say({ type: \"control_response\", response: { subtype: \"error\", request_id: msg.request_id, error: \"No task found with ID: \" + msg.request.task_id } });" : "// silent"}
    return;
  }
  if (msg.type !== "user") return;
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-x" }] });
  say({ type: "system", subtype: "task_started", task_id: "sh-x", tool_use_id: "toolu_x" });
  say({ type: "result", result: "Server running", session_id: "s" });
});
`;

test("connector: an error response to stop_task closes stdin just the same and reaches no consumer", async () => {
  // The deadline is far above the fake CLI's ripcord: only the answer itself closes stdin, so the run ends with exit 0.
  const run = await connectorRun(fakeWithoutStop("error"), { CBASE_STOP_TASK_DEADLINE_MS: "600000" });
  assert.equal(run.r.code, 0, `exit ${run.r.code} — stdin stayed open until the ripcord`);
  assert.equal(run.control?.length, 1, "the control request arrived");
  assert.ok(run.stdinTo, "stdin was closed");
  assert.ok(!run.events.some((e) => e.type === "control_response"), "even an error response goes to no consumer");
});

test("connector: if the answer is missing, stdin still closes after the deadline", async () => {
  const run = await connectorRun(fakeWithoutStop("silent"), { CBASE_STOP_TASK_DEADLINE_MS: "50" });
  assert.equal(run.r.code, 0, `exit ${run.r.code} — stdin stayed open until the ripcord`);
  assert.equal(run.control?.length, 1, "the control request arrived");
  assert.ok(run.stdinTo, "stdin was closed");
});

// The main agent: "DEV" starts a dev server in the background and ends the turn; "AGENT" starts a subagent in the
// FOREGROUND and relays its report. The subagent likewise starts a dev server and reports.
const fake = fakeClaude({
  main: `
  if (text.includes("DEV")) {
    backgroundBash("sh-dev", "npm run dev");
    say({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Server running" }] } });
  } else if (text.includes("AGENT")) {
    const args = { description: "Dev server", prompt: "Start the dev server [D].", run_in_background: false };
    say({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", id: "toolu_ag", name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: t }] } });
    say({ type: "assistant", message: { id: "m-2", content: [{ type: "text", text: "REPORT " + t }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  sub: `
    backgroundBash("sh-sub", "npm run dev");
    say({ type: "assistant", message: { id: "s-1", content: [{ type: "text", text: "Subagent report" }] } });
    finished();
    say({ type: "result", result: "Subagent report", session_id: "sub-session" });`,
});

test("chat: after the idle deadline the run ends with a stopped dev server — without a follow-up turn", async () => {
  await withEnv({ CBASE_BG_TASK_IDLE_MS: "300" }, () => withAgentsServer(async ({ base, chat, root, waitForIdle }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start DEV" }) });
    await waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Server running"],
      `exactly the one answer — no follow-up turn: ${JSON.stringify(log).slice(0, 600)}`);
    assert.equal(readJsonl(root, "follow-up-turn.jsonl"), null, "the CLI ran no follow-up turn");
    const control = readJsonl(root, "control.jsonl") || [];
    assert.deepEqual(control.map((s) => [s.sub, s.request.subtype, s.request.task_id]), [[false, "stop_task", "sh-dev"]]);
    const meta = log.filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
    assert.equal(meta.length, 1, "one run");
    assert.equal(meta[0].aborted, undefined, "ended regularly, not aborted");
  }, { claude: fake }));
});

test("subagent: its dev server is stopped at the end, the report stays its own — no follow-up turn", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForIdle }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start AGENT" }) });
    await waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const report = log.filter((m) => m.role === "assistant" && m.text.startsWith("REPORT ")).map((m) => m.text);
    assert.equal(report.length, 1, `one report: ${JSON.stringify(log).slice(0, 600)}`);
    assert.match(report[0], /Subagent report/);
    assert.ok(!JSON.stringify(log).includes("FOLLOW-UP-TURN"), "no follow-up turn anywhere in the log");
    assert.equal(readJsonl(root, "follow-up-turn.jsonl"), null, "the subagent's CLI ran no follow-up turn");
    const control = readJsonl(root, "control.jsonl") || [];
    assert.deepEqual(control.map((s) => [s.sub, s.request.subtype, s.request.task_id]), [[true, "stop_task", "sh-sub"]]);
  }, { claude: fake });
});

// ── The notice turn ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// If a background command ends WHILE the last model request runs, it is already "completed" at the result — no longer
// in the book, no stop_task — but its notice to the model is still owed. The CLI runs it right after the result as a turn
// of its own, with stdin open or closed (no point at which closing would still prevent it). A oneshot is free of it
// (ONESHOT_ENV: no background).
//   - Subagent: its report stays that of the FIRST result (providers/agent-runtime.js, makeForward). Exception: if a
//     message was accepted mid-turn, the later result is its answer.
//   - Chat: the notice turn is a continuation of the same run (runs/do-run.js `owedFollowUpTurn`) — a second answer in
//     the log, ONE run, every model request is booked once.
const fakeNotice = fakeClaude({
  main: `
  if (text.startsWith("<task-notification>")) {
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  if (text.includes("TESTS")) {
    backgroundBash("sh-short", "npm test");
    backgroundEnds("sh-short");
    say({ type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Tests running" }] } });
  } else if (text.includes("FRONT")) {
    const args = { description: "Tests", prompt: "Run the tests [M].", run_in_background: false };
    say({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", id: "toolu_ag", name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: t }] } });
    say({ type: "assistant", message: { id: "m-2", content: [{ type: "text", text: "REPORT " + t }] } });
  } else if (text.includes("CONTROL")) {
    const args = { description: "Checker", prompt: "Check [S].", run_in_background: true };
    say({ type: "assistant", message: { id: "m-1", content: [{ type: "tool_use", id: "toolu_ag", name: "mcp__cbase__cbase_agent", input: args }] } });
    const t = textOf(await mcpCall("cbase_agent", args));
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: t }] } });
    const agentId = JSON.parse(t).agentId;
    fs.writeFileSync(path.join(LOCATION, "id-S"), agentId);
    // The subagent is in its last model request (marker) — only then the message goes out.
    await new Promise((r) => { const iv = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "sub-last"))) { clearInterval(iv); r(); } }, 20); });
    const sargs = { agentId, message: "SUPPLIED_LATER" };
    say({ type: "assistant", message: { id: "m-2", content: [{ type: "tool_use", id: "toolu_send", name: "mcp__cbase__cbase_agent_send", input: sargs }] } });
    const s = textOf(await mcpCall("cbase_agent_send", sargs));
    fs.writeFileSync(path.join(LOCATION, "result-send"), s);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_send", content: s }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  sub: `
    if (text.includes("SUPPLIED_LATER")) {
      finished();
      say({ type: "result", result: "Answer to the message", session_id: "sub-session" });
      return;
    }
    if (text.includes("[M]")) {
      backgroundBash("sh-sub", "npm test");
      backgroundEnds("sh-sub");
      say({ type: "assistant", message: { id: "s-1", content: [{ type: "text", text: "Subagent report" }] } });
      finished();
      say({ type: "result", result: "Subagent report", session_id: "sub-session" });
      return;
    }
    if (text.includes("[S]")) {
      // The message arrives in the LAST model request — this turn ends without it, it becomes a turn of its own.
      say({ type: "system", subtype: "init", session_id: "sub-session" });
      fs.writeFileSync(path.join(LOCATION, "sub-last"), String(process.pid));
      await new Promise((r) => { const iv = setInterval(() => { if (inlet.length) { clearInterval(iv); r(); } }, 20); });
      finished();
      say({ type: "result", result: "First report", session_id: "sub-session" });
      return;
    }
    finished();
    say({ type: "result", result: "sub", session_id: "sub-session" });`,
});

test("subagent: if its background command ends in the last model request, the report stays its own — not that of the notice turn", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForIdle }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start FRONT" }) });
    await waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const report = log.filter((m) => m.role === "assistant" && m.text.startsWith("REPORT ")).map((m) => m.text);
    assert.equal(report.length, 1, `one report: ${JSON.stringify(log).slice(0, 600)}`);
    assert.match(report[0], /Subagent report/);
    assert.doesNotMatch(report[0], /NOTICE-TURN/, "the notice turn is not the report");
    // The dangerous path was entered: the subagent's CLI ran the notice turn, and there was nothing to stop.
    assert.deepEqual((readJsonl(root, "notice-turn.jsonl") || []).map((e) => [e.sub, e.tasks]), [[true, ["sh-sub"]]]);
    assert.equal(readJsonl(root, "control.jsonl"), null, "no stop_task: the command was already done");
  }, { claude: fakeNotice });
});

test("subagent (message mid-turn): a message in its last model request becomes a turn of its own — its answer is the report", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForTruthy, waitForLog }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start CONTROL" }) });
    const send = await waitForTruthy(() => { try { return fs.readFileSync(path.join(root, "result-send"), "utf8"); } catch { return null; } }, "answer to cbase_agent_send");
    assert.match(send, /"delivered": true/, send.slice(0, 300));
    const agentId = fs.readFileSync(path.join(root, "id-S"), "utf8");
    const notices = (l) => l.filter((m) => m.role === "user" && isCompletionNotice(m.text) && m.text.includes(`<task-id>${agentId}</task-id>`));
    const log = await waitForLog(chat.id, (l) => notices(l).length === 1);
    assert.match(notices(log)[0].text, /<result>Answer to the message<\/result>/, notices(log)[0].text.slice(0, 600));
  }, { claude: fakeNotice });
});

test("chat: if a background command ends in the last model request, the notice turn follows in the same run — two answers, one run", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForIdle }) => {
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start TESTS" }) });
    await waitForIdle();
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(log.filter((m) => m.role === "assistant").map((m) => m.text), ["Tests running", "NOTICE-TURN"],
      `the answer and then the evaluation of the notice: ${JSON.stringify(log).slice(0, 600)}`);
    assert.deepEqual((readJsonl(root, "notice-turn.jsonl") || []).map((e) => [e.sub, e.tasks]), [[false, ["sh-short"]]]);
    const meta = log.filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
    assert.equal(meta.length, 1, "ONE run — the notice turn is its continuation, not a second one");
    assert.equal(meta[0].aborted, undefined, "ended regularly");
    assert.equal(readJsonl(root, "control.jsonl"), null, "no stop_task: the command was already done");
  }, { claude: fakeNotice });
});
