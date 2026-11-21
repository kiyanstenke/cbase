// Active runs (GET /api/active-runs): the header overview must tell the truth DURING a run - which chat is computing, in which
// workflow step it is, what waits for an answer - and be empty afterwards. Checked against a fake CLI (no network) whose turn
// holds at a GATE until the test opens it: only that makes the running state observable at all, with no clock.
//
// Dynamic workflows, the last tests, with the agent harness: a running dynamic workflow is NOT in `busy` (the deploy does not wait
// for it) but a field of its own in /api/runs/active (count, name, state) and a kind of its own in /api/active-runs, even without
// a turn; start and end report on /api/events (the pill reloads on that); a background subagent stays `busy`. Plus the real command
// lines of both agents against the deploy's one-shot detection (tools/check/lib/processes.mjs): the workflow agent does not hold
// the deploy, the subagent does.
// Project containers: a workflow agent of a CONVERTED project has its MCP file in the runtime folder
// (`data/projects/<id>/scratch/...workflow.mcp.json`) - the process marker recognises it by name, not folder, so the deploy gate
// lets it through; at the end the file is gone. Counter-tests: runs/agents.js MCP file of the factory with
// `location: locationForChat(null)` (flat) => red at the folder; runs/runtime-location.js `agentMcpFileIn` without `.workflow`
// => red at the process marker.
// With operating marker and instance row the workflow agent runs through `docker exec ... cbase-wrapper ... -- claude ...` (fake
// docker) - the wrapper line of this REAL call and the inner line, as `pgrep -af` shows them, are ONE workflow agent for the
// one-shot detection, not two. Counter-test: an older `partsProcesses` that counts both lines gives 2.
// Counter-tests: runs/routes.js with `|| dynWorkflows.length > 0` back in `busy` => "workflow alone" red at busy; runs/agents.js
// agentMcpFile without the `.workflow` suffix => "workflow alone" red at the process marker.
// The `approvals` field lists EVERY waiting card with chat title - an airlock card and a permission question of a coding chat,
// not only a manager tool's; the deploy gate names from it the chat in which to decide (the deploy tool's gates-background.test.mjs).
// Counter-test: runs/routes.js with the old filter `if (!p.approval) continue;` => red at the list.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import * as store from "../electron/server/store.js";
import { RIPCORD } from "./ripcord.mjs";
import { fakeClaude as agentsClaude, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { waitForQuiet } from "./quiet.mjs";
import { partsProcesses } from "../../../tools/check/lib/processes.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import crypto from "node:crypto";
import { occupyHeavyLoad } from "../electron/server/projectbox/heavyLoad.js";
import { startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { pendingPermissions } from "../electron/server/runs/approvals.js";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an event - WITHOUT a deadline (no timers in tests: the emergency brake is the suite deadline). Every 30 s one line on
// stderr so that a hang says what it waits for. The end of the work is measured by waitForQuiet (quiet.mjs).
async function waitFor(fn, what = "", every = 40) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${what || String(fn).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    await sleep(every);
  }
}

// Fake CLI with GATE: the turn answers only when the gate file exists (`openTheGate()` in the test). The one-shot branch (runOnce,
// e.g. auto title) answers at once with JSON and exits - otherwise runOnce waits for close.
const fakeClaude = (gateFile) => `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ result: '{"yes": true, "note": "ok"}' }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    const out = "ECHO " + text.replace(/\\s+/g, " ").slice(0, 120);
    const gate = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(gateFile)})) return;
      clearInterval(gate);
      say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
      say({ type: "result", result: out, session_id: "active-runs" });
    }, 20);
  });
}
`;

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-active-"));
  const bin = path.join(root, "fake-claude");
  const gateFile = path.join(root, "turn-gate");
  const openTheGate = () => fs.writeFileSync(gateFile, "");
  const prevBin = process.env.CLAUDE_BIN;
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  const prevRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    fs.writeFileSync(bin, fakeClaude(gateFile));
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    // No test here restarts: the post-start step stays off.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3600_000);
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Active", path: wsPath }) });
    await fn({ base, ws, openTheGate });
    finished = true;
  } finally {
    // A held turn must not hold up the cleanup; wait for quiet only if the body passed (template: agent-harness.mjs) - after a
    // failure a hanging run would otherwise stand without deadline.
    try { openTheGate(); } catch { /* root already gone */ }
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL; else process.env.CBASE_TRIGGER_POLL = prevPoll;
    if (prevRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = prevRestartGrace;
    // A test must not fail because its temp directory does not go away: a child process still writing causes ENOTEMPTY, which says
    // something about the cleanup, not the product. It is still not hushed up - otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
}

async function newChat(base, ws, title) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
  return chat;
}
const active = (base) => json(`${base}/api/active-runs`);
// The initial state of the global stream (/api/events, first `data:` event) - and the connection closed again at once (abort in
// finally: an open SSE connection would hold server.close() forever).
async function eventsInit(base) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
    }
  } finally {
    ac.abort();
    try { await reader.cancel(); } catch {}
  }
  const row = buffer.split("\n").find((z) => z.startsWith("data: "));
  assert.ok(row, `no data event on /api/events: ${JSON.stringify(buffer)}`);
  return JSON.parse(row.slice("data: ".length));
}
// Wait for an entry that meets the condition (the run needs a moment to start).
const waitForItem = (base, pred) => waitFor(async () => (await active(base)).items.find(pred) || null, `entry in /api/active-runs: ${String(pred)}`, 30);

