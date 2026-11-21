import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { runKindDefault, registerRunKind } from "../electron/server/runs/hooks.js";
import { RIPCORD } from "./ripcord.mjs";
import { streamBarrier, waitForQuiet } from "./quiet.mjs";

// A coding chat does not hold its turn for its subagents. The three native-subagent tests below measure the HELD path
// (display in the turn, report into the same process). The test seam: only THIS chat holds.
const holds = (chat) => registerRunKind(`test-hold-${chat.id}`, (c) => ({ ...runKindDefault(c), hold: true }), { detects: (c) => c.id === chat.id });

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// After a failure only a few glances at quiet — the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Wait for an EVENT instead of the clock — without a deadline (no clock a test goes red on; the emergency brake is the
// suite). Behind every turn is a real process start, which takes longer than any deadline once the machine is busy.
// `label` goes to stderr every 30 s so a hang stays readable.
async function waitFor(predicate, label) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    const sec = Math.floor((Date.now() - start) / 30_000);
    if (sec > reported) { reported = sec; console.error(`[waiting] for ${sec * 30} s: ${label}`); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForLog(base, chatId, predicate) {
  let log = [];
  await waitFor(async () => predicate(log = await json(`${base}/api/chats/${chatId}/log`)), `log ${chatId}`);
  return log;
}

// The server keeps the run open after the result (wait phase) — or has ended it (meta in the log; then the check afterwards
// goes red instead of a gate waiting forever for a delivery nobody reads any more).
async function waitPhaseOrEnd(base, chatId) {
  await waitFor(async () => {
    if (((await json(`${base}/api/runs/active`)).open?.waitPhase || 0) > 0) return true;
    return (await json(`${base}/api/chats/${chatId}/log`)).some((m) => m.role === "meta");
  }, "wait phase or run end");
}

// Gates instead of durations: a fake waits at the file `<gates>/<name>` that the test writes, and announces itself
// beforehand with `<name>.waiting`. So the test determines the order against the server state, not a clock in the fake —
// delays (40 ms … 2 s) missed their window under load. `ALL` opens every gate: the cleanup after a failure so no fake hangs.
const FAKE_GATE = `
const fsGate = require("node:fs");
const GATES = "__BG_GATES__";
const gate = (name) => new Promise((r) => {
  try { fsGate.writeFileSync(GATES + "/" + name + ".waiting", "1"); } catch {}
  const t = setInterval(() => {
    if (!fsGate.existsSync(GATES + "/" + name) && !fsGate.existsSync(GATES + "/ALL")) return;
    clearInterval(t); r();
  }, 20);
});
`;
function gatesIn(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    open: (name) => fs.writeFileSync(path.join(dir, name), "1"),
    reached: (name) => waitFor(() => fs.existsSync(path.join(dir, `${name}.waiting`)), `gate "${name}" reached`),
    all: () => { try { fs.writeFileSync(path.join(dir, "ALL"), "1"); } catch { /* folder already gone */ } },
  };
}

// Replays the measured event sequence of the real Claude CLI for a BACKGROUND task: tool_use(…, run_in_background) →
// background_tasks_changed + task_started → result (turn over, the task keeps running) → … → background_tasks_changed +
// task_updated(completed) → and then ENTIRELY BY ITSELF, without new input, a follow-up turn with the evaluation.
// The CLI's own agent (Agent/Task) is disabled in every run, so the task is a background Bash, the only CLI kind of this
// path that remains. The hold mechanism behind it is the same. This follow-up turn used to be lost while only monitors kept
// the run open: at the first result stdin was closed, the agent was still running, was cut off on shutdown, and the user
// never got an answer.
// Gates: with `notifyBeforeResult` the follow-up turn waits at "follow-up-turn" (the notice came BEFORE the result, the
// follow-up turn AFTER it), otherwise the notice itself at "agent" (it comes in the wait phase).
function fakeClaude({ notifyBeforeResult = false }) {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
const TASK = "task-1";
const USE = "toolu_agent_1";
let done = false;
// stdin closed = the CLI shuts down. A background agent still running is cut off in the process — exactly what the
// server must prevent.
process.stdin.on("end", () => { process.exit(done ? 0 : 3); });
const report = () => {
  done = true;
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  say({ type: "system", subtype: "task_updated", task_id: TASK, patch: { status: "completed" } });
  say({ type: "system", subtype: "task_notification", task_id: TASK, tool_use_id: USE, status: "completed" });
};
// The CLI begins the follow-up turn by itself — without input on stdin.
const followUpTurn = () => {
  say({ type: "assistant", message: { content: [{ type: "text", text: "Agent done, MR is open" }] } });
  say({ type: "result", result: "Agent done, MR is open", session_id: "bg-session" });
};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: USE,
    input: { command: "npm run review", description: "Second review round", run_in_background: true } }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: TASK }] });
  say({ type: "system", subtype: "task_started", task_id: TASK, tool_use_id: USE, description: "Second review round" });
  ${notifyBeforeResult ? "report();" : ""}
  say({ type: "assistant", message: { content: [{ type: "text", text: "Review round running, I will report back" }] } });
  say({ type: "result", result: "Review round running, I will report back", session_id: "bg-session" });
  await gate(${notifyBeforeResult ? "\"follow-up-turn\"" : "\"agent\""});
  ${notifyBeforeResult ? "" : "report();"}
  followUpTurn();
});
`;
}

// Background BASH, measured sequence: the finished command reports itself and the CLI evaluates it BY ITSELF in a new
// turn. This was lost when background Bash was still exempt from keeping the run open — the run ended 8 s before the
// notice. The finished command reports at the gate "bash" — in the wait phase that the test waits for.
function fakeClaudeBackgroundBash() {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
let done = false;
// stdin closed although the watcher is still running = cut off. The exit code tells the test.
process.stdin.on("end", () => process.exit(done ? 0 : 3));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_bash_1",
    input: { command: "until redis-cli exists done; do sleep 8; done", description: "Wait for the E2E run", run_in_background: true } }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-1" }] });
  say({ type: "system", subtype: "task_started", task_id: "sh-1", tool_use_id: "toolu_bash_1" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "E2E running, I will report back" }] } });
  say({ type: "result", result: "E2E running, I will report back", session_id: "sh-session" });
  await gate("bash");
  done = true;
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  say({ type: "system", subtype: "task_updated", task_id: "sh-1", patch: { status: "completed" } });
  say({ type: "system", subtype: "task_notification", task_id: "sh-1", tool_use_id: "toolu_bash_1" });
  say({ type: "system", subtype: "init", session_id: "sh-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "E2E green — committed, pushed, MR open" }] } });
  say({ type: "result", result: "E2E green — committed, pushed, MR open", session_id: "sh-session" });
});
`;
}

