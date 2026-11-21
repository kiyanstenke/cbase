// Opt-in in the graph, and a step also holds for dynamic workflows. Main seam with the harness: real server, real cbase MCP server,
// real routes, real graph driver and real agent core; only the providers are faked.
//
//   - Ultracode in the run settings of a graph run opens each of its steps (via the chat).
//   - "ultracode" in the node text opens EXACTLY this step — the same recognizer as for human input.
//   - Without opt-in the step holds at the approval card like at an open question (workflows/gates.js): no advancing, no verdict, the
//     channel waits, a notification goes out (kind "question").
//   - For the second kind the turn of a step holds as long as ITS workflow runs (runs/do-run.js holdMs via the ONE query
//     runs/background.js); the completion notice arrives in the same step, only then gate and next node.
//
// Counter-tests (each shown red once):
//   - `if (s.ultracode) …` struck from workflows.js chatFieldsFromRun (the run setting is not read) => test 1 red (the card appears:
//     "awaiting_approval");
//   - the dynworkflow row struck from runs/do-run.js holdMs => test 1 and test 4 red (n2 starts while the workflow still stands at the
//     gate);
//   - the card check struck from workflows/gates.js gateAfterRunWithoutClaim => test 2 and test 3 red (the node advances instead of
//     waiting at the card);
//   - `nodeOpens` struck from dynworkflows/approval.js => test 2 red (step A holds at the card).
// Wait only for events, no deadline: agents stand behind gate files, SSE events, run states and files are waited for. This file
// imports no other test file.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import * as store from "../electron/server/store.js";
import { pendingOf, visitCount } from "../electron/server/workflows.js";
import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";

// The workflow scripts, each marked in the node text "START-WF:<tag>". `{GATE:x}` holds the workflow agent at gate x.
const script = (tag, gate = "") => `export const meta = { name: 'wf-${tag}', description: 'Graph step ${tag}', phases: [{ title: 'Read' }] }\nreturn await agent('x {TAG:${tag}}${gate ? ` {GATE:${gate}}` : ""}');\n`;
const SCRIPTS = { a: script("a", "wfa"), b1: script("b1"), b2: script("b2"), b3: script("b3"), c: script("c"), d: script("d", "wfd") };

// The main agent: a completion notice (<task-notification>) it answers with "Notice processed: <findings>", the report of a
// subagent with "Report processed: …". Otherwise: "START-AGENT" starts a background agent (at gate "sub"), "START-WF:<tag>" calls
// cbase_dynamic_workflow with SCRIPTS[tag] and files the tool result under wf-<tag>. Oneshot calls (verdicts of the gates) write their
// prompt to verdicts.log and answer "done".
const MAIN = `
  // Several causes in ONE input (a notice arriving together with the job of the next node) are all served — otherwise the fake
  // would swallow a job, and a failure would turn into a hang.
  const parts = [];
  const findings = (text.match(/Finding \\w+/g) || []).join(", ");
  if (text.includes("<task-notification>") && text.includes("wf-")) parts.push("Notice processed: " + findings);
  if (text.includes("[Subagent finished")) parts.push("Report processed: " + findings);
  {
    if (text.includes("START-AGENT")) {
      say({ type: "assistant", message: { id: "ag-" + turn, content: [{ type: "tool_use", id: "toolu_bg", name: "mcp__cbase__cbase_agent",
        input: { description: "On the side", prompt: "Look {TAG:sub} {GATE:sub}", run_in_background: true } }] } });
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent", { description: "On the side", prompt: "Look {TAG:sub} {GATE:sub}", run_in_background: true })); }
      catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: t }] } });
    }
    const m = text.match(/START-WF:(\\w+)/);
    if (m) {
      const tag = m[1];
      const args = { script: ${JSON.stringify(SCRIPTS)}[tag] };
      const id = "toolu_wf_" + tag;
      say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
      let t = "";
      try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for existence
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
      parts.push("Workflow triggered");
    }
  }
  const response = parts.join(" | ") || "Step done";
  say({ type: "assistant", message: { id: "main-" + turn, content: [{ type: "text", text: response }] } });
  finished();
  say({ type: "result", result: response, session_id: "main-session" });`;