test("without a run the overview is empty", async () => {
  await withServer(async ({ base }) => {
    const view = await active(base);
    assert.deepEqual(view.items, []);
    // "limit" = runs waiting at the usage limit (auto-continue); stays disjoint like the others.
    assert.deepEqual(view.counts, { total: 0, running: 0, waiting: 0, ask: 0, limit: 0 });
    assert.ok(view.now > 0);
  });
});

test("/api/runs/active names every waiting card with chat title (airlock and permission question), without a card the field is empty", async () => {
  await withServer(async ({ base, ws }) => {
    assert.deepEqual((await json(`${base}/api/runs/active`)).approvals, [], "empty without a card - not missing");
    const chat = await newChat(base, ws, "Payment bug in checkout");
    const ids = [`au9-${crypto.randomUUID()}`, `au9-${crypto.randomUUID()}`];
    pendingPermissions.set(ids[0], { chatId: chat.id, toolName: "mcp__teams__teams_send", airlock: true });
    pendingPermissions.set(ids[1], { chatId: chat.id, toolName: "Bash" });
    try {
      const f = (await json(`${base}/api/runs/active`)).approvals;
      assert.deepEqual(f, [
        { chatId: chat.id, title: "Payment bug in checkout", toolName: "mcp__teams__teams_send" },
        { chatId: chat.id, title: "Payment bug in checkout", toolName: "Bash" },
      ]);
    } finally {
      for (const id of ids) pendingPermissions.delete(id);
    }
  });
});

test("a running chat is listed with title, place and runtime - and disappears afterwards", async () => {
  await withServer(async ({ base, ws, openTheGate }) => {
    const chat = await newChat(base, ws, "Long run");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Count to three" }) });

    const item = await waitForItem(base, (i) => i.chatId === chat.id);
    assert.ok(item, "running chat missing in the overview");
    assert.equal(item.kind, "chat");
    assert.equal(item.phase, "running");
    assert.equal(item.title, "Long run");
    assert.equal(item.workspaceId, ws.id);
    assert.equal(item.workspaceName, "Active");
    assert.equal(item.provider, "claude");
    assert.equal(item.stoppable, true);
    assert.equal(item.workflow, null);
    assert.ok(item.startedAt > 0 && item.startedAt <= Date.now(), "startedAt implausible");

    const view = await active(base);
    assert.equal(view.counts.total, 1);
    assert.equal(view.counts.running, 1);
    // The global stream says the same DURING the run: its initial state carries the running chat. runtime/sse.js does not read
    // `running` itself but through the setter setRunState from server.js - this holder holds the WIRING
    // (`running: () => [...running]`), not only the sse side (hook-consumer-h4.test.js sets a setter of its own). With
    // `running: () => []` in server.js everything else would stay green.
    const init = await eventsInit(base);
    assert.equal(init.type, "init");
    assert.deepEqual(init.running, [chat.id], "the initial state of the global stream does not name the running chat");

    // Up to here the turn held at the gate - every check above lay safely IN THE MIDDLE of the run.
    openTheGate();
    await waitForQuiet(base);
    const after = await active(base);
    assert.deepEqual(after.items, [], "after the run the overview must be empty");
    assert.equal(after.counts.total, 0);
    assert.deepEqual((await eventsInit(base)).running, [], "after the run the initial state must be empty");
  });
});