// A background command WITHOUT an end (dev server) must not bind the chat forever: no task_updated, no completion
// notice — after the idle deadline the run must still end. So the test does not take ten minutes, the deadline is shortened
// via an environment variable.
const fakeClaudeEndlessBash = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  // At the end the connector stops the open task itself (background-end.test.js) — answered like the real CLI, otherwise it
  // would wait out its deadline.
  if (msg.type === "control_request" && msg.request && msg.request.subtype === "stop_task") {
    say({ type: "system", subtype: "task_updated", task_id: msg.request.task_id, patch: { status: "killed" } });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_bash_2",
    input: { command: "npm run dev", run_in_background: true } }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-2" }] });
  say({ type: "system", subtype: "task_started", task_id: "sh-2", tool_use_id: "toolu_bash_2" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Server running in the background" }] } });
  say({ type: "result", result: "Server running in the background", session_id: "sh-session" });
});
`;

// ScheduleWakeup: at the wake time the CLI begins a turn by itself with the scheduled prompt — as long as stdin is open.
// The fake wakes at the gate "wakeup", long before the minute, so the server must hold out until then (its deadline rounds
// up to the full minute and adds a buffer).
const fakeClaudeWakeup = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
let done = false;
process.stdin.on("end", () => process.exit(done ? 0 : 3));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "ScheduleWakeup", id: "toolu_wake_1",
    input: { delaySeconds: 60, prompt: "Continue with the MR", reason: "Fallback" } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wake_1",
    content: "Next wakeup scheduled. Nothing more to do this turn." }] } });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Scheduled" }] } });
  say({ type: "result", result: "Scheduled", session_id: "wake-session" });
  await gate("wakeup");
  done = true;
  say({ type: "system", subtype: "init", session_id: "wake-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Wake-up call here — MR is open" }] } });
  say({ type: "result", result: "Wake-up call here — MR is open", session_id: "wake-session" });
});
`;

// After the start the server schedules resumeInterruptedWork() once (default 2.5 s) — store and data directory are
// module-global, so several servers in one process share both. The restart grace is set to a day (CBASE_RESTART_GRACE_MS),
// and server.close clears the timer. There is nothing to restart here.
const RESTART_GRACE_OFF = String(24 * 3600_000);

async function withServer(script, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-bgagent-"));
  const bin = path.join(root, "fake-claude");
  const gate = gatesIn(path.join(root, "gates"));
  const previousBin = process.env.CLAUDE_BIN;
  const previousRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  let server;
  let base = "";
  let ok = false;
  try {
    fs.writeFileSync(bin, script.split("__BG_GATES__").join(path.join(root, "gates")));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_RESTART_GRACE_MS = RESTART_GRACE_OFF;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "BG-Test", path: wsPath }),
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
      }),
    });
    // Setting a title = named manually → no auto-title run after the test. It would otherwise keep running with the same
    // fake binary while the data directory is already deleted.
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "BG-Test" }) });
    await fn({ base, chat, gate });
    ok = true;
  } finally {
    if (!ok) gate.all();
    if (base) await (ok ? waitForQuiet(base) : shortWaitForQuiet(base));
    if (previousRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS;
    else process.env.CBASE_RESTART_GRACE_MS = previousRestartGrace;
    // `closeAllConnections` BEFORE close: a test that fails on an assertion leaves its SSE reader open — without this line
    // server.close() would wait for it forever, and the failure would look like a hang.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    // A test must not fail because its temp directory does not go away (a child process still writing causes ENOTEMPTY);
    // it is not kept quiet either — otherwise garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

test("if the background task finishes during the turn, the delivered answer still arrives", async () => {
  await withServer(fakeClaude({ notifyBeforeResult: true }), async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Push and open an MR" }),
    });
    // The notice came BEFORE the result: the server must keep open for the follow-up turn — only then it comes.
    await waitPhaseOrEnd(base, chat.id);
    gate.open("follow-up-turn");
    const log = await waitForLog(base, chat.id, (l) =>
      l.some((m) => m.role === "assistant" && m.text === "Agent done, MR is open"));
    assert.ok(
      log.some((m) => m.role === "assistant" && m.text === "Agent done, MR is open"),
      "the answer after the agent is missing",
    );
  });
});

test("the user can keep writing in the wait phase of a background task", async () => {
  await withServer(fakeClaude({}), async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Push and open an MR" }),
    });
    // Wait for the wait phase (first result through, the task stands at the gate "agent").
    await waitPhaseOrEnd(base, chat.id);
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(log.some((m) => m.role === "assistant" && m.text === "Review round running, I will report back"), "wait phase was never reached");
    const second = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Interim question" }),
    });
    // Injected directly instead of queued — the main agent is responsive.
    assert.equal(second.injected, true);
    assert.equal(second.queued, false);
    gate.open("agent");
  });
});

test("a background Bash keeps the run open until the CLI delivers its evaluation", async () => {
  await withServer(fakeClaudeBackgroundBash(), async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Wait for the E2E run, then commit, push and MR" }),
    });
    await waitPhaseOrEnd(base, chat.id);
    gate.open("bash");
    const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["E2E running, I will report back", "E2E green — committed, pushed, MR open"],
    );
    // One run, ended regularly — not with a cut-off stdin (exit 3 in the fake).
    assert.equal(log.filter((m) => m.role === "meta").length, 1);
    assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
  });
});

