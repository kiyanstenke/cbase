// Stop per agent without a turn and "Stop all background agents".
//
// The stop routes used to ask the RUNNING turn and answered 409 without one — once agents survive the turn there would be no
// way to halt an agent that runs on. So this is measured in the state that survival brings: a TEST run kind (only for the
// chats of this test) answers "do not hold", and the fake agent stands behind its gate file while the turn is already over.
//
// Counter-proofs (which sabotage turns which test red):
//   - route as before (`!running.has(id)` => 409) => test 1 red (409 instead of 200);
//   - notice not stored => test 1 red (the next turn carries nothing);
//   - notice also on a stop by the agent => test 3 red;
//   - the notice only WITHOUT a turn (the condition before the follow-up, `withoutTurn`) => "stop DURING a turn" red: the
//     next turn carries nothing, the main agent never learns of the stop.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { runKindDefault, registerRunKind } from "../electron/server/runs/hooks.js";

// The main agent: "START [X]" starts a background agent with the marker X and ends its turn; "STOP <id>" stops it via
// cbase_agent_stop; everything else it mirrors — so the history shows what the INPUT of the turn carried.
// The subagent waits at gate "sub<X>" and lives there until a stop ends it.
const fake = fakeClaude({
  sub: `
    const m = /\\[([A-Z])\\]/.exec(text);
    await gate("sub" + (m ? m[1] : "A"));
    finished();
    say({ type: "result", result: "sub", session_id: "sub-session" });`,
  main: `
  const start = /START \\[([A-Z])\\]/.exec(text);
  const stop = /STOP (\\S+)/.exec(text);
  if (start) {
    const args = { description: "On the side " + start[1], prompt: "Take a look [" + start[1] + "].", run_in_background: true };
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    if (text.includes("AND WAIT")) await gate("main"); // the turn runs on while the agent lives
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: t.startsWith("ERROR") ? t.slice(0, 200) : "Agent running" }] } });
  } else if (stop) {
    const args = { agentId: stop[1] };
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_stop", name: "mcp__cbase__cbase_agent_stop", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent_stop", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_stop", content: t }] } });
    say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "STOP-RESPONSE " + t }] } });
  } else {
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "text", text: "ECHO " + text }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

// Only THIS chat does not hold — the agent survives its turn. Registered after the server start (registry empty).
const withoutHold = (chatId) =>
  registerRunKind(`test-without-hold-${chatId}`, (c) => ({ ...runKindDefault(c), hold: false }), { detects: (c) => c.id === chatId });

// Raw POST — the 400/409 are the point here, not an error of the helper.
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// Start a background agent and wait until the turn is over and the agent stands at the gate.
async function agentWithoutTurn({ base, gate, waitForTruthy }, chatId, marker) {
  await json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text: `START [${marker}]` }) });
  await gate.reached(`sub${marker}`);
  return waitForTruthy(async () => {
    const r = await json(`${base}/api/runs/active`);
    const a = r.agents.find((x) => x.chatId === chatId);
    return a && r.runs === 0 ? a : null;
  }, `agent ${marker} lives, turn over`);
}

const outputFile = (dataRoot, agentId) => {
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) run(p);
      else if (e.name === `${agentId}.output`) hits.push(p);
    }
  };
  run(dataRoot);
  return hits[0] || "";
};

// The echo answers of the main agent — one per turn without a tool, in order.
const echos = (log) => log.filter((m) => m.role === "assistant" && m.text.startsWith("ECHO ")).map((m) => m.text);

test("stop per agent without a turn: 200, report \"stopped by the human\", no turn — the next turn carries the notice exactly once", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, dataRoot, waitForLog, waitForIdle } = ctx;
    withoutHold(chat.id);
    const agent = await agentWithoutTurn(ctx, chat.id, "A");
    const prior = (await json(`${base}/api/chats/${chat.id}/log`)).length;

    const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: agent.agentId, from: "human" });
    assert.equal(r.status, 200, `stop without a turn: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.agentId, agent.agentId);

    // No turn, nothing queued, the chat stays idle — and the agent is gone.
    const after = await json(`${base}/api/runs/active`);
    assert.equal(after.runs, 0, JSON.stringify(after));
    assert.equal(after.busy, false, `after the stop nothing is open any more: ${JSON.stringify(after)}`);
    assert.deepEqual(after.agents, []);
    // Only the addendum at ITS call block goes into the history (also without a turn, otherwise "running" would stand there
    // forever) — no user line, no answer line.
    const fresh = (await json(`${base}/api/chats/${chat.id}/log`)).slice(prior);
    assert.deepEqual(fresh.map((m) => m.role), ["tool_result"], `the stop writes only the addendum: ${JSON.stringify(fresh).slice(0, 400)}`);
    assert.match(JSON.parse(fresh[0].text).result, /Stopped by the human/);
    const file = outputFile(dataRoot, agent.agentId);
    assert.ok(file, "the agent's output file exists");
    assert.match(fs.readFileSync(file, "utf8"), /## Report\nStopped by the human\. No result\./);

    // The next turn carries the notice — with id and name —, the one after it no longer.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go on" }) });
    let log = await waitForLog(chat.id, (l) => echos(l).length === 1);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "And on" }) });
    log = await waitForLog(chat.id, (l) => echos(l).length === 2);
    const [first, second] = echos(log);
    const n = (first.match(/stopped by the human/g) || []).length;
    assert.equal(n, 1, `the next turn carries the notice exactly once: ${first}`);
    assert.ok(first.includes(agent.agentId), `with agentId: ${first}`);
    assert.ok(agent.name && first.includes(agent.name), `with name (${agent.name}): ${first}`);
    assert.ok(first.endsWith("Go on"), "the typed input stands behind the notice");
    assert.equal(second, "ECHO And on", "consumed — the turn after next carries nothing any more");
    // No wake-up turn in between: exactly the three user lines, no further one.
    assert.deepEqual(log.filter((m) => m.role === "user").map((m) => m.text), ["START [A]", "Go on", "And on"]);
    await waitForIdle();
  }, { claude: fake });
});