test("a workflow run shows step and node title on the running chat", async () => {
  await withServer(async ({ base, ws, openTheGate }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "Two-Steps" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({ run: { doneAll: false }, graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "n0", type: "instruction", title: "Read file", text: "Read file A", x: 200, y: 0 },
          { id: "n1", type: "instruction", title: "Summarize", text: "Summarize it", x: 400, y: 0 },
        ],
        edges: [{ from: "s0", to: "n0" }, { from: "n0", to: "n1" }],
      } }),
    });
    const chat = await newChat(base, ws, "Workflow chat");
    const run = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "go" }) });

    const item = await waitForItem(base, (i) => i.chatId === chat.id && i.workflow);
    assert.ok(item, "workflow run missing in the overview");
    assert.equal(item.workflow.name, "Two-Steps");
    assert.equal(item.workflow.origin, "");
    assert.equal(item.workflow.total, 2);
    assert.ok(item.workflow.step >= 1, `step implausible: ${item.workflow.step}`);
    assert.equal(item.workflow.nodeTitle, item.workflow.step === 1 ? "Read file" : "Summarize");

    // Both steps run through: wait for the end of the RUN (not just a gap between two steps), then quiet.
    openTheGate();
    await waitFor(async () => ((await json(`${base}/api/workflow-runs/${run.run.id}`)).run.status === "done" ? true : null), "workflow run done");
    await waitForQuiet(base);
    // The workflow is finished -> it must NOT count as an open run anymore.
    assert.equal((await active(base)).counts.total, 0);
  });
});

test("an open question stands as an entry of its own on top - even without a computing turn", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "With-Question" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, {
      method: "PUT",
      body: JSON.stringify({ run: { doneAll: false }, graph: {
        nodes: [
          { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
          { id: "a1", type: "ask", title: "Approval", text: "Shall I merge?", x: 200, y: 0 },
          { id: "n1", type: "instruction", title: "Merge", text: "Merge the branch", x: 400, y: 0 },
        ],
        edges: [{ from: "s0", to: "a1" }, { from: "a1", to: "n1" }],
      } }),
    });
    const chat = await newChat(base, ws, "Question chat");
    await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id }) });

    const item = await waitFor(async () => {
      const v = await active(base);
      return v.items.find((i) => i.chatId === chat.id && i.phase === "ask") || null;
    }, "question entry");
    assert.ok(item, "waiting workflow missing in the overview");
    assert.equal(item.kind, "workflow");
    assert.equal(item.question, "Shall I merge?");
    assert.equal(item.workflow.name, "With-Question");
    assert.equal(item.stoppable, false, "a question is not cancelled with \"Stop\"");

    const view = await active(base);
    assert.equal(view.counts.ask, 1);
    assert.equal(view.counts.running, 0);
    assert.equal(view.items[0].id, item.id, "what needs attention stands on top");
  });
});

test("\"Stop\" takes the run out of the overview", async () => {
  await withServer(async ({ base, ws }) => {
    const chat = await newChat(base, ws, "To stop");
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Compute for a long time" }) });
    await waitForItem(base, (i) => i.chatId === chat.id);

    // The turn holds at the gate, which is never opened - only the stop ends it.
    await json(`${base}/api/chats/${chat.id}/stop`, { method: "POST" });
    const gone = await waitFor(async () => ((await active(base)).items.length === 0 ? true : null), "overview empty after the stop", 40);
    assert.equal(gone, true, "stopped run still stands in the overview");
  });
});

