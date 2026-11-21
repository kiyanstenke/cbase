// The stall watchdog of the subagents.
//
// A subagent that shows no progress for `agentStallDeadline()` (default 600 s) ends as FAILED with the reason
// "No progress" — through the stop of the core, but not as stopped: its completion notice comes, and cbase_agent_send
// resumes it. The clock stands while a tool call is open (providers/stall-watchdog.js).
//
// No clock in the test: the deadline is set to one hour (as in the gate), and the test ADVANCES the clock — the unit with a
// pure counting clock (`adjustableClock({real:false})`), the server through the test seam `advanceStallClock`
// (runs/agents.js). Tests wait for events (a line in the history, the watchdog's state, process end), never for a duration.
//
// The three ways at the main seam (agent-harness.mjs): fake Claude (stream-json), fake Codex (`exec --json` with the
// vocabulary measured on 0.153.1: `item.started`/`item.completed` with the same item id, silence in between) and the
// loop engine (fake preset endpoint, a real Bash call). The printed measurement row says per way whether the watchdog
// saw a tool signal.
//
// Counter-proof (which sabotage turns which test red): the clock keeps running during the tool call (`on` in
// stall-watchdog.js without `disarm()`, `sharpness` without the `open.size` guard) => the tool tests are red (child
// already ended during the call), none hangs.
process.env.CBASE_AGENT_STALL_MS = String(3_600_000);

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { coreWithAgent, liveAgents, stallState, advanceStallClock } from "../electron/server/runs/agents.js";
import { agentStallDeadline, createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { createStallWatchdog, adjustableClock } from "../electron/server/providers/stall-watchdog.js";

const DEADLINE = 10_000;

// ── The watchdog alone ──────────────────────────────────────────────────────────────────────────
function watchdog(opts = {}) {
  const clock = adjustableClock({ real: false });
  const log = [];
  const w = createStallWatchdog({ deadlineMs: DEADLINE, clock, atStall: (i) => log.push(["stall", i.attempt]), atTask: (i) => log.push(["task", i.attempts]), ...opts });
  return { clock, log, w };
}

test("watchdog: silence up to the deadline => task, exactly once; progress pushes the deadline", () => {
  const { clock, log, w } = watchdog();
  clock.advance(DEADLINE - 1);
  assert.deepEqual(log, [], "nothing before the deadline");
  w.observe({ type: "stream_event", event: { type: "content_block_delta" } });
  clock.advance(DEADLINE - 1);
  assert.deepEqual(log, [], "an event is progress — the deadline starts over");
  clock.advance(1);
  assert.deepEqual(log, [["task", 1]]);
  clock.advance(10 * DEADLINE);
  assert.deepEqual(log, [["task", 1]], "no second time after the task");
  assert.equal(clock.count(), 0, "no alarm stays set");
});

test("watchdog: an open tool call stops the clock; after its end it starts over", () => {
  const { clock, log, w } = watchdog();
  w.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "tool_use", id: "t2", name: "Grep", input: {} }] } });
  assert.equal(w.snapshot().open, 2);
  clock.advance(10 * DEADLINE);
  assert.deepEqual(log, [], "two open calls: no stall");
  w.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
  clock.advance(10 * DEADLINE);
  assert.deepEqual(log, [], "one is still open");
  w.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } });
  clock.advance(DEADLINE - 1);
  assert.deepEqual(log, [], "the clock starts at the end of the last call");
  clock.advance(1);
  assert.deepEqual(log, [["task", 1]]);
  assert.equal(w.snapshot().calls, 2);
});

test("watchdog: deadline and repetitions are parameters — first atStall per repetition, then the task", () => {
  const { clock, log } = watchdog({ deadlineMs: 180, repetitions: 2 });
  clock.advance(180);
  assert.deepEqual(log, [["stall", 1]]);
  clock.advance(179);
  assert.deepEqual(log, [["stall", 1]], "after a repetition the deadline starts over");
  clock.advance(1);
  clock.advance(180);
  assert.deepEqual(log, [["stall", 1], ["stall", 2], ["task", 3]]);
});

test("watchdog: end() switches it off — no alarm, no task", () => {
  const { clock, log, w } = watchdog();
  w.end();
  assert.equal(clock.count(), 0);
  clock.advance(10 * DEADLINE);
  assert.deepEqual(log, []);
});

