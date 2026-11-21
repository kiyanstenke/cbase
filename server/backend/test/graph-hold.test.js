// Graph chats hold.
//
// A graph step is finished only when none of its background agents runs any more and their reports are processed in the SAME turn;
// only then do completion check, review and the next node run, and the follow-up turn does not count as a new node visit. Against the
// default (a Coding chat does not hold) the switch answers "hold" (workflows/gates.js graphHoldSwitch, registered in server.js) as long
// as a graph workflow is open in the chat.
//
// Counter-tests (each shown red once):
//   - registration of the switch commented out in server.js => test 1 red (n2 starts before the agent ends), test 2 red (the review
//     question does not know the report), and the guard hookRegistry reports the asked-for, unregistered kind.
//   - graphHoldSwitch always answers `true` => test 4 red (the chat without a graph run holds).
//   - a follow-up turn counts as a visit (sabotage in do-run.js: every delivery of a report counts the node of the run up) => test 3 red.
// Wait only for events, no deadline: the agents stand behind gate files, SSE events and run states are waited for (agent-harness.mjs).
// This file imports no other test file.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { visitCount } from "../electron/server/workflows.js";
import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";

// The main agent: a node with "BACKGROUNDAGENT" in the job starts one or two background agents and ends its turn; a delivered report
// is answered with "Report processed: …"; every other turn answers "Step done". The subagents each stand at their gate (sub1, sub2).
// Oneshot calls (verdicts of the gates) write their prompt to verdicts.log and answer "done" or "yes".
const fake = fakeClaude({
  sub: `
    const nr = text.includes("Look 2") ? "2" : "1";
    await gate("sub" + nr);
    say({ type: "assistant", message: { id: "sub-" + nr, content: [{ type: "text", text: "Finding " + nr + " after the gate" }] } });
    finished();
    say({ type: "result", result: "Finding " + nr + " after the gate", session_id: "sub-session-" + nr });`,
  main: `
  let response = "Schritt done";
  if (text.includes("[Subagent finished")) {
    response = "Report processed: " + (text.match(/Finding \\d after the gate/g) || []).join(", ");
  } else if (text.includes("BACKGROUNDAGENT")) {
    const n = text.includes("TWO-AGENTS") ? 2 : 1;
    for (let i = 1; i <= n; i++) {
      say({ type: "assistant", message: { id: "main-start-" + i, content: [{ type: "tool_use", id: "toolu_bg" + i, name: "mcp__cbase__cbase_agent",
        input: { description: "On the side " + i, prompt: "Look " + i, run_in_background: true } }] } });
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent", { description: "On the side " + i, prompt: "Look " + i, run_in_background: true })); }
      catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg" + i, content: t }] } });
    }
    response = "Agents running";
  }
  say({ type: "assistant", message: { id: "main-" + turn, content: [{ type: "text", text: response }] } });
  finished();
  say({ type: "result", result: response, session_id: "main-session" });`,
  oneshot: `
    fs.appendFileSync(path.join(LOCATION, "verdicts.log"), JSON.stringify(prompt) + "\\n");
    respond('{"done": true, "yes": true, "note": "ok"}');`,
});

// Record the SSE frames of a chat (same build as in background-agent.test.js — not importable from there).
function recording(base, chatId) {
  const events = [];
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: controller.signal, headers: { Connection: "close" } });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* defective frame */ }
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, stop: async () => { controller.abort(); await done; } };
}

const toolResultWith = (evt, id, pattern) => evt.type === "user" && (evt.message?.content || []).some((b) =>
  b?.type === "tool_result" && b.tool_use_id === id && JSON.stringify(b.content || "").includes(pattern));
const assistantText = (evt, pattern) => evt.type === "assistant" && (evt.message?.content || []).some((b) => b?.type === "text" && String(b.text).includes(pattern));
const wfRow = (evt, p) => evt.type === "harness" && evt.subtype === "workflow_step" && p(evt.line || {});
// verdicts.log is written by the oneshot calls of the fake CLI (child processes) — only completed lines (jsonl.mjs).
const verdicts = (root) => readJsonl(path.join(root, "verdicts.log"));

async function createFlow(base, ws, name, graph) {
  return json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name, graph }) });
}
const start = (base, chatId, workflowId) =>
  json(`${base}/api/chats/${chatId}/workflow`, { method: "POST", body: JSON.stringify({ workflowId, input: "go" }) });
const untilRunClosed = (ctx, runId) => ctx.waitForTruthy(async () => {
  const d = await json(`${ctx.base}/api/workflow-runs/${runId}`);
  return ["done", "failed", "cancelled"].includes(d.run.status) ? d : null;
}, "run closed");