// ── Dynamic workflows do not count in busy, but show up everywhere else ─────────────────────────────────────────────
// The main agent: "WF[<tag>]:{json}" calls cbase_dynamic_workflow, "AG[<tag>]:{json}" cbase_agent (call block like the real CLI);
// the tool result lies under wf-<tag> or ag-<tag>.
const T63_MAIN = `
  if (text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "notification read" }] } });
    finished();
    say({ type: "result", result: "notification read", session_id: "main-session" });
    return;
  }
  for (const [marker, tool, before] of [["WF[", "cbase_dynamic_workflow", "wf-"], ["AG[", "cbase_agent", "ag-"]]) {
    const i = text.indexOf(marker);
    if (i < 0) continue;
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_" + before.replace("-", "") + "_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + tool, input: args }] } });
    let t = "";
    try { const r = await mcpCall(tool, args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, before + tag), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    break;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;
// An agent (workflow agent or subagent): {TAG:x} in the computed task, {GATE:x} holds it at the gate. It stores its argv and whether
// it is a workflow agent under argv-<tag> - the command line that `ps`/`pgrep` show the deploy.
const T63_SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "argv-" + tag), JSON.stringify({ argv, workflow: isWorkflowAgent }));
    say({ type: "assistant", message: { id: "s1-" + tag, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;
const t63Claude = agentsClaude({ main: T63_MAIN, sub: T63_SUB });

async function t63Calls(ctx, kind, tag, args) {
  await json(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `${kind}[${tag}]:${JSON.stringify(args)}` }) });
  const file = path.join(ctx.root, `${kind === "WF" ? "wf" : "ag"}-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  await waitForTruthy(async () => (await json(`${ctx.base}/api/runs/active`)).runs === 0, "turn over");
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
// The command line as `ps -o command=` shows it: the binary, then the argv.
const t63CommandLine = (root, tag) => {
  const { argv, workflow } = JSON.parse(fs.readFileSync(path.join(root, `argv-${tag}`), "utf8"));
  return { cmd: ["/usr/local/bin/claude", ...argv].join(" "), workflow };
};
// The global stream (/api/events): read along all events, closed in finally.
async function t63Stream(base) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  const events = [];
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on closing */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

test("workflow alone: busy:false, dynWorkflows with count, name and state, kind of its own in /api/active-runs, global event at start and end, the agent process does not hold the deploy gate", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const stream = await t63Stream(base);
    try {
      const script = "export const meta = { name: 'tracer', description: 'Deploy', phases: [{ title: 'Read' }] }\nphase('Read')\nconst a = await agent('Read {TAG:w} {GATE:w}')\nreturn a";
      const r = await t63Calls(ctx, "WF", "w", { script });
      assert.equal(r.status, "started", JSON.stringify(r));
      await ctx.gate.reached("w");
      await waitForTruthy(() => stream.events.some((e) => e.type === "dyn_workflow" && e.runId === r.runId && e.open === true), "global event at start");

      const isActive = await json(`${base}/api/runs/active`);
      assert.deepEqual([isActive.busy, isActive.runs, isActive.agents], [false, 0, []], "a running workflow does not hold the deploy");
      assert.equal(isActive.dynWorkflows.length, 1, "the count");
      const [w] = isActive.dynWorkflows;
      assert.deepEqual([w.chatId, w.runId, w.taskId, w.name], [chat.id, r.runId, r.taskId, "tracer"]);
      assert.deepEqual(w.progress, { phase: "Read", agents: 1, finished: 0 }, "the state: latest phase, started/finished agent() calls");
      assert.equal(typeof w.startedAt, "number");

      // /api/active-runs: a kind of its own (not "workflow", the graph's), even without a running turn - and counted.
      const view = await json(`${base}/api/active-runs`);
      const item = view.items.find((i) => i.kind === "dynworkflow");
      assert.ok(item, JSON.stringify(view.items));
      assert.equal(item.chatId, chat.id);
      assert.equal(item.workflow, null, "not the graph workflow's kind");
      assert.deepEqual(item.dynWorkflow, { runId: r.runId, taskId: r.taskId, name: "tracer", phase: "Read", agents: 1, finished: 0 });
      assert.equal(item.phase, "running");
      assert.ok(view.counts.total >= 1 && view.counts.running >= 1, JSON.stringify(view.counts));

      // The workflow agent's command line carries the process marker: the deploy gate lets it through.
      const k = t63CommandLine(root, "w");
      assert.equal(k.workflow, true, "the fake ran as a workflow agent");
      const { holds, workflow } = partsProcesses([{ pid: 1, cmd: k.cmd }]);
      assert.deepEqual([holds.length, workflow.length], [0, 1], `process marker missing: ${k.cmd}`);

      ctx.gate.open("w");
      await waitForTruthy(() => stream.events.some((e) => e.type === "dyn_workflow" && e.runId === r.runId && e.open === false), "global event at end");
      await ctx.waitForQuiet();
      assert.deepEqual((await json(`${base}/api/runs/active`)).dynWorkflows, []);
      assert.ok(!(await json(`${base}/api/active-runs`)).items.some((i) => i.kind === "dynworkflow"), "gone after the end");
    } finally {
      await stream.shutdown();
    }
  }, { claude: t63Claude });
});