// A background agent in a turn that does NOT hold (the coding chat): its call returned long ago with "running", and for a
// stopped agent the owner delivers no completion notice. So the main agent learns of the stop only through the silent
// notice — even if the turn that started it still runs (before the follow-up, stopInCore stored it only WITHOUT a turn and
// assumed the running turn would deliver the report).
test("stop per agent DURING a turn that does not hold: no wake-up turn — the next turn carries the notice exactly once", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate, waitForTruthy, waitForLog, waitForIdle } = ctx;
    withoutHold(chat.id);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "START [A] AND WAIT" }) });
    await gate.reached("subA");
    await gate.reached("main");
    const agent = await waitForTruthy(async () => {
      const r = await json(`${base}/api/runs/active`);
      const a = r.agents.find((x) => x.chatId === chat.id);
      return a && r.runs === 1 ? a : null;
    }, "agent lives, turn runs");
    const r = await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: agent.agentId, from: "human" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    gate.open("main");
    await waitForIdle();
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go on" }) });
    const log = await waitForLog(chat.id, (l) => echos(l).length === 1);
    const [first] = echos(log);
    assert.equal((first.match(/stopped by the human/g) || []).length, 1, `the next turn carries the notice exactly once: ${first}`);
    assert.ok(first.includes(agent.agentId), `with agentId: ${first}`);
    assert.deepEqual(log.filter((m) => m.role === "user").map((m) => m.text), ["START [A] AND WAIT", "Go on"], "no wake-up turn in between");
    await waitForIdle();
  }, { claude: fake });
});

test("both stop routes require the originator — 400 without it or with a foreign value", async () => {
  await withAgentsServer(async ({ base, chat }) => {
    for (const [filePath, body] of [
      ["agent/stop", { agentId: "x" }],
      ["agent/stop", { agentId: "x", from: "system" }],
      ["agents/stop", {}],
      ["agents/stop", { from: "" }],
    ]) {
      const r = await post(`${base}/api/chats/${chat.id}/${filePath}`, body);
      assert.equal(r.status, 400, `${filePath} ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /from/);
    }
    // Without an open core: a known originator, but no living agent — 409 or an empty list.
    assert.equal((await post(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: "x", from: "human" })).status, 409);
    assert.deepEqual((await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" })).body, { ok: true, stopped: [] });
  }, { claude: fake });
});

test("cbase_agent_stop sends the originator \"agent\": the stop from a later turn takes effect, and no notice is created", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, waitForLog, waitForIdle } = ctx;
    withoutHold(chat.id);
    const agent = await agentWithoutTurn(ctx, chat.id, "A");
    // The main agent stops in the NEXT turn — its core is a different one from the one in which the agent lives.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `STOP ${agent.agentId}` }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("STOP-RESPONSE ")));
    const response = log.find((m) => m.role === "assistant" && m.text.startsWith("STOP-RESPONSE ")).text;
    assert.match(response, /"ok":\s*true/, `the tool does not fail (originator sent): ${response}`);
    await waitForIdle();
    assert.deepEqual((await json(`${base}/api/runs/active`)).agents, []);

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go on" }) });
    const afterwards = await waitForLog(chat.id, (l) => echos(l).length === 1);
    assert.equal(echos(afterwards)[0], "ECHO Go on", "a stop by the agent stores no notice");
    await waitForIdle();
  }, { claude: fake });
});

test("\"Stop all background agents\" hits only THIS chat; afterwards busy is false", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, waitForIdle } = ctx;
    const b = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    withoutHold(chat.id);
    withoutHold(b.id);
    const agentA = await agentWithoutTurn(ctx, chat.id, "A");
    const agentB = await agentWithoutTurn(ctx, b.id, "B");

    const r = await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.stopped, [agentA.agentId]);
    const middle = await json(`${base}/api/runs/active`);
    assert.deepEqual(middle.agents.map((a) => [a.chatId, a.agentId]), [[b.id, agentB.agentId]], "the agent of the other chat lives on");
    assert.equal(middle.busy, true);

    const r2 = await post(`${base}/api/chats/${b.id}/agents/stop`, { from: "human" });
    assert.deepEqual(r2.body.stopped, [agentB.agentId]);
    const end = await json(`${base}/api/runs/active`);
    assert.equal(end.busy, false, JSON.stringify(end));
    assert.equal(end.runs, 0);
    await waitForIdle();
  }, { claude: fake });
});