test("a graph step holds until the report of its agent is processed: agent finished -> notice processed -> gate -> n2; the judge reads the report", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate: gateState, root } = ctx;
    const flow = await createFlow(base, ws, "Hold", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "One", text: "N1-JOB: start a BACKGROUNDAGENT", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Two", text: "N2-JOB", x: 400, y: 0 },
        { id: "e0", type: "end", title: "End", x: 600, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "e0" }],
    });
    const stream = recording(base, chat.id);
    try {
      const r = await start(base, chat.id, flow.id);
      await gateState.reached("sub1");
      gateState.open("sub1");
      const d = await untilRunClosed(ctx, r.run.id);
      await ctx.waitForIdle();
      assert.equal(d.run.status, "done", `run ended as ${d.run.status}: ${d.run.note}`);
    } finally {
      await stream.stop();
    }
    const ev = stream.events;
    const agentFinished = ev.findIndex((e) => toolResultWith(e, "toolu_bg1", "Finding 1 after the gate"));
    const processed = ev.findIndex((e) => assistantText(e, "Report processed: Finding 1 after the gate"));
    const gate = ev.findIndex((e) => wfRow(e, (l) => l.kind === "gate" && l.done === true && l.title === "One"));
    const n2 = ev.findIndex((e) => wfRow(e, (l) => l.kind === "step" && l.title === "Two"));
    const situation = JSON.stringify({ agentFinished, processed, gate, n2 });
    assert.ok(agentFinished >= 0 && n2 >= 0, `agent end and n2 in the stream: ${situation}`);
    assert.ok(agentFinished < n2, `n2 started before the agent ended: ${situation}`);
    assert.ok(processed > agentFinished, `the notice was processed in the same step: ${situation}`);
    assert.ok(gate > processed, `the gate judges after the processed notice: ${situation}`);
    assert.ok(n2 > gate, `n2 comes after the gate: ${situation}`);

    // The judge of the completion gate of n1 reads the state AFTER the completion notice.
    const richterN1 = verdicts(root).filter((p) => p.includes("N1-JOB") && p.includes("work step is DONE"));
    assert.equal(richterN1.length, 1, `exactly one verdict on n1: ${richterN1.length}`);
    assert.match(richterN1[0], /Report processed: Finding 1 after the gate/);
  }, { claude: fake });
});

test("the review question of a graph step is the state after the completion notice", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate } = ctx;
    const flow = await createFlow(base, ws, "Review hold", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "r1", type: "review", title: "Check", text: "R1-JOB: start a BACKGROUNDAGENT", x: 200, y: 0 },
        { id: "e0", type: "end", title: "End", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "r1" }, { from: "r1", to: "e0", branch: "ok" }],
    });
    const r = await start(base, chat.id, flow.id);
    await gate.reached("sub1");
    gate.open("sub1");
    const d = await ctx.waitForTruthy(async () => {
      const x = await json(`${base}/api/workflow-runs/${r.run.id}`);
      return x.run.status !== "running" ? x : null;
    }, "review waits");
    assert.equal(d.run.status, "waiting", `the run waits at the review: ${d.run.status} ${d.run.note}`);
    assert.match(d.run.question, /Report processed: Finding 1 after the gate/, `review question: ${d.run.question}`);
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST", body: "{}" });
    await ctx.waitForIdle();
  }, { claude: fake });
});

test("the round cap counts the step once: two completion notices on a cycle with cap 1 do not stop at the cap", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate } = ctx;
    const flow = await createFlow(base, ws, "Cycle", {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "n1", type: "instruction", title: "One", text: "N1-JOB: start TWO-AGENTS (BACKGROUNDAGENT)", maxVisits: 1, x: 200, y: 0 },
        { id: "c1", type: "condition", title: "Done?", text: "Is the work done?", x: 400, y: 0 },
        { id: "e0", type: "end", title: "End", x: 600, y: 0 },
      ],
      edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "c1" }, { from: "c1", to: "e0", branch: "true" }, { from: "c1", to: "n1", branch: "false" }],
    });
    const r = await start(base, chat.id, flow.id);
    await gate.reached("sub1");
    await gate.reached("sub2");
    gate.open("sub1");
    gate.open("sub2");
    const d = await untilRunClosed(ctx, r.run.id);
    await ctx.waitForIdle();
    assert.equal(d.run.status, "done", `run ended as ${d.run.status}: ${d.run.note}`);
    assert.equal(d.steps.some((s) => s.kind === "cap"), false, `no stop at the cap: ${JSON.stringify(d.steps.map((s) => s.kind))}`);
    const cursor = store.getWorkflowRunById(r.run.id).cursor;
    assert.equal(visitCount(cursor, "n1"), 1, `n1 counts once: ${JSON.stringify(cursor.visits)}`);
    // Both reports arrived in the step (delivered singly or bundled).
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    const processed = log.filter((m) => m.role === "assistant" && m.text.startsWith("Report processed")).map((m) => m.text).join(" ");
    assert.match(processed, /Finding 1 after the gate/);
    assert.match(processed, /Finding 2 after the gate/);
  }, { claude: fake });
});

test("a Coding chat without an open graph run does not hold: the turn end comes before the end of the agent", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate } = ctx;
    const stream = recording(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Start a BACKGROUNDAGENT" }) });
      await gate.reached("sub1");
      // Either the turn ends (runs 0) or it goes into the waiting phase (run_waiting) — both observable without a clock.
      const situation = await ctx.waitForTruthy(async () => {
        const s = await json(`${base}/api/runs/active`);
        if (s.runs === 0) return { held: false };
        return stream.events.some((e) => e.type === "harness" && e.subtype === "run_waiting") ? { held: true } : null;
      }, "turn end or waiting phase");
      assert.equal(situation.held, false, "without an open graph run the switch must not hold");
      gate.open("sub1");
      await ctx.waitForIdle();
    } finally {
      gate.open("sub1");
      await stream.stop();
    }
  }, { claude: fake });
});
