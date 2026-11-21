// Subagents of the loop engine through the agent core — at the main seam: real server, real core (runs/agents.js +
// providers/agent-runtime.js), an engine chat on the fake preset endpoint of the agent harness. The subagent runs at the
// chat's OWN provider (no `provider::`). The engine starts it like Claude and Codex through `cbase_agent` (MCP, call id as
// `_meta["cbase/toolUseId"]`) — it has no `Task` of its own. Checked: list, bar under the call block, report as tool
// result, booking by the core. A call asks for the foreground explicitly here (`run_in_background: false`) — without
// it a subagent runs in the background.
//
// The subagent is held at its first model request (`round` waits for a gate the test opens) — so it provably stands ALIVE
// in the core's list, with no clock deciding anything.
//
// Counter-tests: without `_meta["cbase/toolUseId"]` on the engine's MCP call the first test fails at the bar; an engine
// that runs its subagent in its own process fails the first two at the core's list ("the agent is missing") and the third at
// the core's wordings.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { db } from "../electron/server/store/db.js";

const isSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));
const content = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const hasTool = (b) => (b.messages || []).some((m) => m.role === "tool");
const toolNames = (b) => (b.tools || []).map((t) => t.function?.name || t.name);
const AGENT = "mcp__cbase__cbase_agent";

// One script per test: `main(b)` answers the main agent, the subagent holds at the gate and reports `report`.
function scenario({ main, report = "SUB-REPORT" }) {
  let open;
  const gate = new Promise((r) => { open = r; });
  let arrived;
  const subArrival = new Promise((r) => { arrived = r; });
  return {
    subArrival,
    open: () => open(),
    round: async (b) => {
      if (isSub(b)) {
        arrived(b);
        await gate;
        return { text: report };
      }
      return main(b);
    },
  };
}

async function engineChat(base, ws, engine) {
  const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" }) });
  await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Task core" }) });
  return c;
}

// The chat's event stream, recorded — the agent bar (harness/background) is read from it.
async function stream(base, chatId) {
  const ctl = new AbortController();
  const events = [];
  const r = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const blk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const z of blk.split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch {} }
        }
      }
    } catch { /* unsubscribed */ }
  })();
  return { events, close: () => ctl.abort() };
}

const toolResults = (events) => events
  .filter((e) => e.type === "user" && Array.isArray(e.message?.content))
  .flatMap((e) => e.message.content.filter((c) => c.type === "tool_result"));

const foreground = scenario({
  report: "SUB-REPORT-7",
  main: (b) => (hasTool(b) ? { text: "finished" } : { toolCalls: [{ id: "call_vg", name: AGENT, arguments: { description: "Look", prompt: "Look and report.", run_in_background: false } }] }),
});

test("the engine's cbase_agent in the foreground, own provider: the core's list and bar, report as tool result, booking by the core", async () => {
  await withAgentsServer(async ({ base, ws, engine, waitForTruthy, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please use a subagent" }) });
      const subRequest = await foreground.subArrival;

      // It is alive — and stands in the core's list (the same route as cbase_agents_list).
      const list = await json(`${base}/api/chats/${chat.id}/agents`);
      assert.equal(list.agents?.length, 1, `the agent is missing in the core's list: ${JSON.stringify(list.agents)}`);
      const a = list.agents[0];
      assert.equal(a.provider, engine.id, "the engine's own provider, no provider::");
      assert.equal(a.status, "running");
      // … and in the agent bar (SSE harness/background), under the call block of the cbase_agent call.
      await waitForTruthy(() => s.events.some((e) => e.type === "harness" && e.subtype === "background"
        && (e.agents || []).some((x) => x.agentId === a.agentId && x.toolUseId === "call_vg")), "agent bar");

      // A subagent at depth 1 is offered cbase_agent (down to the third level) — and never `Task`.
      assert.ok(toolNames(subRequest).includes(AGENT), `cbase_agent is missing in the subagent's set at depth 1: ${toolNames(subRequest)}`);
      for (const b of [...engine.requests.filter((x) => !isSub(x)), subRequest]) assert.ok(!toolNames(b).includes("Task"), "Task in the engine's offer");

      foreground.open();
      await waitForIdle();

      // The report came back as a tool result — in the main agent's next request and in the stream.
      const afterwards = engine.requests.find((b) => !isSub(b) && hasTool(b));
      const tool = afterwards.messages.find((m) => m.role === "tool");
      assert.match(content(tool), /SUB-REPORT-7/);
      assert.equal(JSON.parse(content(tool)).agentId, a.agentId);
      const blk = toolResults(s.events).find((c) => c.tool_use_id === "call_vg");
      assert.ok(blk, "tool_result of the cbase_agent call in the stream");
      assert.equal(blk.is_error, false);
      // The engine itself reports no agents (no task ids of its own).
      assert.ok(!s.events.some((e) => e.type === "system" && e.subtype === "task_started"), "task_started from the engine");

      // The subagent's consumption is booked by the core (its own row, its provider).
      const sub = await waitForTruthy(() => db.prepare("SELECT provider, input, output FROM usage_events WHERE chat_id = ? AND kind = 'sub'").all(chat.id)[0], "booking");
      assert.deepEqual({ ...sub }, { provider: engine.id, input: 13, output: 6 });
    } finally {
      foreground.open();
      s.close();
    }
  }, { engine: { round: foreground.round } });
});

