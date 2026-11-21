// A scheduled occurrence that delegates. The main agent never waits for a subagent (providers/agent-wait.js): its occurrence turn
// ends with an interim text and the report arrives as its own turn (occasion "agent"). Main seam: real server, real routes, real
// cbase MCP server, fake Claude from the agent harness; the subagent waits at gate "sub" until the test opens it. No time window.
//
// The promises, each with the sabotage that breaks it:
//   (1) The run stays `open` after the occurrence turn ended while the subagent lives, and closes `ok` with the answer that processed
//       the report, not with the interim text.
//   (2) If the human stops the subagent, the run still closes (the work end arrives without a report) and does not stay open.
//   COUNTER-TEST: scheduledEndHook without the switch `backgroundWork(chat.id).length` => (1) and (2) red: the run is already
//   closed after the occurrence turn, with "Delegated" as the teaser.
//
// The gate sets CBASE_MAIN_AGENT_WAIT_MS (the other agent tests fetch the report in the call). This file measures the product
// and removes the knob from its environment before a server starts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { startRun } from "../electron/server/scheduled/run.js";
import { nextOccurrence, cadenceOff } from "../electron/server/scheduled/cadence.js";

delete process.env.CBASE_MAIN_AGENT_WAIT_MS;

// The occurrence starts a subagent and ends with "Delegated"; it answers the completion notice with "Result: <report>".
const fake = fakeClaude({
  main: `
  if (text.startsWith("<task-notification>")) {
    const r = (/<result>([\\s\\S]*?)<\\/result>/.exec(text) || [])[1] || "no report";
    say({ type: "assistant", message: { id: "main-m" + turn, content: [{ type: "text", text: "Result: " + r }] } });
    finished();
    say({ type: "result", result: "Result: " + r, session_id: "main-session" });
    return;
  }
  const args = { description: "Look into it", prompt: "Take a look.", run_in_background: false };
  say({ type: "assistant", message: { id: "main-1-" + turn, content: [{ type: "tool_use", id: "toolu_g" + turn, name: "mcp__cbase__cbase_agent", input: args }] } });
  let t = "";
  try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_g" + turn, content: t }] } });
  say({ type: "assistant", message: { id: "main-2-" + turn, content: [{ type: "text", text: "Delegated" }] } });
  finished();
  say({ type: "result", result: "Delegated", session_id: "main-session" });`,
  sub: `
    await gate("sub");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`,
});

// A job on the test chat, created directly through the store.
function jobAt(chat) {
  const r = cadenceOff("daily", { clockTime: "22:00" }, { timeZone: "Europe/Berlin" });
  assert.ok(r.ok, JSON.stringify(r));
  const now = Date.now();
  const raw = { id: crypto.randomUUID(), workspaceId: chat.workspaceId, instructions: "Check the status.", cadence: "daily", plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone: "Europe/Berlin", createdAt: now };
  store.createScheduledJob({ ...raw, nextAt: nextOccurrence({ ...raw }, now) });
  store.updateChat(chat.id, { jobId: raw.id, title: "Status", titled: 1 });
  return store.getScheduledJob(raw.id);
}
const run = (id) => store.getScheduledRun(id);
const liveIn = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId);
// The occurrence turn is over: "Delegated" is in the log and no turn runs any more (the run hook sits BEFORE the broadcast).
const occurrenceTurnPast = (base, chat, waitForLog) => waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Delegated"))
  .then(() => waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0 || null, "occurrence turn past"));

test("(1) the occurrence delegates: the run stays open while the subagent lives and closes `ok` with the processed answer", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForLog }) => {
    const a = jobAt(chat);
    try {
      const l = startRun(a, "hand").run;
      await gate.reached("sub");
      await occurrenceTurnPast(base, chat, waitForLog);
      assert.equal((await liveIn(base, chat.id)).length, 1, "the subagent lives after the occurrence turn");
      assert.equal(run(l.id).status, "open", `the run closed with the interim text: ${JSON.stringify(run(l.id))}`);

      gate.open("sub");
      await waitForLog(chat.id, (lg) => lg.some((m) => m.role === "assistant" && m.text === "Result: Finding 42"));
      const finished = await waitForTruthy(() => (run(l.id).status !== "open" ? run(l.id) : null), "run closed");
      assert.equal(finished.status, "ok", JSON.stringify(finished));
      assert.match(finished.short, /Finding 42/, "the teaser is the answer to the report");
      assert.equal(store.getScheduledJob(a.id).lastStatus, "ok");
    } finally { gate.open("sub"); }
  }, { claude: fake });
});

test("(2) the human stops the subagent: the run closes anyway and does not stay open", async () => {
  await withAgentsServer(async ({ base, chat, gate, waitForLog }) => {
    const a = jobAt(chat);
    try {
      const l = startRun(a, "hand").run;
      await gate.reached("sub");
      await occurrenceTurnPast(base, chat, waitForLog);
      const [agent] = await liveIn(base, chat.id);
      assert.ok(agent, "a subagent lives");
      assert.equal(run(l.id).status, "open");

      const r = await json(`${base}/api/chats/${chat.id}/agent/stop`, { method: "POST", body: JSON.stringify({ from: "human", agentId: agent.agentId }) });
      assert.ok(r.ok, JSON.stringify(r));
      const finished = await waitForTruthy(() => (run(l.id).status !== "open" ? run(l.id) : null), "run closed");
      assert.equal(finished.status, "ok", JSON.stringify(finished));
    } finally { gate.open("sub"); }
  }, { claude: fake });
});
