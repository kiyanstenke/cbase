// Verdicts at turn end wait for background work.
//
// Compaction, goal gate and the "end" event used to run at the end of EVERY turn, because turn end was work end. If a
// background agent survives its turn they would judge half-finished work. Now do-run.js asks ONCE in the finally for the
// query of open background work (runs/background.js) and lets the goal gate and the "end" event run only at the end of the
// turn after which nothing is open any more; only the delivery of waiting channel messages stays at turn end (hook
// "turnEnd").
//
// THE REAL PATH: a coding chat does not hold its turn for its subagents — the fake agent stands behind its gate file while
// the turn is already over, and the FOLLOW-UP turn arrives by itself as the completion notice (`<task-notification>`).
//
// Waits for events (gate files, history, /api/runs/active), never for a duration.
//
// Counter-tests: `backgroundOpen` in do-run.js fixed to `false` => the verdict tests red (the judge rules at the first
// turn end without the report; "end" fires at the first turn end, hook_end carried the answer of turn one).
// COMPACTION does not wait (Claude Code does not ask its background tasks at the threshold; the first turn afterwards
// carries them as an attachment, runs/after-compaction.js) — the first test pins the opposite. Counter-test: the condition
// `!backgroundOpen` back into `autoCompact` => the first test red (no marker at the end of turn one).
// The third test drives a channel coding <-> coding and counts the firing of "end" itself (the outer loop still takes it
// off). Counter-test: `backgroundOpen` fixed to `false` => the third test red ("end" twice, the first at the end of turn one).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { observeHooks } from "../electron/server/runs/hooks.js";

// Main agent: depending on the message a background agent (optionally with its own gate), the answer to the completion
// notice ("Conclusion: <result>") or a plain answer. Every answer reports 150,000 input tokens (Haiku 4.5, 200k: 75 %).
// Log per turn: text and `--resume`.
// Subagent: stands at the gate "sub", then writes a marker and its finding.
// Oneshot calls (judge, summary): logged with the question whether the subagent was already done.
const fake = fakeClaude({
  sub: `
    await gate("sub");
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Finding after the gate" }] } });
    fs.writeFileSync(path.join(LOCATION, "sub-finished"), "1");
    finished();
    say({ type: "result", result: "Finding after the gate", session_id: "sub-session" });`,
  main: `
  fs.appendFileSync(path.join(LOCATION, "main.jsonl"), JSON.stringify({ text: text.slice(0, 6000), resume: arg("--resume") }) + "\\n");
  const usage = { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const response = (t) => {
    say({ type: "assistant", message: { id: "m-" + process.pid + "-" + turn, usage, content: [{ type: "text", text: t }] } });
    finished();
    say({ type: "result", result: t, session_id: "main-session" });
  };
  if (text.startsWith("<task-notification>")) {
    // The completion notice: the main agent answers with the result of its agent.
    const m = text.match(new RegExp("<result>([^<]*)</result>"));
    response("Conclusion: " + (m ? m[1].trim() : "no report"));
  } else if (text.includes("START-AGENT")) {
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent",
      input: { description: "Sidecar", prompt: "Take a look.", run_in_background: true } }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent", { description: "Sidecar", prompt: "Take a look.", run_in_background: true })); }
    catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    if (text.includes("WITH-GATE")) await gate("main");
    response(t.startsWith("ERROR") ? t.slice(0, 200) : "Turn one done");
  } else if (text.includes("ADDENDUM-TWO")) {
    response("Addendum read");
  } else {
    response("ok");
  }`,
  oneshot: `
    const target = prompt.includes("overarching target");
    fs.appendFileSync(path.join(LOCATION, "oneshots.jsonl"), JSON.stringify({ kind: target ? "target" : "otherwise", prompt, byAgent: fs.existsSync(path.join(LOCATION, "sub-finished")) }) + "\\n");
    respond(target ? JSON.stringify({ achieved: true, note: "reached" }) : "SUMMARY");`,
});