test("a background subagent stays busy:true, and its process holds the deploy gate", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, root } = ctx;
    const r = await t63Calls(ctx, "AG", "s", { description: "On the side", prompt: "Task {TAG:s} {GATE:s}", run_in_background: true });
    assert.ok(!r.error, r.error);
    await ctx.gate.reached("s");
    const isActive = await json(`${base}/api/runs/active`);
    assert.deepEqual([isActive.busy, isActive.runs, isActive.agents.length, isActive.dynWorkflows], [true, 0, 1, []], JSON.stringify(isActive));
    const k = t63CommandLine(root, "s");
    assert.equal(k.workflow, false);
    const { holds, workflow } = partsProcesses([{ pid: 1, cmd: k.cmd }]);
    assert.deepEqual([holds.length, workflow.length], [1, 0], `a subagent must not count as a workflow agent: ${k.cmd}`);
    ctx.gate.open("s");
    await ctx.waitForQuiet();
  }, { claude: t63Claude });
});

test("a workflow agent of a converted project: MCP file in the runtime folder, the process marker does not hold the deploy, gone at the end", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, ws, dataRoot } = ctx;
    const projPath = path.join(root, "workspace", "till");
    const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Till", path: projPath }) });
    fs.mkdirSync(projPath, { recursive: true });
    store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now() });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const w = path.join(dataRoot, "data", "projects", p.id);
    const script = "export const meta = { name: 'ort', description: 'Runtime folder', phases: [{ title: 'Read' }] }\nphase('Read')\nconst a = await agent('Read {TAG:p} {GATE:p}')\nreturn a";
    const r = await t63Calls(ctx, "WF", "p", { script });
    assert.equal(r.status, "started", JSON.stringify(r));
    assert.ok(r.scriptPath.startsWith(path.join(w, "outputs", chat.id, "workflows") + path.sep), `script in the runtime folder: ${r.scriptPath}`);
    await ctx.gate.reached("p");
    const { argv, workflow } = JSON.parse(fs.readFileSync(path.join(root, "argv-p"), "utf8"));
    assert.equal(workflow, true, "the fake ran as a workflow agent");
    const cfg = argv[argv.indexOf("--mcp-config") + 1];
    assert.equal(path.dirname(cfg), path.join(w, "scratch"), `MCP file in the runtime folder: ${cfg}`);
    assert.match(path.basename(cfg), new RegExp(`^${chat.id}\\.agent-[^/]+\\.workflow\\.mcp\\.json$`));
    assert.ok(fs.existsSync(cfg));
    const k = t63CommandLine(root, "p");
    const { holds, workflow: wf } = partsProcesses([{ pid: 1, cmd: k.cmd }]);
    assert.deepEqual([holds.length, wf.length], [0, 1], `process marker missing: ${k.cmd}`);
    assert.equal((await json(`${base}/api/runs/active`)).busy, false, "a workflow in the new folder still does not hold the deploy");
    ctx.gate.open("p");
    await ctx.waitForQuiet();
    assert.ok(!fs.existsSync(cfg), "at the end of the agent its MCP file is gone");
    assert.ok(!fs.existsSync(path.join(dataRoot, "data", "scratch", path.basename(cfg))), "it never lay flat");
  }, { claude: t63Claude });
});