// Subagent and workflow agent: marker {TAG:x}, {GATE:x} holds at the gate; report "Finding <tag>".
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const ONESHOT = `
    fs.appendFileSync(path.join(LOCATION, "verdicts.log"), JSON.stringify(prompt) + "\\n");
    respond('{"done": true, "yes": true, "note": "ok"}');`;
const claude = fakeClaude({ main: MAIN, sub: SUB, oneshot: ONESHOT });

// Record the SSE frames of a chat (same build as in graph-hold.test.js — not importable from there).
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

const assistantText = (evt, pattern) => evt.type === "assistant" && (evt.message?.content || []).some((b) => b?.type === "text" && String(b.text).includes(pattern));
const wfRow = (evt, p) => evt.type === "harness" && evt.subtype === "workflow_step" && p(evt.line || {});
const step = (title) => (e) => wfRow(e, (l) => l.kind === "step" && l.title === title);
const waiting = (e) => e.type === "harness" && e.subtype === "run_waiting";
// verdicts.log is written by the oneshot calls of the fake CLI (child processes) — only completed lines (jsonl.mjs).
const verdicts = (root) => readJsonl(path.join(root, "verdicts.log"));
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
// Creating takes only name and graph; the run settings are set by saving (PUT, like the editor).
async function createFlow(base, ws, name, graph, run) {
  const flow = await post(`${base}/api/workspaces/${ws.id}/workflows`, { name, graph });
  if (!run) return flow;
  return json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run }) });
}
const start = (base, chatId, workflowId) => post(`${base}/api/chats/${chatId}/workflow`, { workflowId, input: "go" });
const runOf = async (base, runId) => json(`${base}/api/workflow-runs/${runId}`);
const untilRunClosed = (ctx, runId) => waitForTruthy(async () => {
  const d = await runOf(ctx.base, runId);
  return ["done", "failed", "cancelled"].includes(d.run.status) ? d : null;
}, "run closed");
// Until the run is no longer "running" (waits OR has ended) — both are an event, the test judges afterwards.
const untilNotRunning = (ctx, runId) => waitForTruthy(async () => {
  const d = await runOf(ctx.base, runId);
  return d.run.status !== "running" ? d : null;
}, "run stands");
const toolResult = async (root, tag) => {
  const file = path.join(root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
};
const chain = (...node) => {
  const nodes = [{ id: "s0", type: "start", title: "Start", x: 0, y: 0 }];
  const edges = [];
  let prior = "s0";
  node.forEach(([id, title, text], i) => {
    nodes.push({ id, type: "instruction", title, text, x: 200 * (i + 1), y: 0 });
    edges.push({ from: prior, to: id });
    prior = id;
  });
  nodes.push({ id: "e0", type: "end", title: "End", x: 200 * (node.length + 1), y: 0 });
  edges.push({ from: prior, to: "e0" });
  return { nodes, edges };
};
const ULTRACODE_RUN = { ultracode: true, model: "claude-opus-5-5" };

test("ultracode in the run settings: the step starts without a card, and n2 starts only after the completion notice processed in the same step", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate: gateState, root } = ctx;
    const flow = await createFlow(base, ws, "Ultracode run", chain(["n1", "One", "N1-JOB START-WF:a"], ["n2", "Two", "N2-JOB"]), ULTRACODE_RUN);
    const stream = recording(base, chat.id);
    let runId = "";
    try {
      const r = await start(base, chat.id, flow.id);
      runId = r.run.id;
      const result = await toolResult(root, "a");
      assert.equal(result.status, "started", `started without a card: ${JSON.stringify(result)}`);
      assert.equal(!!store.getChat(chat.id).ultracode, true, "the chat carries the mode from the run settings");
      assert.equal(store.listMessages(chat.id).some((m) => m.role === "workflow_approval"), false, "no approval card");
      await gateState.reached("wfa");
      // The turn of the step holds (waiting phase) — OR the node advances: both are an event, judged afterwards.
      await waitForTruthy(() => stream.events.some(waiting) || stream.events.some(step("Two")), "step holds or advances");
      assert.equal(stream.events.some(step("Two")), false, "n2 started while the workflow of the step was still running");
      gateState.open("wfa");
      const d = await untilRunClosed(ctx, r.run.id);
      await ctx.waitForIdle();
      assert.equal(d.run.status, "done", `run ended as ${d.run.status}: ${d.run.note}`);
    } finally {
      gateState.open("wfa"); // also after a failure: otherwise the workflow agent would still stand at the gate during cleanup
      await stream.stop();
    }
    const ev = stream.events;
    const processed = ev.findIndex((e) => assistantText(e, "Notice processed: Finding a"));
    const gate = ev.findIndex((e) => wfRow(e, (l) => l.kind === "gate" && l.done === true && l.title === "One"));
    const n2 = ev.findIndex(step("Two"));
    const situation = JSON.stringify({ processed, gate, n2 });
    assert.ok(processed >= 0 && n2 >= 0, `notice and n2 in the stream: ${situation}`);
    assert.ok(gate > processed, `the gate judges after the processed completion notice: ${situation}`);
    assert.ok(n2 > gate, `n2 comes after the gate: ${situation}`);
    const richterN1 = verdicts(root).filter((p) => p.includes("N1-JOB"));
    assert.equal(richterN1.length, 1, `exactly one verdict on n1: ${richterN1.length}`);
    assert.match(richterN1[0], /Notice processed: Finding a/, "the judge reads the state after the completion notice");
    const run = store.getWorkflowRunById(runId);
    assert.equal(visitCount(run.cursor, "n1"), 1, `the completion notice is no node visit: ${JSON.stringify(run.cursor.visits)}`);
  }, { claude });
});