// The fake CLI (a child process) writes the logs while the test reads — only completed lines (jsonl.mjs).
const rows = readJsonl;
const compactMarkers = (log) => log.filter((r) => r.role === "meta").map((r) => { try { return JSON.parse(r.text); } catch { return {}; } }).filter((m) => m.compacted);

// The chat is idle and has answered turn one — the whole finally of turn one has run (it is synchronous: compaction,
// "end"/"turnEnd" and goal gate are started in the SAME tick in which `running` drops).
async function turnOnePast({ base, chat, waitForTruthy }) {
  await waitForTruthy(async () => {
    const r = await json(`${base}/api/runs/active`);
    if (r.runs !== 0) return null;
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    return log.some((z) => z.role === "assistant" && /Turn one done/.test(z.text)) ? r : null;
  }, "end of turn one");
}

// The agent is gone: nothing open any more.
async function agentGone({ base, gate, waitForTruthy }) {
  gate.open("sub");
  await waitForTruthy(async () => {
    const r = await json(`${base}/api/runs/active`);
    return r.agents.length === 0 ? r : null;
  }, "background agent done");
}

test("compaction does NOT wait (like Claude Code): above the threshold with a living agent the chat compacts at turn end — the next turn starts fresh, with the summary and the agent's status", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForTruthy, waitForIdle } = ctx;
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ autocompact: 50 }) });

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "START-AGENT" }) });
    await gate.reached("sub");
    await turnOnePast(ctx);
    // Compaction is started in the same tick in which the run dropped — wait until nothing but the agent is open.
    const still = async () => {
      const { open } = await json(`${base}/api/runs/active`);
      return open.runs === 0 && open.compaction === 0 && open.oneshots === 0 && open.queue === 0 ? open : null;
    };
    await waitForTruthy(still, "compaction at the end of turn one");
    const markers = () => json(`${base}/api/chats/${chat.id}/log`).then(compactMarkers);
    assert.equal((await markers()).length, 1, "compacted although the agent is still alive (counter-test: with `!backgroundOpen` no marker)");
    assert.equal((await json(`${base}/api/runs/active`)).agents.length, 1, "the agent lives on");
    assert.equal(rows(path.join(root, "oneshots.jsonl")).filter((o) => o.kind === "otherwise").some((o) => o.byAgent), false,
      "the summary arose while the agent was running");

    // A human turn while the agent runs: fresh (no --resume), the continuation message in front, plus the status.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Interim question" }) });
    await waitForTruthy(async () => (rows(path.join(root, "main.jsonl")).some((t) => t.text.endsWith("Interim question")) ? still() : null), "interim question beantwortet");
    const zf = rows(path.join(root, "main.jsonl")).find((t) => t.text.endsWith("Interim question"));
    assert.equal(zf.resume, "", "after compaction the session starts fresh");
    assert.ok(zf.text.startsWith("This session continues an earlier conversation"), zf.text.slice(0, 200));
    assert.match(zf.text, /<cbase-after-compaction>[\s\S]*Background agent "Sidecar" \([^)]+\) is still running\. Do not start a second one for the same job;/, "the status of the running agent (task_status)");

    await agentGone(ctx);
    await waitForIdle();
    const turns = rows(path.join(root, "main.jsonl"));
    const notice = turns.find((t) => t.text.includes("<task-notification>"));
    assert.ok(notice, JSON.stringify(turns));
    assert.doesNotMatch(notice.text, /Background agent "Sidecar"/, "the finished agent no longer shows as running");
  }, { claude: fake });
});