test("an endless background command ends the run after the idle deadline", async () => {
  const previous = process.env.CBASE_BG_TASK_IDLE_MS;
  process.env.CBASE_BG_TASK_IDLE_MS = "700"; // otherwise the test would run ten minutes
  try {
    await withServer(fakeClaudeEndlessBash, async ({ base, chat }) => {
      await json(`${base}/api/chats/${chat.id}/message`, {
        method: "POST",
        body: JSON.stringify({ text: "Start the dev server" }),
      });
      const started = Date.now();
      // The PRODUCT's idle deadline is the subject here (700 ms). If the run stays open because of the dev server, quiet
      // hangs — the emergency brake is the suite (no deadline in the test).
      await waitForQuiet(base);
      const waited = Date.now() - started;
      assert.ok(waited >= 600, `the deadline was not waited for at all (${waited} ms)`);
    });
  } finally {
    if (previous === undefined) delete process.env.CBASE_BG_TASK_IDLE_MS;
    else process.env.CBASE_BG_TASK_IDLE_MS = previous;
  }
});

// THE REAL CASE: the Claude CLI OFFERS ScheduleWakeup in every chat but only wakes itself in `/loop` operation. This fake
// therefore does exactly what the real CLI does in a normal chat — it schedules the wake-up call and then stays silent. The
// continuation must thus be delivered by the SERVER, as a user injection into the same process.
const fakeClaudeWakeupSilent = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
let turns = 0;
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  turns += 1;
  if (turns === 1) {
    say({ type: "assistant", message: { content: [{ type: "tool_use", name: "ScheduleWakeup", id: "toolu_wake_1",
      input: { delaySeconds: 1, prompt: "Check the build", reason: "Build needs a minute" } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wake_1",
      content: "Wakeup scheduled." }] } });
    say({ type: "assistant", message: { content: [{ type: "text", text: "Alarm is set" }] } });
    say({ type: "result", result: "Alarm is set", session_id: "silent-session" });
    return; // …and afterwards: nothing. Exactly here the matter used to peter out.
  }
  // The second turn comes ONLY if the server delivered the scheduled continuation.
  const text = JSON.stringify(msg.message && msg.message.content).slice(0, 200);
  say({ type: "system", subtype: "init", session_id: "silent-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Continuation received: " + text }] } });
  say({ type: "result", result: "finished", session_id: "silent-session" });
});
`;

test("if the CLI does not wake itself, the server delivers the scheduled continuation", async () => {
  // Without these knobs the test would wait until the next minute boundary (that is how the CLI rounds).
  const previousRound = process.env.CBASE_WAKEUP_ROUND_MS;
  const previousDelay = process.env.CBASE_WAKEUP_SELF_DELAY_MS;
  process.env.CBASE_WAKEUP_ROUND_MS = "1000";
  process.env.CBASE_WAKEUP_SELF_DELAY_MS = "200";
  try {
    await withServer(fakeClaudeWakeupSilent, async ({ base, chat }) => {
      await json(`${base}/api/chats/${chat.id}/message`, {
        method: "POST",
        body: JSON.stringify({ text: "Wait for the build" }),
      });
      const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
      const answers = log.filter((m) => m.role === "assistant").map((m) => m.text);
      assert.equal(answers.length, 2, `the continuation did not arrive: ${JSON.stringify(answers)}`);
      assert.equal(answers[0], "Alarm is set");
      // The scheduled prompt MUST carry the second turn — otherwise the agent would not know what to do.
      assert.match(answers[1], /Scheduled continuation/);
      assert.match(answers[1], /Check the build/);
      assert.equal(log.filter((m) => m.role === "meta").length, 1);
    });
  } finally {
    if (previousRound === undefined) delete process.env.CBASE_WAKEUP_ROUND_MS;
    else process.env.CBASE_WAKEUP_ROUND_MS = previousRound;
    if (previousDelay === undefined) delete process.env.CBASE_WAKEUP_SELF_DELAY_MS;
    else process.env.CBASE_WAKEUP_SELF_DELAY_MS = previousDelay;
  }
});

// CronCreate — the second way an agent schedules itself ("can you wake yourself in 1 min?"). Unlike ScheduleWakeup the CLI
// fires the job ITSELF as long as stdin is open (command_lifecycle → system/init → answer). cbase used to prevent exactly
// that because the server did not know the tool: `holdMs()` saw no reason, stdin closed — and a cron job lives only in the CLI
// session, so it dies with the process. The fake pins its expression to a minute 75 s in the future (the real CLI computes
// the same way: five fields, local time) but fires as soon as the test opens the gate "cron" — so the server must hold out
// because of the expression alone.
const fakeClaudeCron = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
let done = false;
// stdin closed before the job fired = the old failure pattern. The exit code tells the test.
process.stdin.on("end", () => process.exit(done ? 0 : 3));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const d = new Date(Date.now() + 75000);
  const expr = d.getMinutes() + " " + d.getHours() + " " + d.getDate() + " " + (d.getMonth() + 1) + " *";
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "CronCreate", id: "toolu_cron_1",
    input: { cron: expr, prompt: "Report to the user with the time", recurring: false } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_cron_1",
    content: "Scheduled one-shot task f8667939 (" + expr + "). Session-only (not written to disk, dies when Claude exits)." }] } });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Wake-up call is set" }] } });
  say({ type: "result", result: "Wake-up call is set", session_id: "cron-session" });
  // The job fires — by the CLI itself, without input on stdin.
  await gate("cron");
  done = true;
  say({ type: "system", subtype: "init", session_id: "cron-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Wake-up call here — it is time now" }] } });
  say({ type: "result", result: "Wake-up call here", session_id: "cron-session" });
});
`;

test("a cron job (CronCreate) keeps the run open until it fires", async () => {
  await withServer(fakeClaudeCron, async ({ base, chat, gate }) => {
    const prior = Date.now();
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Can you wake yourself in 1 min?" }),
    });
    // … and the user sees it: the alarm chip above the input field is fed by the same report as this list. The job only
    // fires at the gate, so the wake time stays until the test has seen it.
    const seen = await waitFor(async () => (await json(`${base}/api/active-runs`)).items?.find((r) => r.chatId === chat.id)?.background?.wakeupAt || 0,
      "the cron job appears as a wake time in the list");
    const now = Date.now();
    // The bounds hang on the sending, not on the duration of the wait: the expression's minute lies 15–75 s afterwards.
    assert.ok(seen > prior, `the cron job was not reported as a wake time (${seen})`);
    assert.ok(seen <= now + 80_000, `wake time implausibly far away: ${new Date(seen).toISOString()}`);
    await waitPhaseOrEnd(base, chat.id);
    gate.open("cron");

    const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["Wake-up call is set", "Wake-up call here — it is time now"],
    );
    assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
  });
});