const background = scenario({
  report: "SUB-REPORT-9",
  main: (b) => {
    const last = content(b.messages.at(-1) || {});
    if (last.includes("SUB-REPORT-9")) return { text: "seen" };
    if (hasTool(b)) return { text: "waiting for the report" };
    return { toolCalls: [{ id: "call_hg", name: AGENT, arguments: { description: "On the side", prompt: "Look on the side.", run_in_background: true } }] };
  },
});

test("the engine's cbase_agent with run_in_background: the core's background agent, its delivery path — no bookkeeping of the engine's own", async () => {
  await withAgentsServer(async ({ base, ws, engine, waitForTruthy, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please on the side" }) });
      await background.subArrival;

      const list = await json(`${base}/api/chats/${chat.id}/agents`);
      assert.equal(list.agents?.length, 1, `the agent is missing in the core's list: ${JSON.stringify(list.agents)}`);
      const a = list.agents[0];

      // The call returned at once — with the CORE's agentId.
      const immediately = await waitForTruthy(() => engine.requests.find((b) => !isSub(b) && hasTool(b)), "request after the start");
      const first = JSON.parse(content(immediately.messages.find((m) => m.role === "tool")));
      assert.equal(first.status, "running");
      assert.equal(first.background, true);
      assert.equal(first.agentId, a.agentId);
      assert.ok(!s.events.some((e) => e.type === "system" && e.subtype === "task_started"), "task_started from the engine");

      background.open();
      // The report follows the core's path: the main agent gets it as a new message.
      await waitForTruthy(() => engine.requests.some((b) => !isSub(b) && content(b.messages.at(-1) || {}).includes("SUB-REPORT-9")), "delivery of the report");
      await waitForIdle();
    } finally {
      background.open();
      s.close();
    }
  }, { engine: { round: background.round } });
});

test("subagent_type and model go to the core: an unknown type and an unresolvable model are tool errors with the possibilities", async () => {
  const error = {
    round: (b) => (hasTool(b) ? { text: "understood" } : { toolCalls: [
      { id: "call_type", name: AGENT, arguments: { description: "Type", prompt: "Look.", subagent_type: "nonexistent", run_in_background: false } },
      { id: "call_mod", name: AGENT, arguments: { description: "Model", prompt: "Look.", model: "doesnotexist::x", run_in_background: false } },
    ] }),
  };
  await withAgentsServer(async ({ base, ws, engine, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please delegate wrongly" }) });
      await waitForIdle();
      const blk = (id) => toolResults(s.events).find((c) => c.tool_use_id === id);
      assert.equal(blk("call_type")?.is_error, true);
      assert.match(String(blk("call_type").content), /Unknown subagent_type "nonexistent"\. Selectable: general-purpose, fork/);
      assert.equal(blk("call_mod")?.is_error, true);
      assert.match(String(blk("call_mod").content), /Unknown provider in model "doesnotexist::x"\. Possible: /);
      assert.ok(String(blk("call_mod").content).includes(engine.model), "the possibilities name this chat's provider");
      assert.ok(!engine.requests.some(isSub), "no subagent started");
    } finally { s.close(); }
  }, { engine: { ...error } });
});