test("\"ultracode\" in the node text opens exactly this step; a step without, with \"ultracode\" in quotes or /ultracode holds at the card", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    const flow = await createFlow(base, ws, "Node text", chain(
      ["a", "A", "A-JOB with ultracode START-WF:b1"],
      ["b", "B", 'B-JOB "ultracode" START-WF:b2'],
      ["c", "C", "C-JOB /ultracode START-WF:b3"],
    ));
    const r = await start(base, chat.id, flow.id);
    assert.equal((await toolResult(root, "b1")).status, "started", "the keyword in the node text opens step A");
    for (const [tag, node] of [["b2", "b"], ["b3", "c"]]) {
      // Wait for the hold first, then read: if the run advances past a step, that is an event (red), not a hang.
      const d = await untilNotRunning(ctx, r.run.id);
      assert.equal(d.run.status, "waiting", `step ${node} holds at the card: ${d.run.status} ${d.run.note}`);
      const pending = pendingOf(store.getWorkflowRunById(r.run.id).cursor);
      assert.equal(pending?.node, node, `the run holds at step ${node}: ${JSON.stringify(pending)}`);
      const result = await toolResult(root, tag);
      assert.equal(result.status, "awaiting_approval", `step ${node}: ${JSON.stringify(result)}`);
      assert.deepEqual({ kind: pending?.kind, node: pending?.node, requestId: pending?.requestId }, { kind: "dyn_approval", node, requestId: result.requestId });
      // Reject: the step carries on like after an answered question (the notice is its follow-up turn).
      await post(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: result.requestId, decision: "reject" });
    }
    const d = await untilRunClosed(ctx, r.run.id);
    await ctx.waitForIdle();
    assert.equal(d.run.status, "done", `run ended as ${d.run.status}: ${d.run.note}`);
    assert.equal(store.dynRunsOpen(chat.id).length, 0);
    assert.equal(store.listMessages(chat.id).filter((m) => m.role === "workflow_approval").length, 2, "exactly two cards: B and C");
  }, { claude });
});