// After firing it is over: a ONE-SHOT job must not keep the run open any further (otherwise the chat would hang on "running"
// until the deadline and the composer would stay locked). The fake proves it via its exit code — it exits only when the
// server closes stdin.
test("after firing, a one-shot cron job keeps nothing open any more", async () => {
  await withServer(fakeClaudeCron, async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Wake me soon" }),
    });
    await waitPhaseOrEnd(base, chat.id);
    gate.open("cron");
    // Only the end of the run writes the meta row — if the fired job kept it open, it would not come.
    await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    await waitForQuiet(base);
    const runs = await json(`${base}/api/active-runs`);
    assert.equal(runs.items?.some((r) => r.chatId === chat.id), false, "the run is still open");
  });
});

test("a scheduled wake-up call (ScheduleWakeup) keeps the run open", async () => {
  await withServer(fakeClaudeWakeup, async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Make the MR as soon as the run is through" }),
    });
    await waitPhaseOrEnd(base, chat.id);
    gate.open("wakeup");
    const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["Scheduled", "Wake-up call here — MR is open"],
    );
    assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
  });
});

// ── The NATIVE alarm (cbase_wakeup) ───────────────────────────────────────
// It belongs to the CHAT, not the run (runs/wakeup.js) — its tests (delivery, interim question, edge cases, 409 without a
// turn) live in server/backend/test/wakeup-over-the-turn.test.js: the turn ends after setting it instead of holding the wait phase.

// The flood brake from the RUN's point of view: a runaway watch must neither flood the chat with turns nor leave it hanging
// when the core chokes it off. The fake answers every injected notice — the number of answers is thus the number of model
// calls such a watch costs.
const fakeClaudeMonitorFlood = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
let turns = 0;
process.stdin.on("end", () => process.exit(0));
const cfg = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8"));
const chatId = cfg.mcpServers.cbase.env.CBASE_CHAT_ID;
const base = process.env.CBASE_TEST_BASE;
const textOf = (msg) => { const c = msg.message && msg.message.content; return typeof c === "string" ? c : (c || []).map((b) => b.text || "").join(""); };
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  turns += 1;
  // Every notice wakes a NEW turn (often a new process) — it only starts on the human's message.
  if (textOf(msg).includes("Watch this")) {
    const r = await fetch(base + "/api/chats/" + chatId + "/monitor", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "for i in $(seq 1 60); do echo LOUD$i; sleep 0.05; done", description: "Rapid fire" }),
    });
    say({ type: "assistant", message: { content: [{ type: "text", text: "Watch on (" + r.status + ")" }] } });
    say({ type: "result", result: "Watch on", session_id: "flood" });
    return;
  }
  say({ type: "system", subtype: "init", session_id: "flood" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "TURN" + turns }] } });
  say({ type: "result", result: "TURN" + turns, session_id: "flood" });
});
`;

test("a runaway monitor costs few turns and lets the run end cleanly", async () => {
  const before = { max: process.env.CBASE_MONITOR_MAX_EVENTS, rate: process.env.CBASE_MONITOR_RATE_MAX };
  process.env.CBASE_MONITOR_MAX_EVENTS = "4";
  process.env.CBASE_MONITOR_RATE_MAX = "2";
  process.env.CBASE_MONITOR_THROTTLE_MS = "300";
  try {
    await withServer(fakeClaudeMonitorFlood, async ({ base, chat }) => {
      process.env.CBASE_TEST_BASE = base;
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Watch this" }) });
      await waitForQuiet(base); // without the brake the watch would run to the end of its 60 lines
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      const answers = log.filter((m) => m.role === "assistant").map((m) => m.text);
      assert.ok(answers.length <= 8, `too many model calls: ${JSON.stringify(answers)}`);
      // The core must have choked off the watch AND reported it — as a wake-up call to the chat, no longer as a line in the
      // held turn.
      const notices = log.filter((m) => m.role === "user" && m.text.startsWith("<task-notification>"));
      assert.equal(notices.filter((m) => m.text.includes("<status>flooded</status>")).length, 1, JSON.stringify(notices.map((m) => m.text.slice(0, 200))));
      const active = await json(`${base}/api/runs/active`);
      assert.deepEqual(active.monitors, [], "the braked monitor is gone");
    });
  } finally {
    delete process.env.CBASE_TEST_BASE;
    delete process.env.CBASE_MONITOR_THROTTLE_MS;
    if (before.max === undefined) delete process.env.CBASE_MONITOR_MAX_EVENTS; else process.env.CBASE_MONITOR_MAX_EVENTS = before.max;
    if (before.rate === undefined) delete process.env.CBASE_MONITOR_RATE_MAX; else process.env.CBASE_MONITOR_RATE_MAX = before.rate;
  }
});

// If the CLI evaluates the agent's notice still WITHIN the running turn, NO further turn follows — the "owed" evaluation
// never comes. Exactly this case kept a chat on "running" forever: the 30-second deadline was stored relatively and extended
// by another 30 s at every recalculation.
const fakeClaudeAgentInsideTurn = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_in_1",
    input: { command: "cat note.txt", description: "Read note", run_in_background: true } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_in_1",
    content: "Command running in background with ID: task-in" }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-in" }] });
  say({ type: "system", subtype: "task_started", task_id: "task-in", tool_use_id: "toolu_in_1", description: "Read note" });
  // The agent finishes WHILE the main agent is still working — the CLI evaluates it in the same turn and stays silent
  // afterwards. The order is carried by the output itself.
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  say({ type: "system", subtype: "task_updated", task_id: "task-in", patch: { status: "completed" } });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Agent says BLUEWHALE, done" }] } });
  say({ type: "result", result: "Agent says BLUEWHALE, done", session_id: "in-session" });
});
`;

test("if the background task is evaluated in the turn and the CLI stays silent afterwards, the run ends after the deadline", async () => {
  const previous = process.env.CBASE_AGENT_DRAIN_MS;
  process.env.CBASE_AGENT_DRAIN_MS = "700"; // otherwise the test waits the full 30 s
  try {
    await withServer(fakeClaudeAgentInsideTurn, async ({ base, chat }) => {
      await json(`${base}/api/chats/${chat.id}/message`, {
        method: "POST",
        body: JSON.stringify({ text: "Read the note" }),
      });
      // Before the fix: runs on forever (the deadline kept extending). The PRODUCT's deadline (700 ms) is the subject here;
      // the quiet wait has none of its own — the emergency brake is the suite.
      await waitForQuiet(base);
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      assert.equal(log.filter((m) => m.role === "meta").length, 1);
      assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
    });
  } finally {
    if (previous === undefined) delete process.env.CBASE_AGENT_DRAIN_MS;
    else process.env.CBASE_AGENT_DRAIN_MS = previous;
  }
});