test("a workflow agent in the project container: wrapper line and inner line are ONE workflow agent", async () => {
  const fd = await fakeDocker();
  const markers = { CBASE_CONTAINER: "1", CBASE_DIND: "1", CBASE_DOCKER_BIN: fd.bin };
  const saved = Object.fromEntries(Object.keys(markers).map((k) => [k, process.env[k]]));
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, root, ws } = ctx;
      try {
        Object.assign(process.env, markers);
        const projPath = path.join(root, "workspace", "till");
        fs.mkdirSync(projPath, { recursive: true });
        const p = await ctx.projectWithoutInstance({ name: "Till", path: projPath });
        const name = `cbase-p-${p.id}`;
        execFileSync(fd.bin, ["run", "-d", "--name", name, "cbase-projectbox:test"], { env: { ...process.env, ...fd.env } });
        store.createProjectInstance({ projectId: p.id, state: "ready", convertedAt: Date.now(), containerId: name });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ projectId: p.id }) });
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
        const script = "export const meta = { name: 'box', description: 'Container', phases: [{ title: 'Read' }] }\nphase('Read')\nconst a = await agent('Read {TAG:q} {GATE:q}')\nreturn a";
        const r = await t63Calls(ctx, "WF", "q", { script });
        assert.equal(r.status, "started", JSON.stringify(r));
        await ctx.gate.reached("q");
        // The wrapper line: the real call of the docker child, as `pgrep -af` shows it in the user container.
        const call = fd.calls({ daemon: "host" }).find((a) => a.args[0] === "exec" && a.args.some((x) => x.endsWith(".workflow.mcp.json")));
        assert.ok(call, "the workflow agent did not run through docker exec");
        assert.ok(call.args.includes(name) && call.args.includes("/usr/sbin/cbase-wrapper"), JSON.stringify(call.args).slice(0, 300));
        const wrapper = `4711 docker ${call.args.join(" ")}`;
        // The inner line: the process the wrapper replaced via exec - the fake CLI is a node script.
        const { argv, workflow } = JSON.parse(fs.readFileSync(path.join(root, "argv-q"), "utf8"));
        assert.equal(workflow, true);
        const inside = `4712 ${process.execPath} ${process.env.CLAUDE_BIN} ${argv.join(" ")}`;
        assert.deepEqual(partsProcesses([wrapper, inside]), { holds: [], workflow: [inside] }, "wrapper and inner line are ONE workflow agent");
        assert.deepEqual(partsProcesses([wrapper]), { holds: [], workflow: [wrapper] }, "if B does not see the inner one, the wrapper counts for it");
        ctx.gate.open("q");
        await ctx.waitForQuiet();
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    }, { claude: t63Claude });
  } finally {
    fd.cleanUp();
  }
});