test("deadline from the environment, default 600 s", () => {
  const prior = process.env.CBASE_AGENT_STALL_MS;
  try {
    delete process.env.CBASE_AGENT_STALL_MS;
    assert.equal(agentStallDeadline(), 600_000);
    process.env.CBASE_AGENT_STALL_MS = "180000";
    assert.equal(agentStallDeadline(), 180_000);
  } finally { process.env.CBASE_AGENT_STALL_MS = prior; }
});

// ── The core: failed, not stopped ───────────────────────────────────────────────────────────────
test("core: a stall abort goes through the stop — child ended, status failed, completion notice not suppressed, send resumes", async () => {
  const clock = adjustableClock({ real: false });
  const runs = [];
  const reports = [];
  const rt = createAgentRuntime({
    chatId: "c-stall",
    cwd: process.cwd(),
    parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: (o) => ({ input: o.input }),
    // A child that stays silent after the start until it gets a signal.
    runChat: ({ spec, onEvent, onSpawn }) => new Promise((resolve) => {
      const run = { input: spec.input, killed: false };
      runs.push(run);
      onSpawn({ kill: () => { run.killed = true; resolve({ code: 143, sessionId: "s1" }); } });
      onEvent({ type: "system", subtype: "init", session_id: "s1" });
    }),
    stallClock: clock,
    onFinish: (rec, info) => reports.push(info),
  });
  try {
    const first = await rt.start({ prompt: "Do something", description: "Silent one" });
    assert.equal(first.status, "running");
    clock.advance(agentStallDeadline());
    assert.equal(reports.length, 1, "exactly one end");
    const [info] = reports;
    assert.equal(info.report.status, "failed");
    assert.match(info.report.error, /^No progress for 3600 s/);
    assert.equal(info.stopped, false, "no stop: the completion notice is delivered");
    assert.equal(runs[0].killed, true, "the child got the signal");
    assert.equal(rt.get(first.agentId).status, "failed");
    // One stopped by the human would be rejected — this one is resumed.
    const further = await rt.send({ agentId: first.agentId, message: "Try it once more." });
    assert.equal(further.resumed, true, JSON.stringify(further));
    assert.equal(runs.length, 2);
    assert.equal(runs[1].input, "Try it once more.");
    // Counterpart: the human stop stays what it was.
    rt.stop(first.agentId, { ofHuman: true });
    await assert.rejects(rt.send({ agentId: first.agentId, message: "And now?" }), /stopped by the human/);
  } finally { rt.close(); }
});

// The restart by the human kills the process in the middle of a tool call — its tool_result never comes. Before, the call
// stayed open in the watchdog, the clock stood for the rest of the turn, and an agent that then went silent ran "running"
// forever. Now the open calls fall with the old process.
test("core: after a restart with an open tool the stall clock runs again", async () => {
  const clock = adjustableClock({ real: false });
  const runs = [];
  const reports = [];
  const rt = createAgentRuntime({
    chatId: "c-stall-restart",
    cwd: process.cwd(),
    parentProvider: "claude",
    resolveRef: () => ({ connector: {}, providerId: "claude", model: "" }),
    buildSpec: (o) => ({ input: o.input }),
    // The first process opens a tool call and hangs in it; the second is silent without a tool.
    runChat: ({ onEvent, onSpawn }) => new Promise((resolve) => {
      const run = { killed: false };
      runs.push(run);
      onSpawn({ kill: () => { run.killed = true; resolve({ code: 143, sessionId: "s1" }); } });
      onEvent({ type: "system", subtype: "init", session_id: "s1" });
      if (runs.length === 1) onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_hangs", name: "Bash", input: { command: "sleep 9999" } }] } });
    }),
    stallClock: clock,
    onFinish: (rec, info) => reports.push(info),
  });
  try {
    const first = await rt.start({ prompt: "Do something", description: "Hanger" });
    assert.equal(rt.stallState(first.agentId).open, 1, "the call of the first process is open");
    assert.equal(rt.restart(first.agentId).ok, true);
    while (runs.length < 2) await new Promise((r) => setImmediate(r));
    assert.equal(runs[0].killed, true);
    assert.equal(rt.stallState(first.agentId).open, 0, "what was open in the killed process never closes — it no longer counts");
    clock.advance(agentStallDeadline());
    assert.equal(reports.length, 1, "the silent second process ends at the deadline");
    assert.equal(reports[0].report.status, "failed");
    assert.match(reports[0].report.error, /^No progress/);
  } finally { rt.close(); }
});