// The answer in the thinking channel: a model wrote "ready" into `reasoning_content` and left `content` empty. The
// subagent ended "completed" with "(no report)", and an ordinary engine chat would have stored its answer only as a
// thinking block. Here the subagent AND the main agent answer in that form (`{ thinking }` of the harness).
// Counter-test: connectors/openai-chat.js without the fallback => the report is "(no report)".
//
// "Thought, did not act" nudges only if the thinking NAMES a tool of this run — "ready" and "finished" name none, so it
// stays with the fallback and ONE request per round: no nudge, no thinking row, the answer exactly once as an answer.
// The case WITH tool names is in the next test.
test("answer only in the thinking channel: the subagent's report and the chat's answer are not lost", async () => {
  const thinkingChannel = {
    round: (b) => {
      if (isSub(b)) return { thinking: "ready" };
      return hasTool(b) ? { thinking: "finished" } : { toolCalls: [{ id: "call_dk", name: AGENT, arguments: { description: "text", prompt: "Answer with exactly the word: ready", run_in_background: false } }] };
    },
  };
  await withAgentsServer(async ({ base, ws, engine, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please use a subagent" }) });
      await waitForIdle();
      // The subagent's report: in the tool result to the main agent (the same row as cbase_agent).
      const afterwards = engine.requests.find((b) => !isSub(b) && hasTool(b));
      const report = JSON.parse(content(afterwards.messages.find((m) => m.role === "tool")));
      assert.equal(report.report, "ready", `the report was lost in the thinking channel: ${JSON.stringify(report)}`);
      const a = (await json(`${base}/api/chats/${chat.id}/agents`)).agents?.[0];
      assert.equal(a?.status, "completed");
      // The chat itself: the answer stands as an answer in the history, not as a thinking block — and not twice.
      const rows = db.prepare("SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id").all(chat.id);
      assert.equal(rows.filter((z) => z.role === "assistant" && z.text === "finished").length, 1, `the answer does not stand exactly once in the history: ${JSON.stringify(rows)}`);
      assert.ok(!rows.some((z) => z.role === "thinking" && /finished/.test(z.text)), `the answer additionally stands as a thinking block in the history: ${JSON.stringify(rows)}`);
      // Neither run nudges: one request per round (subagent 1, chat 2 — before and after the call).
      assert.ok(!engine.requests.some((b) => /Harness hint: Your last round ended with deliberations only/.test(JSON.stringify(b.messages))), "nudged although the thinking names no tool");
      assert.equal(engine.requests.filter(isSub).length, 1, "the subagent cost more than one request");
      assert.equal(engine.requests.filter((b) => !isSub(b)).length, 2, "the chat cost more than two requests");
    } finally { s.close(); }
  }, { engine: { ...thinkingChannel } });
});