test("without opt-in the step holds at the card like at a question: no advancing, no verdict, channel held, notification at the outlet — after accepting it carries on", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    const other = await post(`${base}/api/chats`, { workspaceId: ws.id, title: "Counterpart" });
    const channel = await post(`${base}/api/workspaces/${ws.id}/channels`, { name: "Graph channel", participants: [chat.id, other.id] });
    const flow = await createFlow(base, ws, "Card", chain(["n1", "One", "N1-JOB START-WF:c"], ["n2", "Two", "N2-JOB"]));
    const r = await start(base, chat.id, flow.id);
    const result = await toolResult(root, "c");
    assert.equal(result.status, "awaiting_approval", JSON.stringify(result));
    const d = await untilNotRunning(ctx, r.run.id);
    assert.equal(d.run.status, "waiting", `the step holds at the card: ${d.run.status} ${d.run.note}`);
    await ctx.waitForIdle();
    assert.equal(d.steps.some((s) => s.kind === "step" && s.nodeId === "n2"), false, "n2 has not started");
    assert.equal(verdicts(root).some((p) => p.includes("N1-JOB")), false, "the completion check does not judge");
    // The channel waits: the message stays put, the cursor does not move, no turn.
    const beforeChannel = store.listMessages(chat.id).length;
    await post(`${base}/api/channels/${channel.id}/messages`, { chatId: other.id, text: "CHANNEL-MESSAGE to the step" });
    // Quiet first, then the look: a delivery that did run would be through by then — the cursor would have moved on and the history
    // would carry its turn. A look right after the POST would not see a later delivery.
    assert.equal((await ctx.waitForQuiet()).runs, 0, "no turn started");
    assert.equal(store.getChannelParticipants(channel.id, chat.id).cursor, 0, "the channel message is held");
    assert.equal(store.listMessages(chat.id).length, beforeChannel, "no turn in the history");
    // The notification at the OUTLET (whitelist recordNotice -> event list of the bell/push bridge), with a push verdict.
    const note = (await json(`${base}/api/services/events?since=0`)).events.find((e) => e.requestId === result.requestId);
    assert.ok(note, "the notification is in the event list");
    assert.deepEqual({ kind: note.kind, category: note.category, push: note.push, chatId: note.chatId, resolved: !!note.resolved },
      { kind: "question", category: "question", push: true, chatId: chat.id, resolved: false });
    // Accept: the workflow runs, its completion notice is a follow-up turn of the SAME step, then gate and n2.
    await post(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: result.requestId, decision: "accept" });
    const toward = await untilRunClosed(ctx, r.run.id);
    await ctx.waitForIdle();
    assert.equal(toward.run.status, "done", `run ended as ${toward.run.status}: ${toward.run.note}`);
    assert.ok(toward.steps.some((s) => s.kind === "step" && s.nodeId === "n2"), "n2 ran after the decision");
    assert.ok(store.getChannelParticipants(channel.id, chat.id).cursor >= 1, "the channel message went out after the decision");
    const done = (await json(`${base}/api/services/events?since=0`)).events.find((e) => e.requestId === result.requestId);
    assert.equal(done.resolved, true, "the notification counts as resolved");
    assert.equal(visitCount(store.getWorkflowRunById(r.run.id).cursor, "n1"), 1, "one visit of n1");
    const log = store.listMessages(chat.id);
    const notice = log.findIndex((m) => m.role === "assistant" && m.text.startsWith("Notice processed: Finding c"));
    assert.ok(notice >= 0, "the completion notice was processed in the chat");
  }, { claude });
});