// Rebuild of a real chat: the pipeline watch (monitor) died IN THE MIDDLE of the turn — background_tasks_changed without
// the task came 1 s before the result. The CLI delivers the end afterwards in a turn of its OWN (measured: task_notification
// + turn itself for a silently dying command, exit 1 without output) — but only as long as stdin is open. The old server saw
// no monitors at the result, closed stdin at once and cut off the delivery: "monitor ended" was in the log, a notice to the
// model never came, the user waited in vain for the pipeline evaluation.
// endInWaiting=true moves the dying into the WAIT PHASE (result first, monitor still alive): there no timer was set with
// armDrain(Infinity) — after the disappearance nothing recalculated and the chat hung on "running" forever.
// Gates: the delivery waits at "deliver" (in the wait phase), with endInWaiting the dying at "die".
function fakeClaudeMonitorDies({ endInWaiting = false }) {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
const TASK = "mon-1";
const USE = "toolu_mon_1";
let delivered = false;
// stdin closed before the delivery = the follow-up turn was cut off (the old bug).
process.stdin.on("end", () => { process.exit(delivered ? 0 : 3); });
const die = () => say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
const deliver = () => {
  say({ type: "system", subtype: "task_updated", task_id: TASK, patch: { status: "failed" } });
  say({ type: "system", subtype: "task_notification", task_id: TASK, tool_use_id: USE, status: "failed" });
  say({ type: "system", subtype: "init", session_id: "mon-session" });
  say({ type: "assistant", message: { content: [{ type: "text", text: "The watch has died — I will check the pipelines directly" }] } });
  say({ type: "result", result: "The watch has died — I will check the pipelines directly", session_id: "mon-session" });
  delivered = true;
};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Monitor", id: USE,
    input: { command: "watch-pipelines", description: "Watch pipelines" } }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: TASK }] });
  say({ type: "system", subtype: "task_started", task_id: TASK, tool_use_id: USE, description: "Watch pipelines" });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: USE, content: "Monitor started" }] } });
  ${endInWaiting ? "" : "die();"}
  say({ type: "assistant", message: { content: [{ type: "text", text: "I am watching the pipelines and will report back" }] } });
  say({ type: "result", result: "I am watching the pipelines and will report back", session_id: "mon-session" });
  ${endInWaiting ? "await gate(\"die\"); die();" : ""}
  await gate("deliver");
  deliver();
});
`;
}

test("if a monitor dies in the middle of the turn, stdin stays open for the delivered evaluation", async () => {
  await withServer(fakeClaudeMonitorDies({ endInWaiting: false }), async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Watch the pipelines and report back" }),
    });
    // The monitor died before the result: the server must keep stdin open for the delivery — only then it comes.
    await waitPhaseOrEnd(base, chat.id);
    gate.open("deliver");
    const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["I am watching the pipelines and will report back", "The watch has died — I will check the pipelines directly"],
    );
    // The monitor's life cycle is in the log (started + ended), the run ended regularly.
    const rows = log.filter((m) => m.role === "monitor").map((m) => JSON.parse(m.text).event);
    assert.deepEqual(rows, ["started", "done"]);
    assert.equal(log.filter((m) => m.role === "meta").length, 1);
    assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
  });
});

test("if a monitor dies silently in the wait phase, the run does not hang and the evaluation arrives", async () => {
  await withServer(fakeClaudeMonitorDies({ endInWaiting: true }), async ({ base, chat, gate }) => {
    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Watch the pipelines and report back" }),
    });
    // Result first (the monitor lives), THEN it dies in the wait phase, THEN the delivery comes — each step only when the
    // server has processed the previous one.
    await waitPhaseOrEnd(base, chat.id);
    gate.open("die");
    await waitFor(async () => {
      const it = (await json(`${base}/api/active-runs`)).items?.find((r) => r.chatId === chat.id);
      return !it || (it.background.monitors === 0 && it.background.tasks === 0);
    }, "the server has processed the monitor's death");
    gate.open("deliver");
    const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
    assert.deepEqual(
      log.filter((m) => m.role === "assistant").map((m) => m.text),
      ["I am watching the pipelines and will report back", "The watch has died — I will check the pipelines directly"],
    );
    assert.equal(log.filter((m) => m.role === "meta").length, 1);
    assert.equal(JSON.parse(log.find((m) => m.role === "meta").text).aborted, undefined);
  });
});

// Record the SSE frames of a chat until stopped.
function tapStream(base, chatId, onEvent) {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* ignore a broken frame */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return { stop: async () => { controller.abort(); await done; } };
}

// A background task (Bash, instead of the disabled CLI agent) that runs DURING the turn — plus token usage so the context
// display has something to report. The turn waits at the gate "finished" until the test has attached a second time in the
// middle of the run (= reload in the client).
const fakeClaudeBackgroundVisible = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
process.stdin.on("end", () => process.exit(0));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  say({ type: "assistant", message: { usage: { input_tokens: 4000, cache_read_input_tokens: 8000 },
    content: [{ type: "tool_use", name: "Bash", id: "toolu_vis_1",
      input: { command: "cat note.txt", description: "Read note", run_in_background: true } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_vis_1",
    content: "Command running in background with ID: task-vis" }] } });
  say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "task-vis" }] });
  say({ type: "system", subtype: "task_started", task_id: "task-vis", tool_use_id: "toolu_vis_1", description: "Read note" });
  await gate("finished");
  say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  say({ type: "system", subtype: "task_updated", task_id: "task-vis", patch: { status: "completed" } });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  say({ type: "result", result: "Done", session_id: "vis-session" });
});
`;