// ── The three ways ──────────────────────────────────────────────────────────────────────────────
// On the job the main agent starts ONE agent in the background (model from `<LOCATION>/job.json`) and ends; it writes
// every completion notice back ("Delivered: …").
const main = `
    if (!text.startsWith("<task-notification>")) {
      const a = JSON.parse(fs.readFileSync(path.join(LOCATION, "job.json"), "utf8"));
      const input = { description: a.description, prompt: "Take a look.", run_in_background: true, ...(a.model ? { model: a.model } : {}) };
      say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_start", name: "mcp__cbase__cbase_agent", input }] } });
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent", input)); } catch (e) { t = "FEHLER " + e.message; }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_start", content: t }] } });
      finished();
      say({ type: "result", result: "Agent started", session_id: "main-session" });
      return;
    }
    say({ type: "system", subtype: "init", session_id: "main-session" });
    say({ type: "assistant", message: { id: "main-t" + turn, content: [{ type: "text", text: "Delivered: " + text.replace(/\\s+/g, " ").slice(0, 4000) }] } });
    finished();
    say({ type: "result", result: "ok", session_id: "main-session" });`;

// Claude subagent: "stays_silent" = init, then nothing; "tool" = a Bash call that hangs at gate "lang-claude", afterwards
// silence (nobody opens gate "still-claude").
const fakeClaudeStall = fakeClaude({
  main,
  sub: `
    fs.writeFileSync(path.join(LOCATION, "kind-claude.pid"), String(process.pid));
    say({ type: "system", subtype: "init", session_id: "sub-stall" });
    if (fs.readFileSync(path.join(LOCATION, "scenario"), "utf8") === "tool") {
      say({ type: "assistant", message: { id: "sub-1", content: [{ type: "tool_use", id: "toolu_lang", name: "Bash", input: { command: "make" } }] } });
      await gate("lang-claude");
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_lang", content: "built" }] } });
    }
    await gate("still-claude");`,
});