// The card a step holds at must not be the OLDEST open one of the whole chat — a card from an ordinary turn before the run would hold
// step 1 already, and the decision on a step's OWN card would not release it (the cursor carried the old requestId). So the card
// carries its graph step (approval.js createCard, marker `graph`), and openCard reads only the one of the step the chat stands at.
// Counter-test: the line with `z.graph?.runId` struck from approval.js openCard => red (n1 holds at the old card).
test("a card that stayed open BEFORE the graph run holds no step; a step holds at ITS card, its decision releases it", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Please START-WF:b1" });
    const old = await toolResult(root, "b1");
    assert.equal(old.status, "awaiting_approval", JSON.stringify(old));
    await ctx.waitForIdle();
    const flow = await createFlow(base, ws, "Old card", chain(["n1", "One", "N1-JOB"], ["n2", "Two", "N2-JOB START-WF:c"]));
    const r = await start(base, chat.id, flow.id);
    const d = await untilNotRunning(ctx, r.run.id);
    const pending = pendingOf(store.getWorkflowRunById(r.run.id).cursor);
    assert.equal(pending?.node, "n2", `the run holds only at n2, not at the old card: ${d.run.status} ${d.run.question} ${JSON.stringify(pending)}`);
    const fresh = await toolResult(root, "c");
    assert.deepEqual({ status: d.run.status, kind: pending?.kind, requestId: pending?.requestId }, { status: "waiting", kind: "dyn_approval", requestId: fresh.requestId });
    assert.notEqual(fresh.requestId, old.requestId);
    await post(`${base}/api/chats/${chat.id}/dyn-workflows/approval`, { requestId: fresh.requestId, decision: "reject" });
    const toward = await untilRunClosed(ctx, r.run.id);
    await ctx.waitForIdle();
    assert.equal(toward.run.status, "done", `run ended as ${toward.run.status}: ${toward.run.note}`);
    // The old card stays open in the chat — it is decided there, not swallowed by the graph.
    const decided = store.listMessages(chat.id).filter((m) => m.role === "workflow_approval_ruling").map((m) => JSON.parse(m.text).requestId);
    assert.deepEqual(decided, [fresh.requestId]);
  }, { claude });
});

test("a step with a background agent AND a dynamic workflow waits for both; their completion notices are no node visits", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate: gateState, root } = ctx;
    const flow = await createFlow(base, ws, "Both", chain(["n1", "One", "N1-JOB START-AGENT START-WF:d"], ["n2", "Two", "N2-JOB"]), ULTRACODE_RUN);
    const stream = recording(base, chat.id);
    let runId = "";
    try {
      const r = await start(base, chat.id, flow.id);
      runId = r.run.id;
      assert.equal((await toolResult(root, "d")).status, "started");
      await gateState.reached("sub");
      await gateState.reached("wfd");
      await waitForTruthy(() => stream.events.some(waiting) || stream.events.some(step("Two")), "step holds or advances");
      assert.equal(stream.events.some(step("Two")), false, "n2 started alongside running work");
      // The agent first: its report is processed, the workflow still runs — the step keeps holding.
      const prior = stream.events.filter(waiting).length;
      gateState.open("sub");
      await waitForTruthy(() => stream.events.some((e) => assistantText(e, "Report processed: Finding sub")), "report processed");
      await waitForTruthy(() => stream.events.filter(waiting).length > prior || stream.events.some(step("Two")), "keeps holding or advances");
      assert.equal(stream.events.some(step("Two")), false, "n2 started while the workflow was still running");
      gateState.open("wfd");
      const d = await untilRunClosed(ctx, r.run.id);
      await ctx.waitForIdle();
      assert.equal(d.run.status, "done", `run ended as ${d.run.status}: ${d.run.note}`);
    } finally {
      gateState.open("sub"); // also after a failure (see test 1)
      gateState.open("wfd");
      await stream.stop();
    }
    const ev = stream.events;
    const report = ev.findIndex((e) => assistantText(e, "Report processed: Finding sub"));
    const notice = ev.findIndex((e) => assistantText(e, "Notice processed: Finding d"));
    const gate = ev.findIndex((e) => wfRow(e, (l) => l.kind === "gate" && l.done === true && l.title === "One"));
    const n2 = ev.findIndex(step("Two"));
    const situation = JSON.stringify({ report, notice, gate, n2 });
    assert.ok(report >= 0 && notice >= 0 && gate > Math.max(report, notice) && n2 > gate, `both processed, then gate, then n2: ${situation}`);
    assert.equal(visitCount(store.getWorkflowRunById(runId).cursor, "n1"), 1, "n1 counts once");
  }, { claude });
});