test("running background tasks are reported in the middle of the turn (background) and removed again", async () => {
  const previous = process.env.CBASE_AGENT_DRAIN_MS;
  process.env.CBASE_AGENT_DRAIN_MS = "500";
  try {
    await withServer(fakeClaudeBackgroundVisible, async ({ base, chat, gate }) => {
      const frames = [];
      const read = []; // everything the first reader has — for the stream barrier below
      const tap = tapStream(base, chat.id, (evt) => {
        read.push(evt);
        if (evt.type === "harness" && (evt.subtype === "background" || evt.subtype === "connected")) frames.push(evt);
      });
      await waitFor(() => frames.some((f) => f.subtype === "connected"), "first reader connected");
      await json(`${base}/api/chats/${chat.id}/message`, {
        method: "POST",
        body: JSON.stringify({ text: "Read the note" }),
      });
      // Attach a second time in the middle of the turn = reload in the client. The right moment is not "500 ms after the
      // message" but "as soon as the agent is reported as running": before that it is not registered yet (the CLI is
      // still starting); it is only removed when the test opens the gate "finished" — AFTER the rejoin.
      await waitFor(
        () => frames.some((f) => f.subtype === "background" && (f.tasks || []).length > 0),
        "the background task was never reported as running",
      );
      const rejoin = [];
      const tap2 = tapStream(base, chat.id, (evt) => {
        if (evt.type === "harness" && evt.subtype === "connected") rejoin.push(evt);
      });
      await waitFor(() => rejoin.length > 0, "no connected event on rejoin");
      await tap2.stop();
      gate.open("finished");
      await waitForQuiet(base);
      // First through the stream barrier, then unsubscribe: the idle check above is a look into the server, the reader lags —
      // the removing background event (`[]`) was still in flight under load when the reader closed, and the list below ended
      // after "Read note".
      await streamBarrier(read, chat.id);
      await tap.stop();

      const bg = frames.filter((f) => f.subtype === "background");
      assert.deepEqual(
        bg.map((f) => (f.tasks || []).map((a) => a.description)),
        [["Read note"], []],
        "the background task was not reported in the middle of the turn (or not removed again)",
      );
      // The rejoin in the middle of the run must know the task AND the context size — otherwise the client would show
      // "0 / 1M" and know nothing of running agents.
      assert.equal(rejoin.length, 1, "no connected event on rejoin");
      assert.equal(rejoin[0].running, true);
      assert.deepEqual((rejoin[0].tasks || []).map((a) => a.description), ["Read note"]);
      assert.equal(rejoin[0].contextTokens, 12_000, "connected does not carry the run's context size");
      // …and it is already in the DB before the run ends (reload/crash).
      const after = await json(`${base}/api/chats/${chat.id}`);
      assert.equal(after.contextTokens, 12_000);
    });
  } finally {
    if (previous === undefined) delete process.env.CBASE_AGENT_DRAIN_MS;
    else process.env.CBASE_AGENT_DRAIN_MS = previous;
  }
});