test("goal gate waits: the judge is called only when nothing is open any more — and its prompt carries the report", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForTruthy, waitForIdle } = ctx;
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Deliver the agent's finding" }) });

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "START-AGENT" }) });
    await gate.reached("sub");
    await turnOnePast(ctx);

    await agentGone(ctx);
    await waitForTruthy(async () => ((await json(`${base}/api/chats/${chat.id}`)).goal || "") === "" || null, "verdict of the judge");
    await waitForIdle();

    const verdicts = rows(path.join(root, "oneshots.jsonl")).filter((o) => o.kind === "target");
    assert.equal(verdicts.length, 1, `exactly one verdict: ${JSON.stringify(verdicts.map((u) => u.prompt.slice(-200)))}`);
    assert.equal(verdicts[0].byAgent, true, "called only when the agent was done");
    assert.match(verdicts[0].prompt, /Conclusion: Finding after the gate/, "the prompt carries the agent's report");
  }, { claude: fake });
});

test("channel: \"end\" fires exactly once, at the turn after the last agent — delivery to the chat stays at turn end (channel coding <-> coding)", async () => {
  const fired = [];
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root, gate, waitForTruthy, waitForIdle } = ctx;
    // The FIRING is counted, not the receiver: the observer hears once per registered hook (`index`), and the outer loop
    // takes "end" and "turnEnd" too — one firing would otherwise appear twice in the list.
    observeHooks((info, payload) => {
      if ((info.kind === "end" || info.kind === "turnEnd") && info.phase === "start" && info.index === 0 && payload?.chat?.id === chat.id) fired.push(info.kind);
    });
    // The sender: a second coding chat. It is never woken — the channel delivers only to the other participants.
    const sender = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, title: "Job" }) });
    const channel = await json(`${base}/api/workspaces/${ws.id}/channels`, {
      method: "POST", body: JSON.stringify({ name: "Background", participants: [sender.id, chat.id], creatorChatId: sender.id, cap: 0 }),
    });
    const state = () => json(`${base}/api/channels/${channel.id}`);
    const cursor = async () => (await state()).participants.find((t) => t.chatId === chat.id).cursor;
    const send = (text) => json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", body: JSON.stringify({ chatId: sender.id, text }) });
    const endCount = () => fired.filter((a) => a === "end").length;

    // Turn one is a channel delivery: it starts the agent and stands at its gate.
    await send("START-AGENT WITH-GATE");
    await gate.reached("sub");
    await gate.reached("main");
    // A second message while the delivery runs: it waits for the turn end.
    const two = await send("ADDENDUM-TWO");
    assert.ok(await cursor() < two.seq, "the second message waits while turn one runs");

    gate.open("main");
    await turnOnePast(ctx);
    // Delivery at turn end although the agent lives: the cursor advances in the same tick in which `running` drops.
    assert.ok(await cursor() >= two.seq, "the waiting channel message went to the chat at turn end");
    assert.equal(endCount(), 0, "no \"end\" while the agent lives");
    await waitForTruthy(async () => {
      const log = await json(`${base}/api/chats/${chat.id}/log`);
      if (!log.some((z) => z.role === "assistant" && /Addendum read/.test(z.text))) return null;
      return (await json(`${base}/api/runs/active`)).runs === 0 || null;
    }, "the delivery turn");
    assert.equal((await json(`${base}/api/runs/active`)).agents.length, 1, "the delivery turn ran next to the living agent");
    assert.equal(endCount(), 0, "not after the delivery turn either");

    await agentGone(ctx);
    await waitForTruthy(async () => endCount() > 0 || null, "\"end\" after the last agent");
    await waitForIdle();

    assert.deepEqual(fired.filter((a) => a === "end"), ["end"], `"end" exactly once: ${JSON.stringify(fired)}`);
    assert.ok(fired.indexOf("end") === fired.length - 1 && fired.includes("turnEnd"), JSON.stringify(fired));
    // No wake turn for the sender: its history stays without an answer.
    const senderLog = await json(`${base}/api/chats/${sender.id}/log`);
    assert.deepEqual(senderLog.filter((z) => z.role === "assistant"), [], "the sender was woken");
  }, { claude: fake }).finally(() => observeHooks(null));
});
