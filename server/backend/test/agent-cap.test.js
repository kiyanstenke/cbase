// Cap on concurrent subagents per CHAT, at the main seam: real server, real cbase MCP server, real core
// (runs/agents.js + providers/agent-runtime.js), fake provider of the agent harness. The knob CBASE_AGENT_CAP is set to a
// small number per test (the server runs in the same process and reads it on each call); the default without the knob
// is in the diagnostic line, not in a title.
//
// The subagents wait at gate files (they LIVE until the test opens) — no clock decides whether one is still running.
//
// Counter-test: the old cap — 8 per run in the core, environment ignored (`slotMissing` in the core replaced by the old
// count) — turns test 1 red (it starts the fourth agent), and likewise the engine and continuation tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { AGENT_CAP_DEFAULT, agentCap } from "../electron/server/runs/agents.js";
import { runKindDefault, registerRunKind } from "../electron/server/runs/hooks.js";

// The main agent runs the commands of its input in order, one tool call with its own block each:
//   START:X   cbase_agent in the background, name X, task "[X]" (the subagent waits at gate "subX")
//   VG:X      the same in the FOREGROUND — a test with VG sets the foreground deadline to 1 ms: the agent switches
//             to the background at once, the call returns, the agent lives on (it waits at its gate)
//   KURZ:X    foreground without a gate — the subagent reports at once, the call waits for it
//   SENDE:X:Y cbase_agent_send to X in the background, message "[Y]" (gate "subY")
//   WARTE:X   cbase_agent_output on X (blocks until X is done)
// An error result of the MCP server is prefixed with "FEHLER " in the tool result.
const fake = fakeClaude({
  sub: `
    const m = /\\[([A-Z][0-9]?)\\]/.exec(text) || /\\{([A-Z])\\}/.exec(text);
    try { fs.writeFileSync(path.join(LOCATION, "sub-start-" + (m ? m[1] : "x")), "1"); } catch {}
    if (m && text.includes("[")) await gate("sub" + m[1]);
    finished();
    say({ type: "result", result: "sub", session_id: "sub-session-" + (m ? m[1] : "x") });`,
  main: `
  const calls = async (name, args, id) => {
    say({ type: "assistant", message: { id: "m-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__" + name, input: args }] } });
    let t = "";
    try { const r = await mcpCall(name, args); t = (r && r.result && r.result.isError ? "FEHLER " : "") + textOf(r); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  };
  for (const op of text.match(/\\b(START|VG|KURZ|SENDE|WARTE):[A-Z0-9:]+/g) || []) {
    const [kind, x, y] = op.split(":");
    const id = "toolu_" + op.replace(/[^A-Za-z0-9]/g, "_");
    if (kind === "START") await calls("cbase_agent", { description: "Aside " + x, name: x, prompt: "Task [" + x + "].", run_in_background: true }, id);
    else if (kind === "VG") await calls("cbase_agent", { description: "Front " + x, name: x, prompt: "Task [" + x + "].", run_in_background: false }, id);
    else if (kind === "KURZ") await calls("cbase_agent", { description: "Short " + x, name: x, prompt: "Task {" + x + "}.", run_in_background: false }, id);
    else if (kind === "SENDE") await calls("cbase_agent_send", { agentId: x, message: "Continue [" + y + "].", run_in_background: true }, id);
    else if (kind === "WARTE") await calls("cbase_agent_output", { agentId: x }, id);
  }
  say({ type: "assistant", message: { id: "main-end-" + turn, content: [{ type: "text", text: "Turn " + turn + " fertig" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

const blockId = (op) => `toolu_${op.replace(/[^A-Za-z0-9]/g, "_")}`;

// The tool result of a command from the history — as soon as it is there.
const result = (waitForLog, chatId, op) => waitForLog(chatId, (l) => l.some((m) => m.role === "tool_result" && JSON.parse(m.text).id === blockId(op)))
  .then((l) => JSON.parse(l.find((m) => m.role === "tool_result" && JSON.parse(m.text).id === blockId(op)).text).result);

const denied = (t, limit) => {
  assert.match(t, /^FEHLER /, `no tool error: ${t.slice(0, 300)}`);
  assert.match(t, /Cap reached/, t);
  assert.match(t, /do not repeat/i, t);
  assert.match(t, new RegExp(`the boundary is ${limit} per chat`), t);
};
const started = (t) => assert.doesNotMatch(t, /^FEHLER /, `abgewiesen: ${t.slice(0, 300)}`);

// The living agents of this chat according to the ONE query for open background work.
const live = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId);

// Everything under the data folder that belongs to a subagent of this chat (MCP config `<chat>.agent-<id>.mcp.json`,
// browser profile `<chat>-agent-<id>`) — per agent id.
function agentTraces(dataRoot, chatId) {
  const ids = new Set();
  const re = new RegExp(`${chatId}[.-]agent-([A-Za-z0-9-]+?)(?:\\.mcp\\.json)?$`);
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const m = re.exec(e.name);
      if (m) ids.add(m[1]);
      if (e.isDirectory()) run(path.join(dir, e.name));
    }
  };
  run(dataRoot);
  return ids;
}

// Only THIS chat does not hold — its agents outlive the turn.
const withoutHold = (chatId) =>
  registerRunKind(`test-without-hold-${chatId}`, (c) => ({ ...runKindDefault(c), hold: false }), { detects: (c) => c.id === chatId });

async function withSlider(value, fn, { foregroundMs = 0 } = {}) {
  const prior = process.env.CBASE_AGENT_CAP;
  const deadlinePrior = process.env.CBASE_AGENT_FOREGROUND_MS;
  process.env.CBASE_AGENT_CAP = String(value);
  // VG:X returns only after the foreground deadline (`wait_ms` has no effect any more) — whoever uses VG sets it small.
  // Never together with KURZ: a subagent without a gate that needs longer than the deadline would switch along.
  if (foregroundMs) process.env.CBASE_AGENT_FOREGROUND_MS = String(foregroundMs);
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_CAP;
    else process.env.CBASE_AGENT_CAP = prior;
    if (deadlinePrior === undefined) delete process.env.CBASE_AGENT_FOREGROUND_MS;
    else process.env.CBASE_AGENT_FOREGROUND_MS = deadlinePrior;
  }
}

const message = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
// The n-th turn is over when n closing lines are in the history (each turn is its own fake process).
const turnFinished = (waitForLog, chatId, n) => waitForLog(chatId, (l) => l.filter((m) => m.role === "assistant" && /^Turn \d+ fertig$/.test(m.text)).length >= n);

test("Without the knob the default applies; an unusable knob is not a statement", (t) => {
  const prior = process.env.CBASE_AGENT_CAP;
  try {
    delete process.env.CBASE_AGENT_CAP;
    t.diagnostic(`measurement: cap without knob = ${agentCap()} subagents per chat`);
    assert.equal(agentCap(), AGENT_CAP_DEFAULT);
    assert.equal(AGENT_CAP_DEFAULT, 20, "the default of the spec");
    for (const raw of ["", "0", "-3", "2.5", "abc"]) {
      process.env.CBASE_AGENT_CAP = raw;
      assert.equal(agentCap(), AGENT_CAP_DEFAULT, `knob "${raw}"`);
    }
    process.env.CBASE_AGENT_CAP = "7";
    assert.equal(agentCap(), 7);
  } finally {
    if (prior === undefined) delete process.env.CBASE_AGENT_CAP;
    else process.env.CBASE_AGENT_CAP = prior;
  }
});

test("Cap per chat (small knob): foreground and background count together, also beyond the turn; the fourth fails at once, nothing is made up later", async () => {
  await withSlider(3, () => withAgentsServer(async ({ base, chat, dataRoot, root, gate, waitForTruthy, waitForLog, waitForIdle }) => {
    withoutHold(chat.id);
    const open = ["subA", "subB", "subC", "subF"];
    try {
      // Turn 1: two in the background, one in the foreground — the fourth call gets the tool error.
      // Results first (they always come), then the gates — a wrongly rejected agent would never reach its gate.
      await message(base, chat.id, "START:A VG:B START:C START:D");
      await turnFinished(waitForLog, chat.id, 1);
      for (const op of ["START:A", "VG:B", "START:C"]) started(await result(waitForLog, chat.id, op));
      denied(await result(waitForLog, chat.id, "START:D"), 3);
      for (const x of ["A", "B", "C"]) await gate.reached(`sub${x}`);
      // No child: no process, no MCP config, no browser profile — only the three living ones leave traces.
      assert.equal(fs.existsSync(path.join(root, "sub-start-D")), false, "the rejected subagent has a process");
      const liveness = await live(base, chat.id);
      assert.equal(liveness.length, 3, JSON.stringify(liveness));
      assert.deepEqual([...agentTraces(dataRoot, chat.id)].sort(), liveness.map((a) => a.agentId).sort(), "traces of an agent that was not started");

      // Turn 2: the three live in a core whose turn is over — they still count (per chat, not per turn).
      await message(base, chat.id, "START:E");
      await turnFinished(waitForLog, chat.id, 2);
      denied(await result(waitForLog, chat.id, "START:E"), 3);

      // A slot frees up: the next call starts normally — and the rejected ones stay rejected.
      gate.open("subA");
      await waitForTruthy(async () => (await live(base, chat.id)).length === 2, "A is done");
      await message(base, chat.id, "START:F");
      started(await result(waitForLog, chat.id, "START:F"));
      await gate.reached("subF");
      for (const x of ["D", "E"]) assert.equal(fs.existsSync(path.join(root, `sub-start-${x}`)), false, `${x} was started late`);
    } finally {
      for (const t of open) gate.open(t);
    }
    await waitForIdle();
  }, { claude: fake }), { foregroundMs: 1 });
});

test("Continuation via cbase_agent_send: not rejected at a full cap, then occupies its slot", async () => {
  await withSlider(3, () => withAgentsServer(async ({ base, chat, gate, waitForLog, waitForIdle }) => {
    try {
      // A reports at once; B, C, D fill the cap; the continuation of A still gets through (4 live);
      // E fails. Then B ends — F still fails, because the continuation holds its slot.
      await message(base, chat.id, "KURZ:A START:B START:C START:D SENDE:A:A2 START:E WARTE:B START:F");
      started(await result(waitForLog, chat.id, "START:D"));
      started(await result(waitForLog, chat.id, "SENDE:A:A2"));
      denied(await result(waitForLog, chat.id, "START:E"), 3);
      await gate.reached("subA2");
      gate.open("subB");
      started(await result(waitForLog, chat.id, "WARTE:B"));
      denied(await result(waitForLog, chat.id, "START:F"), 3);
    } finally {
      for (const t of ["subB", "subC", "subD", "subA2"]) gate.open(t);
    }
    await waitForIdle();
  }, { claude: fake }));
});

test("Ultracode on the chat: no cap — the fourth starts; mode off => the tool error again", async () => {
  await withSlider(3, () => withAgentsServer(async ({ base, chat, gate, waitForLog, waitForIdle }) => {
    withoutHold(chat.id);
    try {
      // The harness chat runs Haiku 4.5 — a model without grades carries no mode; Opus does.
      const turnedOn = await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
      assert.equal(turnedOn.ultracode, true, "setup: the mode is on");
      await message(base, chat.id, "START:A START:B START:C START:D");
      await turnFinished(waitForLog, chat.id, 1);
      started(await result(waitForLog, chat.id, "START:D"));
      for (const x of ["A", "B", "C", "D"]) await gate.reached(`sub${x}`);

      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ ultracode: false }) });
      await message(base, chat.id, "START:E");
      await turnFinished(waitForLog, chat.id, 2);
      denied(await result(waitForLog, chat.id, "START:E"), 3);
    } finally {
      for (const t of ["subA", "subB", "subC", "subD"]) gate.open(t);
    }
    await waitForIdle();
  }, { claude: fake }));
});

// ── Loop engine: cbase_agent counts too ───────────────────────────────────────────────────────────────────────────────
const isSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));
const toolMessages = (b) => (b.messages || []).filter((m) => m.role === "tool");
const content = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

let engineGateOn;
const engineGate = new Promise((r) => { engineGateOn = r; });
let subsArrived = 0;
const engineRound = async (b) => {
  if (isSub(b)) {
    subsArrived += 1;
    await engineGate;
    return { text: "SUB-REPORT" };
  }
  const n = toolMessages(b).length;
  if (n === 0) return { toolCalls: [{ id: "call_agent_a", name: "mcp__cbase__cbase_agent", arguments: { description: "Agent A", prompt: "Look at A.", run_in_background: true } }] };
  if (n === 1) return { toolCalls: [{ id: "call_agent_b", name: "mcp__cbase__cbase_agent", arguments: { description: "Agent B", prompt: "Look at B.", run_in_background: true } }] };
  if (n === 2) return { toolCalls: [{ id: "call_agent_c", name: "mcp__cbase__cbase_agent", arguments: { description: "Agent C", prompt: "Look at C.", run_in_background: true } }] };
  return { text: "finished" };
};

test("Loop engine: its cbase_agent starts count against the chat cap — the start above the cap fails", async () => {
  await withSlider(2, () => withAgentsServer(async ({ base, ws, engine, waitForTruthy, waitForIdle }) => {
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Cap engine" }) });
    try {
      await message(base, c.id, "Three subagents please");
      const fourth = await waitForTruthy(() => engine.requests.find((b) => !isSub(b) && toolMessages(b).length === 3), "third start answered");
      const [a, bAgent, cAgent] = toolMessages(fourth).map(content);
      assert.doesNotMatch(a, /Cap reached/, a);
      assert.doesNotMatch(bAgent, /Cap reached/, bAgent);
      assert.match(cAgent, /Cap reached/, cAgent);
      assert.match(cAgent, /do not repeat/i, cAgent);
      assert.match(cAgent, /the boundary is 2 per chat/, cAgent);
      const list = await json(`${base}/api/chats/${c.id}/agents`);
      assert.equal(list.agents.filter((x) => x.status === "running").length, 2, JSON.stringify(list.agents));
      await waitForTruthy(() => subsArrived === 2, "two subagents at the gate");
    } finally {
      engineGateOn();
    }
    await waitForIdle();
  }, { engine: { round: engineRound } }));
});