// "Thought, did not act": asked to stop the workflows the model only thought ("I'll attempt the stop call.") and delivered
// neither text nor a tool call — the stop tool was not in the offer (more than 45 tools => deferred loading, and `_stop`
// sat behind ToolSearch), and the connector made the monologue the answer. Here the same chat at the main seam: real cbase
// MCP server (its full set lies above the deferral threshold), the fake endpoint only thinks in round 1 and calls the stop
// tool only once the engine has nudged. Expected: the stop tool is in the offer in round 1 without ToolSearch, the engine
// nudges exactly once (the second request carries the hint), the tool runs at the server, and the thinking stands as
// thinking in the history — never as an answer.
// Counter-tests: engine.js and connectors/openai-chat.js without the fix => a single request, no stop in the offer, and
// the answer in the history is the monologue; engine.js without the start tools in ALWAYS_ON => red at "cbase_dynamic_workflow
// sits behind ToolSearch".
test("thought, did not act: the engine nudges once, the stop tool is there without ToolSearch, the thinking stays thinking", async () => {
  const MONOLOGUE = "The user wants the workflows stopped. The tool is cbase_dynamic_workflow_stop. I'll attempt the stop call.";
  const HINT = /Harness hint: Your last round ended with deliberations only/;
  const glm = {
    round: (b) => {
      if (hasTool(b)) return { text: "Stopped." };
      if (!HINT.test(content(b.messages.at(-1) || {}))) return { thinking: MONOLOGUE };
      return { toolCalls: [{ id: "call_stop", name: "mcp__cbase__cbase_dynamic_workflow_stop", arguments: { taskId: "wf_nonexistent" } }] };
    },
  };
  await withAgentsServer(async ({ base, ws, engine, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "stop the workflows" }) });
      await waitForIdle();
      const main = engine.requests.filter((b) => !isSub(b));
      assert.equal(main.length, 3, `requests: ${main.length} (expected: thinking, nudge, after the tool)`);
      const round1 = toolNames(main[0]);
      assert.ok(round1.includes("ToolSearch"), "the set lies above the deferral threshold — otherwise this test checks nothing");
      assert.ok(round1.includes("mcp__cbase__cbase_dynamic_workflow_stop"), "the stop tool sits behind ToolSearch");
      // Start AND stop of the families stand in round 1 (with the stop in the offer and the start behind ToolSearch, a model
      // called the stop three times in order to start) — here with the REAL cbase server, so also the proof that the names
      // in ALWAYS_ON are the server's. The other members stay deferred. Also cbase_workflow_start/_stop (graph workflows);
      // their status cbase_workflow_status stays deferred. Also cbase_wakeup: it replaces the engine's `ScheduleWakeup`.
      for (const n of ["cbase_dynamic_workflow", "cbase_agent", "cbase_agent_stop", "cbase_monitor", "cbase_monitor_stop", "cbase_wakeup", "cbase_workflow_start", "cbase_workflow_stop"]) {
        assert.ok(round1.includes(`mcp__cbase__${n}`), `${n} sits behind ToolSearch`);
      }
      for (const n of ["cbase_dynamic_workflow_list", "cbase_dynamic_workflow_save", "cbase_agent_send", "cbase_agent_output", "cbase_agents_list", "cbase_workflow_status"]) {
        assert.ok(!round1.includes(`mcp__cbase__${n}`), `${n} is no longer deferred`);
      }
      // Exactly the second request carries the hint, with the way via ToolSearch; the first round does NOT stand as the
      // assistant's answer in the conversation.
      assert.ok(!HINT.test(content(main[0].messages.at(-1))));
      assert.match(content(main[1].messages.at(-1)), HINT);
      assert.match(content(main[1].messages.at(-1)), /ToolSearch \("select:<name>"\)/);
      // On the wire: the hint hangs on the user message — no two user roles in a row (strict templates: 400).
      const roles = main[1].messages.map((m) => m.role);
      assert.ok(!roles.some((r, i) => i > 0 && r === "user" && roles[i - 1] === "user"), `roles of the nudge request: ${roles.join(",")}`);
      // The date line up front (providers/engine.js `dateLine`): the first input of a run without a date in the history.
      assert.match(content(main[1].messages.at(-1)), /^\[Today is \d{4}-\d{2}-\d{2}\.\]\n\nstop the workflows\n\n\[Harness hint/);
      assert.ok(!main[1].messages.some((m) => m.role === "assistant" && /attempt the stop call/.test(content(m))), "the thinking was played back to the model as an answer");
      // The tool ran at the cbase server (its wording, no "Unknown tool" of the engine).
      const blk = toolResults(s.events).find((c) => c.tool_use_id === "call_stop");
      assert.ok(blk, "no result of the stop call");
      assert.doesNotMatch(String(blk.content), /Unknown tool/);
      // In the history: the thinking as thinking, the answer as an answer — the monologue never as an answer.
      const rows = db.prepare("SELECT role, text FROM messages WHERE chat_id = ? ORDER BY id").all(chat.id);
      assert.equal(rows.filter((z) => z.role === "thinking" && /attempt the stop call/.test(z.text)).length, 1, `thinking rows: ${JSON.stringify(rows)}`);
      assert.ok(!rows.some((z) => z.role === "assistant" && /attempt the stop call/.test(z.text)), `the monologue stands as an answer in the history: ${JSON.stringify(rows)}`);
      assert.ok(rows.some((z) => z.role === "assistant" && z.text === "Stopped."), `no answer in the history: ${JSON.stringify(rows)}`);
    } finally { s.close(); }
  }, { engine: { ...glm } });
});