// /api/runs/active counts the relocations IN PROGRESS (`relocationsOpen`, once per instance: open journal, state `relocation`
// without journal, heavy load "relocation" before the journal) - the deploy's rollback lock locks on that like on `converted`,
// which counts only from the switch-over. And it names a relocation's old containers ONLY as sha256 of the full id
// (`relocationContainer`: plan and list from step 4, open and `finished` journals - never `back`: there the way back started the
// stack in B again) - `restoreInner` does not start them again after a swap. No id, no name in plain text (the route is
// unauthenticated). Counter-test: without the two fields in runs/routes.js this test is red at `relocationsOpen`.
test("relocationsOpen counts every relocation in progress; relocationContainer names the old containers only as sha256, without `back`", async () => {
  await withServer(async ({ base }) => {
    const empty = await json(`${base}/api/runs/active`);
    assert.equal(empty.relocationsOpen, 0, "without a relocation the count stands as 0 (a missing field would be \"unknown\")");
    assert.deepEqual(empty.relocationContainer, []);
    const id = (n) => crypto.createHash("sha256").update(`container-${n}`).digest("hex"); // the form of a full container id
    const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
    // Open: plan with two containers (stands from the creation of the journal), step 4 with one of them and a third.
    const j1 = store.createRelocation({ projectId: "p-open", location: "/relocation/1" });
    store.writeRelocation(j1.id, { data: {
      plan: { container: [{ id: id(1), name: "shop-db-1" }, { id: id(2), name: "shop-web-1" }] },
      container: { list: [{ id: id(2), name: "shop-web-1" }, { id: id(3), name: "shop-worker-1" }], native: [] },
    } });
    // An instance in `relocation` without journal; the heavy load before the journal - and the same key twice counts once.
    store.createProjectInstance({ projectId: "p-state", state: "relocation" });
    const free = occupyHeavyLoad("relocation", { projectId: "p-heavy" });
    // Back: the way back started the stack again - it belongs to B, a deploy brings it back.
    const j3 = store.createRelocation({ projectId: "p-back", location: "/relocation/3" });
    store.writeRelocation(j3.id, { data: { plan: { container: [{ id: id(4), name: "old-db-1" }] } } });
    store.endRelocation(j3.id, "back");
    // Finished and converted; no full id (short, upper case) never counts.
    const j4 = store.createRelocation({ projectId: "p-finished", location: "/relocation/4" });
    store.writeRelocation(j4.id, { data: { plan: { container: [{ id: id(5) }, { id: id(5).slice(0, 12) }, { id: id(6).toUpperCase() }] } } });
    store.endRelocation(j4.id, "finished");
    store.createProjectInstance({ projectId: "p-finished", state: "ready", convertedAt: Date.now() });
    try {
      const r = await json(`${base}/api/runs/active`);
      assert.equal(r.relocationsOpen, 3, JSON.stringify(r));
      assert.equal(r.converted, 1);
      // Intended: an OPEN journal counts only the list from step 4 - id(1) stands only in the plan, the relocation has not
      // stopped it (yet), it belongs to B; a finished one still plan + list (id(5)).
      assert.deepEqual(r.relocationContainer, [id(2), id(3), id(5)].map(sha).sort(), "step 4 open, plan + step 4 finished - without back");
      const text = JSON.stringify(r);
      for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(!text.includes(id(n).slice(0, 12)), `container id ${n} in plain text`);
      for (const name of ["shop-db-1", "shop-web-1", "shop-worker-1", "old-db-1", "/relocation/"]) assert.ok(!text.includes(name), `${name} in the response`);
      free();
      assert.equal((await json(`${base}/api/runs/active`)).relocationsOpen, 2, "the heavy load is free");
    } finally {
      try { free(); } catch { /* already free */ }
      // Clean up so that quiet occurs at the end (an instance in `relocation` is open work).
      store.deleteProjectInstance("p-state", "main");
      store.endRelocation(j1.id, "aborted");
    }
    const afterwards = await json(`${base}/api/runs/active`);
    assert.equal(afterwards.relocationsOpen, 0);
    assert.deepEqual(afterwards.relocationContainer, [id(5)].map(sha), "only the finished journal of the converted project remains");
  });
});