// Codex subagent, the same script in the measured vocabulary.
const fakeCodexStall = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it — without rename it read an empty one under
// load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
fs.writeFileSync(path.join(LOCATION, "kind-codex.pid"), String(process.pid));
const say = (o) => console.log(JSON.stringify(o));
const gate = (name) => new Promise((r) => {
  try { fs.writeFileSync(path.join(LOCATION, "gates", name + ".waiting"), String(process.pid)); } catch {}
  const t = setInterval(() => { if (fs.existsSync(path.join(LOCATION, "gates", name))) { clearInterval(t); r(); } }, 20);
});
(async () => {
  say({ type: "thread.started", thread_id: "codex-stall" });
  say({ type: "turn.started" });
  if (fs.readFileSync(path.join(LOCATION, "scenario"), "utf8") === "tool") {
    say({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "make", aggregated_output: "", exit_code: null, status: "in_progress" } });
    await gate("lang-codex");
    say({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "make", aggregated_output: "built", exit_code: 0, status: "completed" } });
  }
  await gate("still-codex");
})();
`;

// Loop engine: "stays_silent" = the model request never returns; "tool" = a real Bash call that waits for the file of
// gate "lang-engine" (and stores its pid), afterwards a model request that never returns.
const engine = { scenario: "", root: "", calls: 0 };
const never = () => new Promise(() => {});
const engineStall = {
  round: () => {
    engine.calls += 1;
    if (engine.scenario !== "tool" || engine.calls > 1) return never();
    const gates = path.join(engine.root, "gates");
    const command = `echo $$ > '${path.join(engine.root, "kind-engine.pid")}'; : > '${path.join(gates, "lang-engine.waiting")}'; `
      + `while [ ! -f '${path.join(gates, "lang-engine")}' ]; do sleep 0.05; done; echo built`;
    return { toolCalls: [{ id: "call_lang", name: "Bash", arguments: { command, timeout: 600_000 } }] };
  },
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const rowsOf = (chatId) => liveAgents().filter((z) => z.chatId === chatId);
const delivered = (log) => log.filter((m) => m.role === "assistant" && m.text.startsWith("Delivered:")).map((m) => m.text).join("\n");
const WAYS = {
  claude: { model: "", pid: "kind-claude.pid", tool: "toolu_lang" },
  codex: { model: "codex::gpt-5.1-codex", pid: "kind-codex.pid", tool: "item_1" },
  engine: { model: "", pid: "kind-engine.pid", tool: "call_lang" },
};
const measurementRow = {};

async function stallRun(ctx, way, scenario) {
  const { base, chat, root } = ctx;
  const w = WAYS[way];
  const description = `Stall-${way}-${scenario}`;
  fs.writeFileSync(path.join(root, "scenario"), scenario);
  fs.writeFileSync(path.join(root, "job.json"), JSON.stringify({ description, model: way === "engine" ? ctx.engine.model : w.model }));
  if (way === "engine") Object.assign(engine, { scenario, root, calls: 0 });
  await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Work with an agent" }) });
  const agent = await ctx.waitForTruthy(() => rowsOf(chat.id).find((z) => z.description === description), "agent lives");
  const deadline = agentStallDeadline();

  if (scenario === "tool") {
    // The call is open as soon as its tool_use stands in the history (the watchdog sees every event BEFORE the history).
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "tool" && m.text.includes(`"${w.tool}"`)));
    const on = stallState(chat.id, agent.agentId);
    measurementRow[way] = on?.calls > 0 ? `yes (${on.calls} call seen)` : "MISSING";
    assert.equal(on?.open, 1, `${way}: the watchdog sees the open call: ${JSON.stringify(on)}`);
    advanceStallClock(2 * deadline);
    assert.ok(rowsOf(chat.id).some((z) => z.agentId === agent.agentId && z.status === "running"), `${way}: not ended in the tool call`);
    await ctx.gate.reached(`lang-${way}`);
    ctx.gate.open(`lang-${way}`);
    await ctx.waitForLog(chat.id, (l) => l.some((m) => m.role === "tool_result" && m.text.includes(`"${w.tool}"`)));
    assert.equal(stallState(chat.id, agent.agentId)?.open, 0, `${way}: the call is closed`);
    advanceStallClock(deadline / 2);
    assert.ok(rowsOf(chat.id).some((z) => z.agentId === agent.agentId), `${way}: the clock started at the end of the call, not before`);
    advanceStallClock(deadline / 2);
  } else {
    // The child stands (Claude/Codex: process there), then the deadline.
    if (way !== "engine") await ctx.waitForTruthy(() => fs.existsSync(path.join(root, w.pid)), "child started");
    else await ctx.waitForTruthy(() => engine.calls > 0, "model request made");
    advanceStallClock(deadline);
  }

  // Failed with a reason — as a completion notice at the main agent; no slot occupied any more; nothing runs on.
  const log = await ctx.waitForLog(chat.id, (l) => delivered(l).includes(`Agent "${description}" failed`));
  assert.match(delivered(log), new RegExp(`Agent "${description}" failed: No progress for ${Math.round(deadline / 1000)} s`));
  assert.ok(!rowsOf(chat.id).some((z) => z.agentId === agent.agentId), `${way}: its slot is free`);
  const pidFile = path.join(root, w.pid);
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await ctx.waitForTruthy(() => !alive(pid), `${way}: child ended`);
    fs.rmSync(pidFile);
  }
  // The core still knows it (resumable) — as failed, not as stopped.
  assert.equal(coreWithAgent(chat.id, agent.agentId)?.get(agent.agentId)?.status, "failed", `${way}: failed, not stopped`);
}

// The provider registry is module state: every server with an engine gets its own provider id.
const withServer = (way, scenario) => withAgentsServer((ctx) => stallRun(ctx, way, scenario), {
  claude: fakeClaudeStall, codex: fakeCodexStall, engine: way === "engine" ? { ...engineStall } : false,
});
for (const way of Object.keys(WAYS)) {
  test(`${way}: a child that stays silent after the start ends as failed after the deadline — "No progress" in the completion notice`, () => withServer(way, "stays_silent"));
  test(`${way}: a child in a long tool call is not ended — afterwards the clock runs again`, () => withServer(way, "tool"));
}

test("measurement row: tool signal of the stall watchdog per way", (t) => {
  const row = Object.keys(WAYS).map((w) => `${w}=${measurementRow[w] || "not measured"}`).join(", ");
  t.diagnostic(`stall watchdog, tool signal per way: ${row}`);
  for (const w of Object.keys(WAYS)) assert.match(measurementRow[w] || "", /^yes/, `way ${w} without a tool signal — the watchdog would run there without a tool pause`);
});