// The start of a tool call in the stream: the fake endpoint streams the id and name of every call (like OpenAI/OpenRouter),
// the connector reports `toolStart`, the engine emits `content_block_start`/tool_use. Here at the main seam, through the
// core: the start of the cbase_agent call in the main stream (no parent), the start of the call the SUBAGENT makes, with
// the `parent_tool_use_id` of the cbase_agent call (agent-runtime.js makeForward passes it on like any delta) — each
// EXACTLY ONCE, before the assistant event of the same id, and in the DB exactly one tool row per call (the engine row at
// the assistant event; a stream_event persists nothing).
// Counter-test: an engine without `content_block_start` for tool calls => "start of call_task is missing".
test("tool start through the core: start of the cbase_agent call in the main stream, start of the subagent's call below it — once each, one DB row per call", async () => {
  const sub = { round: (b) => (isSub(b)
    ? (hasTool(b) ? { text: "SUB-REPORT-11" } : { toolCalls: [{ id: "call_sub", name: "Glob", arguments: { pattern: "*.doesnotexist" } }] })
    : (hasTool(b) ? { text: "finished" } : { toolCalls: [{ id: "call_task", name: AGENT, arguments: { description: "Search", prompt: "Search and report.", run_in_background: false } }] })) };
  await withAgentsServer(async ({ base, ws, engine, waitForIdle }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please use a subagent" }) });
      await waitForIdle();
      const isStart = (e, id) => e.type === "stream_event" && e.event?.type === "content_block_start" && e.event.content_block?.type === "tool_use" && e.event.content_block.id === id;
      const isCall = (e, id) => e.type === "assistant" && (e.message?.content || []).some((b) => b.type === "tool_use" && b.id === id);
      for (const [id, parent] of [["call_task", null], ["call_sub", "call_task"]]) {
        const starts = s.events.filter((e) => isStart(e, id));
        assert.equal(starts.length, 1, `start of ${id} is missing or comes twice: ${starts.length}`);
        assert.equal(starts[0].parent_tool_use_id ?? null, parent, `${id}: parent_tool_use_id`);
        assert.equal(starts[0].event.content_block.name, id === "call_task" ? AGENT : "Glob");
        const iStart = s.events.indexOf(starts[0]);
        const iCall = s.events.findIndex((e) => isCall(e, id));
        assert.ok(iCall > iStart, `${id}: start #${iStart}, call #${iCall}`);
        assert.equal(s.events[iCall].parent_tool_use_id ?? null, parent, `${id}: the assistant event under the same parent call`);
      }
      const toolRows = db.prepare("SELECT text FROM messages WHERE chat_id = ? AND role = 'tool' ORDER BY id").all(chat.id).map((z) => JSON.parse(z.text));
      assert.deepEqual(toolRows.map((z) => [z.id, z.parent ?? null]), [["call_task", null], ["call_sub", "call_task"]], `tool rows: ${JSON.stringify(toolRows)}`);
      const blk = toolResults(s.events).find((c) => c.tool_use_id === "call_task");
      assert.match(String(blk?.content), /SUB-REPORT-11/);
    } finally { s.close(); }
  }, { engine: { ...sub } });
});

// ── The step cap at the main seam ───────────────────────────────────────────────────────────────────────────────────────
// At the step cap (60 tool rounds) EVERY run of the loop engine ending with exit 1 would be right for the subagent
// ("completed" would be a lie), but a dead end for the MAIN run: exit != 0 goes into run_error and afterRunFailed in
// runs/do-run.js — a graph workflow would end "failed" (workflows/gates.js workflowRunFailed), and the goal gate would never
// judge (`goal` is set only in the exit-0 branch). So the main run ends regularly, the hint stands in its answer — and the
// subagent still fails.
// The endpoint answers every request with a tool call (Glob) until the cap bites. Waiting is for quiet and events, never
// for a duration. Counter-test: an engine that ends the capped run with exit 1 => workflow "failed", no goal row — red.
const TARGET_VERDICTS = fakeClaude({
  oneshot: `
    if (prompt.includes("achieved")) {
      fs.appendFileSync(path.join(LOCATION, "target-verdicts.log"), JSON.stringify(prompt) + "\\n");
      return respond('{"achieved": true, "note": "interim state seen"}');
    }
    respond("Title");`,
});
const alwaysGlob = () => {
  let n = 0;
  return { round: () => ({ toolCalls: [{ id: `call_cap_${++n}`, name: "Glob", arguments: { pattern: "*.doesnotexist" } }] }) };
};