// `relocationContainer` names only containers that a relocation really took over and that can still exist in B.
//   An OPEN journal with only a plan (before step 4) has stopped nothing yet - its containers belong to B, `restoreInner` must
//     start them again after a swap.
//   A FINISHED journal no longer names what step 15 removed (name in `report.remove.container`) - the list would otherwise grow
//     with every relocation by containers that no longer exist. A one-off container (`oneoff`) stays in B and stays in the list,
//     as does every one the report does not name as removed (labels did not match, an error).
// Counter-tests: runs/routes.js with the open journal counted with plan again => red (id(7)); the `removed` filter deleted =>
// red (id(8)).
test("relocationContainer: an open journal with only a plan names nothing; a finished one not what step 15 removed (one-off containers stay)", async () => {
  await withServer(async ({ base }) => {
    const id = (n) => crypto.createHash("sha256").update(`container-${n}`).digest("hex");
    const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
    const open = store.createRelocation({ projectId: "p-only-plan", location: "/relocation/7" });
    store.writeRelocation(open.id, { data: { plan: { container: [{ id: id(7), name: "plan-db-1" }] } } });
    const finished = store.createRelocation({ projectId: "p-removed", location: "/relocation/8" });
    const plan = [{ id: id(8), name: "way-web-1" }, { id: id(9), name: "once-run-1", oneoff: true }, { id: id(10), name: "foreign-1" }];
    store.writeRelocation(finished.id, { data: {
      plan: { container: plan },
      container: { list: plan, native: [] },
      report: { remove: { container: ["way-web-1"], not: ["Container once-run-1: one-off container, not transferred - stays", "Container foreign-1: labels no longer match"] } },
    } });
    store.endRelocation(finished.id, "finished");
    store.createProjectInstance({ projectId: "p-removed", state: "ready", convertedAt: Date.now() });
    try {
      const r = await json(`${base}/api/runs/active`);
      assert.deepEqual(r.relocationContainer, [id(9), id(10)].map(sha).sort(), "open with only a plan => nothing; finished => without the removed one, with the one-off container and the remaining one");
    } finally {
      store.endRelocation(open.id, "aborted");
    }
  });
});

// Agent communication: an outer-loop run is a core of its own WITHOUT journal - it holds the idle state (`busy`, list `outerLoop`),
// and its process carries NO workflow marker: the deploy's one-shot detection waits for it (MCP file
// `<chat>.outerloop-<agent>-<run>.mcp.json`, does not match WORKFLOW_AGENT_RE). Counter-test: runs/runtime-location.js
// agentMcpFileIn with `.workflow.mcp.json` for the outer loop => this test red.
const OL_IDENTIFIER_LINE = "OUTER-LOOP AGENT of cbase";
const olClaude = agentsClaude({ main: `
if (joined.includes(${JSON.stringify(OL_IDENTIFIER_LINE)})) {
  fs.writeFileSync(path.join(LOCATION, "argv-ol"), JSON.stringify({ argv, workflow: isWorkflowAgent }));
  await gate("ol");
  finished(); say({ type: "result", result: "Note", session_id: "ol-1" });
  return;
}
finished(); say({ type: "result", result: "finished", session_id: "main-session" });` });

test("an outer-loop run holds busy:true with the outerLoop list, and its process holds the deploy gate (no workflow agent)", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    store.addMessage(chat.id, "user", "Please rebuild the till.", 1000);
    const a = store.createOuterLoopAgent({ id: "c5000000-0000-4000-8000-000000000005", workspaceId: ws.id, name: "Watcher", trigger: [{ kind: "quiet", minutes: 5 }], provider: "claude", model: "claude-haiku-4-5-20251001" });
    store.setOuterLoopActive(a.id, chat.id, true, 0);
    const r = await startOuterLoopRun({ agent: a, chat, trigger: "quiet" });
    assert.equal(r.started, true, JSON.stringify(r));
    await ctx.gate.reached("ol");
    const isActive = await json(`${base}/api/runs/active`);
    assert.deepEqual([isActive.busy, isActive.runs, isActive.agents, isActive.outerLoop.map((x) => [x.runId, x.chatId, x.agentName])], [true, 0, [], [[r.runId, chat.id, "Watcher"]]], JSON.stringify(isActive));
    const k = t63CommandLine(root, "ol");
    assert.equal(k.workflow, false, "the fake did not run as a workflow agent");
    assert.match(k.cmd, new RegExp(`${chat.id}\\.outerloop-${a.id}-${r.runId}\\.mcp\\.json`), "the run's MCP file stands in the command line");
    const { holds, workflow } = partsProcesses([{ pid: 1, cmd: k.cmd }]);
    assert.deepEqual([holds.length, workflow.length], [1, 0], `an outer-loop run must not count as a workflow agent: ${k.cmd}`);
    ctx.gate.open("ol");
    await waitForTruthy(() => store.outerLoopRun(r.runId)?.state === "finished", "run finished");
    await ctx.waitForQuiet();
    assert.deepEqual((await json(`${base}/api/runs/active`)).outerLoop, []);
  }, { claude: olClaude });
});