// ── Native subagents (cbase_agent) in the agent bar ──────────────────────────────────
//
// From here on it is no longer about the CLI's background agents but about cbase's native subagents. They have an own id
// space (agentId instead of task_id) and an own life cycle — and an operational bug depended exactly on that.
//
// TRAP (see native-agent-e2e.test.js): the server builds its BASE_URL from the passed port. With `port: 0` the MCP config
// says "…:0" and the fake CLI cannot call the route. These tests therefore need a real, free port.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Fake CLI for BOTH roles. The subagent recognises itself by the appended system prompt — the same feature by which a real
// model recognises its role. The main agent starts it via THE route that the cbase MCP server also calls (POST
// /api/chats/:id/agent); base URL and chat id are in the MCP config of its run.
// `subGate`: the subagent waits at this gate between its two measuring points (instead of sleeping `subDelayMs`);
// `subNever`: it never reaches its report (gate "never" that the test does not open — it is stopped from outside).
function fakeClaudeNativeSub({ subDelayMs = 0, subGate = "", subNever = false, bashAndEmptyList = false } = {}) {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
${FAKE_GATE}
const argv = process.argv.slice(2);
const isSub = argv.join(" ").includes("SUBAGENT of cbase");
const cfgPath = argv[argv.indexOf("--mcp-config") + 1] || "";
let env = {};
try { env = JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.cbase.env || {}; } catch {}
let done = false;
let turns = 0;
process.stdin.on("end", () => process.exit(done ? 0 : 3));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = (msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text) || "";

  if (isSub) {
    // Two measuring points with a gap: from them the display must build growing tokens and a speed.
    say({ type: "assistant", message: { id: "sub-1", usage: { input_tokens: 7, output_tokens: 3 },
      content: [{ type: "text", text: "First step" }] } });
    ${subGate ? `await gate(${JSON.stringify(subGate)});` : subDelayMs ? `await sleep(${subDelayMs});` : ""}
    say({ type: "assistant", message: { id: "sub-2", usage: { input_tokens: 20, output_tokens: 10 },
      content: [{ type: "text", text: "Second step" }] } });
    ${subNever ? `await gate("never");` : ""}
    done = true;
    say({ type: "result", result: "Subagent finding 42", session_id: "sub-session" });
    return;
  }

  turns += 1;
  if (turns === 1) {
    ${bashAndEmptyList ? `
    // A background COMMAND of the CLI so that the authoritative live list below is evaluated at all (the branch requires
    // at least one known CLI task).
    say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_sh_1",
      input: { command: "npm run dev", run_in_background: true } }] } });
    say({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "sh-1" }] });
    say({ type: "system", subtype: "task_started", task_id: "sh-1", tool_use_id: "toolu_sh_1" });
    ` : ""}
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_nat_call",
      name: "mcp__cbase__cbase_agent", input: { description: "Check on the side", prompt: "Take a look." } }] } });
    let t = "";
    try {
      const r = await fetch(env.CBASE_BASE_URL + "/api/chats/" + env.CBASE_CHAT_ID + "/agent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Check on the side", prompt: "Take a look.", run_in_background: true, callId: "toolu_nat_call" }),
      });
      t = JSON.stringify(await r.json());
    } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_nat_call", content: t }] } });
    ${bashAndEmptyList ? `
    // The CLI reports its live list — without the native subagent, since it knows nothing about it. This very event used
    // to throw it out together with its running work.
    say({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    ` : ""}
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text",
      text: t.indexOf("ERROR") === 0 ? t.slice(0, 200) : "Subagent running" }] } });
    say({ type: "result", result: "Subagent running", session_id: "main-session" });
    return;
  }
  // Second turn: it arises ONLY if the server delivered the report by itself.
  say({ type: "system", subtype: "init", session_id: "main-session" });
  say({ type: "assistant", message: { id: "main-3", content: [{ type: "text",
    text: "Delivered: " + text.slice(0, 300).replace(/\\n/g, " ") }] } });
  done = true;
  say({ type: "result", result: "fertig", session_id: "main-session" });
});
`;
}

async function withServerPort(script, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-nativebg-"));
  const bin = path.join(root, "fake-claude");
  const gate = gatesIn(path.join(root, "gates"));
  const previousBin = process.env.CLAUDE_BIN;
  const previousRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  let server;
  let base = "";
  let ok = false;
  try {
    fs.writeFileSync(bin, script.split("__BG_GATES__").join(path.join(root, "gates")));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_RESTART_GRACE_MS = RESTART_GRACE_OFF; // see withServer
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    const port = await freePort();
    server = await startServer({
      port, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"),
      pickDirectory: null, notify: null,
    });
    base = `http://127.0.0.1:${port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Native-BG", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Native-BG" }) });
    await fn({ base, chat, gate });
    ok = true;
  } finally {
    if (!ok) gate.all();
    if (base) await (ok ? waitForQuiet(base) : shortWaitForQuiet(base));
    if (previousRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS;
    else process.env.CBASE_RESTART_GRACE_MS = previousRestartGrace;
    // `closeAllConnections` BEFORE close: a test that fails on an assertion leaves its SSE reader open — without this line
    // server.close() would wait for it forever, and the failure would look like a hang.
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// Set environment variables and restore them EXACTLY as they were at the end — several suites share a process.
async function withEnv(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a native subagent reports the full payload — and its tokens grow during the run", async () => {
  // The tick of the live numbers is shortened so the test does not wait for the seconds.
  await withEnv({ CBASE_AGENT_TICK_MS: "60", CBASE_AGENT_DRAIN_MS: "800" }, async () => {
    await withServerPort(fakeClaudeNativeSub({ subGate: "sub-step" }), async ({ base, chat, gate }) => {
      holds(chat);
      const frames = [];
      const read = []; // everything the reader has — for the stream barrier below
      const tap = tapStream(base, chat.id, (evt) => {
        read.push(evt);
        if (evt.type === "harness" && evt.subtype === "background") frames.push(evt);
      });
      await waitFor(() => read.some((e) => e.subtype === "connected"), "reader connected");
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start on the side" }) });
      // Attach a second time in the middle of the run = reload in the client. The rejoin must know the running subagent with
      // the SAME fields — it is the second way the payload goes to the clients (`connected`), and it is easily forgotten.
      await waitFor(
        () => frames.some((f) => (f.agents || []).some((a) => a.description === "Check on the side")),
        "the native subagent was never reported as running",
      );
      const rejoin = [];
      const tap2 = tapStream(base, chat.id, (evt) => {
        if (evt.type === "harness" && evt.subtype === "connected") rejoin.push(evt);
      });
      await waitFor(() => rejoin.length > 0, "no connected event on rejoin");
      await tap2.stop();
      // The second measuring point only when the tick has reported the first — so two different numbers are in the stream, however
      // busy the machine is.
      await waitFor(() => frames.some((f) => (f.agents || []).some((a) => a.description === "Check on the side" && a.tokens > 0)),
        "the subagent's first usage is in the stream");
      gate.open("sub-step");
      await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
      await waitForQuiet(base);
      await streamBarrier(read, chat.id);
      await tap.stop();

      const again = (rejoin[0].agents || []).find((a) => a.description === "Check on the side");
      assert.ok(again, `connected does not know the running subagent: ${JSON.stringify(rejoin[0].agents)}`);
      assert.equal(again.toolUseId, "toolu_nat_call");
      assert.ok(["full", "only_output"].includes(again.tokenKind));

      const rows = frames.flatMap((f) => f.agents || []).filter((a) => a.description === "Check on the side");
      assert.ok(rows.length >= 2, `too few reports of the subagent: ${JSON.stringify(frames.map((f) => f.agents))}`);

      // 1) Contract A: EVERY field is there — otherwise the bar shows a gap nobody explains.
      const first = rows[0];
      for (const field of ["taskId", "agentId", "description", "name", "provider", "model", "status", "startedAt", "tokens", "tokenKind", "toolUses"]) {
        assert.ok(field in first, `field ${field} is missing in the payload: ${JSON.stringify(first)}`);
      }
      assert.match(first.agentId, /^a[0-9a-f]{8}-\d+$/, "the core's agentId belongs in the payload");
      assert.equal(first.taskId, first.agentId);
      assert.equal(first.provider, "claude");
      // Two LIVING states: "starting" is reported by the core on creation, "running" from the subagent's first turn. Both belong in
      // the bar — an agent that is still starting up is there.
      assert.ok(["starting", "running"].includes(first.status), `unexpected status: ${first.status}`);
      assert.ok(rows.some((a) => a.status === "running"), "no agent ever reports the state running");
      assert.ok(first.startedAt > 0, "without startedAt there is no run time");
      // The call block under which the subagent hangs in the log: the client merges live report and log block by it instead of
      // showing the same agent twice.
      assert.equal(first.toolUseId, "toolu_nat_call");
      // ONE notation: plain model id (or empty) plus a separate provider — never "a::b".
      assert.equal(first.model.includes("::"), false, `model must not carry a provider: ${first.model}`);

      // 2) Contract B: the tokens grow DURING the run. With the old publicRec (rec.usage, set only after `await runChat`) this
      //    stood at 0 everywhere until the end.
      const values = rows.map((a) => a.tokens);
      assert.ok(Math.max(...values) > Math.min(...values),
        `the tokens of a running subagent do not grow: ${JSON.stringify(values)}`);
      assert.ok(Math.max(...values) >= 10, `too little counted: ${JSON.stringify(values)}`);
      // The Claude CLI reports both sides (message.id + usage) → the number is complete.
      const withToken = rows.find((a) => a.tokens > 0);
      assert.equal(withToken.tokenKind, "full");

      // 3) Contract C/E: after the end the agent is gone from the LIVE list (intended — finished agents are reconstructed by the
      //    client from the log).
      assert.deepEqual(frames[frames.length - 1].agents, []);

      // 4) The report reached the main agent, the run ended regularly.
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
      assert.equal(texts.length, 2, `unexpected answers: ${JSON.stringify(texts)}`);
      assert.match(texts[1], /Subagent finding 42/);
    });
  });
});

test("the CLI's live list does NOT throw out a native subagent", async () => {
  // An operational bug: `background_tasks_changed` is THE CLI's authoritative list. A cbase agentId is never in it — while both
  // kinds lay in one map, every such event removed the working subagent: display gone, deadline started, run ended,
  // subagent killed, main agent never woken. That happened in the middle of a workflow.
  await withEnv({
    CBASE_AGENT_TICK_MS: "60",
    CBASE_AGENT_DRAIN_MS: "400",   // the deadline the run used to run into
    CBASE_BG_TASK_IDLE_MS: "300",  // the background command must not hold the run as a substitute
  }, async () => {
    // The subagent's 900 ms stay: they ARE the subject — longer than the deadline (400 ms) the run used to run into. A gate
    // would not work here: it must be shown that the deadline had its chance.
    await withServerPort(fakeClaudeNativeSub({ subDelayMs: 900, bashAndEmptyList: true }), async ({ base, chat }) => {
      holds(chat);
      const frames = [];
      const read = [];
      const tap = tapStream(base, chat.id, (evt) => {
        read.push(evt);
        if (evt.type === "harness" && evt.subtype === "background") frames.push(evt);
      });
      await waitFor(() => read.some((e) => e.subtype === "connected"), "reader connected");
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start on the side" }) });
      const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
      await waitForQuiet(base);
      await streamBarrier(read, chat.id);
      await tap.stop();

      // (a) After the empty live list the subagent stays in the display. Without the separation of the two kinds the last report
      //     before the run end was empty.
      const afterEmptyList = frames
        .map((f) => (f.agents || []).filter((a) => a.description === "Check on the side").length)
        .lastIndexOf(0);
      assert.ok(
        frames.slice(afterEmptyList + 1).some((f) => (f.agents || []).some((a) => a.description === "Check on the side")) ||
        frames.some((f) => (f.agents || []).some((a) => a.description === "Check on the side") && (f.tasks || []).length === 0),
        `the native subagent vanished with the CLI's live list: ${JSON.stringify(frames.map((f) => [(f.agents || []).map((a) => a.description), (f.tasks || []).length]))}`,
      );

      // (b) Its report was delivered …
      const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
      assert.equal(texts.length, 2, `the follow-up turn with the report is missing: ${JSON.stringify(texts)}`);
      assert.match(texts[1], /Subagent finding 42/);
      // … (c) and the run ended regularly, not cut off prematurely.
      const metas = log.filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
      assert.equal(metas.length, 1);
      assert.equal(metas[0].aborted, undefined);
    });
  });
});

test("a subagent stopped by the HUMAN delivers a result to the main agent", async () => {
  // Without feedback the main agent's turn would run into the deadline (AGENT_DRAIN_MS) and end silently — the human would have
  // stopped and never learned whether the run continues.
  await withEnv({ CBASE_AGENT_TICK_MS: "60", CBASE_AGENT_DRAIN_MS: "10000" }, async () => {
    // The subagent never reaches its report (gate "never") — so a test that takes longer to the stop under load never sees it
    // finish by itself.
    await withServerPort(fakeClaudeNativeSub({ subNever: true }), async ({ base, chat }) => {
      holds(chat);
      const frames = [];
      let connected = false;
      const tap = tapStream(base, chat.id, (evt) => {
        if (evt.type === "harness" && evt.subtype === "connected") connected = true;
        if (evt.type === "harness" && evt.subtype === "background") frames.push(evt);
      });
      await waitFor(() => connected, "reader connected");
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start on the side" }) });
      await waitFor(
        () => frames.some((f) => (f.agents || []).some((a) => a.description === "Check on the side")),
        "the native subagent was never reported as running",
      );
      const agentId = frames.flatMap((f) => f.agents || []).find((a) => a.description === "Check on the side").agentId;

      // Stop only when the CLI has written its OWN tool_result ("status: running"). The background start reports the agent in
      // the bar already before the POST answer reaches the fake; a stop in between would let the running row land AFTER the
      // report — the block would then say "running" again without anything being wrong in the product.
      const isRow = (m) => m.role === "tool_result" && JSON.parse(m.text).id === "toolu_nat_call";
      const beforeLog = await waitForLog(base, chat.id, (l) => l.some(isRow));
      assert.ok(beforeLog.some(isRow), "the CLI never wrote its own tool_result");

      const stop = await json(`${base}/api/chats/${chat.id}/agent/stop`, {
        method: "POST", body: JSON.stringify({ agentId, from: "human" }),
      });
      assert.equal(stop.ok, true);

      const log = await waitForLog(base, chat.id, (l) => l.some((m) => m.role === "meta"));
      await waitForQuiet(base);
      await tap.stop();

      // EXACTLY one result, and it says who stopped.
      const texts = log.filter((m) => m.role === "assistant").map((m) => m.text);
      assert.equal(texts.length, 2, `unexpected answers: ${JSON.stringify(texts)}`);
      assert.match(texts[1], /Stopped by the human\. No result\./);
      assert.match(texts[1], /status stopped/);

      // The call block carries the same state — WITHOUT an error mark: a stop is a result, not an error. The synthesised block
      // carries `is_error` only for `status: "failed"` — the same rule as in the MCP server (agent report) and in the engine;
      // before, `!== "completed"` applied, and the deliberately stopped agent counted as an error and potentially as limit
      // evidence for the parent run. Status and text stay in the block (checked above) — that is how the chat sees who stopped.
      const results = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).filter((r) => r.id === "toolu_nat_call");
      const last = JSON.parse(results[results.length - 1].result);
      assert.equal(last.status, "stopped");
      assert.match(last.report, /Stopped by the human/);
      assert.equal(results[results.length - 1].isError, false, "a stopped subagent is no error — only \"failed\" carries is_error");

      // The run did not run into the deadline: it ended while the deadline (10 s) was still open.
      const metas = log.filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
      assert.equal(metas.length, 1);
      assert.equal(metas[0].aborted, undefined);
    });
  });
});