test("step cap: the main run's step cap does not end the graph workflow — the step ends regularly, with the hint", async () => {
  const scenarioCap = alwaysGlob();
  await withAgentsServer(async ({ base, ws, engine, waitForTruthy, waitForQuiet }) => {
    // A graph workflow with ONE work step (without a completion check): the step ends at the cap.
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Cap workflow" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({
      graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "n1", type: "instruction", title: "Long work", text: "WORK LONG", x: 220, y: 0 },
          { id: "e0", type: "end", title: "End", x: 440, y: 0 },
        ],
        edges: [{ from: "s0", to: "n1" }, { from: "n1", to: "e0" }],
      },
      run: { doneAll: false },
    }) });
    const wfChat = await engineChat(base, ws, engine);
    const start = await json(`${base}/api/chats/${wfChat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "" }) });
    const run = await waitForTruthy(async () => {
      const d = await json(`${base}/api/workflow-runs/${start.run.id}`);
      return ["done", "failed", "waiting"].includes(d.run.status) ? d : null;
    }, "workflow run at the end");
    assert.equal(run.run.status, "done", `the workflow ended as ${run.run.status}: ${run.run.note || ""}`);
    await waitForQuiet();
    const wfLog = await json(`${base}/api/chats/${wfChat.id}/log`);
    assert.ok(wfLog.some((m) => m.role === "assistant" && String(m.text).startsWith("[Harness hint: Step cap of the loop engine reached: 60")),
      "the hint stands in the workflow chat's history");
    const requestsWf = engine.requests.filter((b) => (b.messages || []).some((m) => content(m).includes("WORK LONG")));
    assert.equal(requestsWf.length, 60, "the step ran up to the cap");
  }, { engine: { ...scenarioCap } });
});

test("step cap: the main run's step cap does not stop the goal gate — it judges an answer with the hint", async () => {
  const scenarioCap = alwaysGlob();
  await withAgentsServer(async ({ base, ws, engine, root, waitForQuiet }) => {
    // A chat with a goal (/goal): the turn ends at the cap, the goal gate judges.
    const targetChat = await engineChat(base, ws, engine);
    await json(`${base}/api/chats/${targetChat.id}`, { method: "PATCH", body: JSON.stringify({ goal: "Search the whole tree" }) });
    await json(`${base}/api/chats/${targetChat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Search everything" }) });
    await waitForQuiet();
    const targetLog = await json(`${base}/api/chats/${targetChat.id}/log`);
    const verdicts = targetLog.filter((m) => m.role === "goal").map((m) => JSON.parse(m.text));
    assert.equal(verdicts.length, 1, `the goal gate did not judge: ${JSON.stringify(targetLog.map((m) => m.role))}`);
    assert.equal(verdicts[0].achieved, true);
    const prompts = fs.readFileSync(path.join(root, "target-verdicts.log"), "utf8").trim().split("\n").map((z) => JSON.parse(z));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /\[Harness hint: Step cap of the loop engine reached/, "the judge sees that the answer is an interim state");
    assert.equal((await json(`${base}/api/chats/${targetChat.id}`)).goal, "", "achieved => the goal is cleared");
  }, { claude: TARGET_VERDICTS, engine: { ...scenarioCap } });
});

test("step cap: a subagent's step cap stays an error — the core reports it failed, the main run learns the reason", async () => {
  const scenarioSub = {
    round: (b) => {
      if (isSub(b)) return { toolCalls: [{ id: `call_sub_${b.messages.length}`, name: "Glob", arguments: { pattern: "*.doesnotexist" } }] };
      return hasTool(b) ? { text: "subagent failed, understood" } : { toolCalls: [{ id: "call_task_cap", name: AGENT, arguments: { description: "Endless", prompt: "Search without end.", run_in_background: false } }] };
    },
  };
  await withAgentsServer(async ({ base, ws, engine, waitForQuiet }) => {
    const chat = await engineChat(base, ws, engine);
    const s = await stream(base, chat.id);
    try {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please use a subagent" }) });
      await waitForQuiet();
      const list = await json(`${base}/api/chats/${chat.id}/agents`);
      assert.equal(list.agents?.length, 1);
      assert.equal(list.agents[0].status, "failed", `the subagent at the cap: ${JSON.stringify(list.agents[0])}`);
      const blk = toolResults(s.events).find((c) => c.tool_use_id === "call_task_cap");
      assert.equal(blk?.is_error, true, "the report is a tool error");
      assert.match(String(blk.content), /Step cap of the loop engine reached: 60 tool rounds/);
      assert.equal(engine.requests.filter(isSub).length, 60);
      // The main run itself ended regularly (no run_error).
      assert.ok(!s.events.some((e) => e.type === "harness" && e.subtype === "run_error"), "run_error in the main run");
    } finally { s.close(); }
  }, { engine: { ...scenarioSub } });
});
