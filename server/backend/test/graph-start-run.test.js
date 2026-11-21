// Start after the turn, waiting queue, late start: a foreground start announced with /workflow: and earmarked via
// cbase_workflow_start begins after the CLEAN end of its turn (runs/do-run.js setTurnCompletion -> workflows/graph-start.js
// graphTurnCompletion) without that turn counting as a step; a stopped or failed turn discards it. With a taken lock it
// waits in the queue (`waiting_lock`) and starts as soon as the holder ends (waker) or the lock becomes free without a run
// end (tick). It survives a restart: exactly one run, even if the restart calls the tool once more.
//
// Main seam via `withAgentsServer`. The fake main agent stores every text under prompts.jsonl, calls `cbase_workflow_start`
// through the REAL cbase MCP server on "GS[<tag>]:{json}§" (result per call as a row under `gs-<tag>.jsonl`), dies with
// code 1 on "EXIT1", holds at the gate on "GATE:<x>" or "HALT:<x>" (in the text of a workflow step) and answers a workflow
// step with "ERLEDIGT …", everything else with "Started.".
//
// Counter-tests (which sabotage turns which test red; run with `--test-timeout=25000 --test-name-pattern=…`):
//   - drop `setTurnCompletion(graphTurnCompletion)` in server.js  => "Clean", "Lock", "Loop engine" and "Crash" hang waiting
//     for the run (the row stays `earmarked`), "Late start" stays green;
//   - drop the wrapper around the waker (only `scheduleTriggerDrain`)  => "Lock" hangs past the 25 s (the tick stands at its
//     default of 30 s there - "as soon as the holder ends" is carried only by the waker), "Tick" stays green;
//   - disable the tick in server.js  => "Tick" hangs, "Lock" stays green;
//   - drop `graphStartsRestartGrace()` in server.js  => "Late start" hangs, "Crash" stays green (there the end of the
//     restarted turn redeems).
// No deadline in the test itself (rule "no timers in tests"): a hang reports every 30 s what it waits for.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";
import { streams } from "../electron/server/runtime/sse.js";
import { runLockKey } from "../electron/server/workflows/run-state.js";
import { wakeGraphStarts, graphTurnCompletion } from "../electron/server/workflows/graph-start.js";

const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "prompts.jsonl"), JSON.stringify({ text }) + "\\n");
  const step = String(text).includes("[cbase workflow");
  const g = text.indexOf("GS[");
  if (g >= 0 && !step) {
    const gtag = text.slice(g + 3, text.indexOf("]:", g));
    const args = JSON.parse(text.slice(text.indexOf("]:", g) + 2, text.indexOf("§", g)));
    const id = "toolu_gs_" + gtag;
    say({ type: "assistant", message: { id: "a-" + gtag + "-" + turn, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_workflow_start", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_workflow_start", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); }
    catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.appendFileSync(path.join(LOCATION, "gs-" + gtag + ".jsonl"), JSON.stringify({ t }) + "\\n");
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  if (String(text).includes("EXIT1")) process.exit(1);
  const hold = (String(text).match(/HALT:(\\w+)/) || [])[1];
  // Only in a step: the announcement of the message route quotes the first step including "HALT:…".
  if (hold && step) await gate(hold);
  const wait = (String(text).match(/GATE:(\\w+)/) || [])[1];
  if (wait && !step) await gate(wait);
  finished();
  say({ type: "result", result: step ? "ERLEDIGT " + String(text).replace(/\\s+/g, " ").slice(0, 80) : "Started.", session_id: "s-main" });`;

const claude = fakeClaude({ main: MAIN });

async function raw(url, method = "GET", body = undefined) {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Connection: "close" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const send = (base, chatId, text) => raw(`${base}/api/chats/${chatId}/message`, "POST", { text });
const newChat = async (base, ws, title) => {
  const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({
    workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions",
  }) });
  // Titled: no title oneshot, and the name is that of the holder in the reason "wartet auf …".
  await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: title }) });
  return c;
};
// A workflow `s → n1 → e` without a closing gate (a verdict would be a oneshot that these fakes do not play).
function newWorkflow(ws, name, text = "WORK") {
  const now = Date.now();
  const w = store.createWorkflow({ id: crypto.randomUUID(), workspaceId: ws.id, name, createdAt: now, updatedAt: now, graph: {
    nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text }, { id: "e", type: "end", title: "End" }],
    edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
  } });
  return store.updateWorkflow(w.id, { run: { doneAll: false } });
}
// The results of cbase_workflow_start under a tag, in call order.
async function toolResults(root, tag, n = 1) {
  const file = path.join(root, `gs-${tag}.jsonl`);
  const rows = await waitForTruthy(() => { const z = readJsonl(file); return z.length >= n ? z : null; }, `tool result ${tag} (${n})`);
  return rows.map(({ t }) => {
    assert.ok(!t.startsWith("ERROR "), t);
    return JSON.parse(t);
  });
}
const rowInState = (startId, status) => waitForTruthy(() => { const z = store.graphStart(startId); return z?.status === status ? z : null; }, `row ${startId} -> ${status}`);
const runFinished = (runId) => waitForTruthy(() => { const r = store.getWorkflowRunById(runId); return r && !store.workflowOpen(r) ? r : null; }, `run ${runId} finished`);
const stepTexts = (runId) => store.listRunSteps(runId).filter((s) => s.kind === "step").map((s) => JSON.stringify(s.detail));

// The stream of a chat, recorded in-process (no open socket that the finally would have to close).
function stream(chatId) {
  const events = [];
  const reader = { write(row) { for (const z of String(row).split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* not JSON */ } } } };
  if (!streams.has(chatId)) streams.set(chatId, new Set());
  streams.get(chatId).add(reader);
  return { events, close: () => streams.get(chatId)?.delete(reader) };
}
const states = (events, startId) => events.filter((e) => e.type === "harness" && e.subtype === "graph_run" && e.run?.startId === startId).map((e) => e.run.state);

// ── Unit ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("graphTurnCompletion: null without an open start; parked stays; waiting_lock only after a clean turn", async () => {
  await withAgentsServer(async ({ base, ws }) => {
    const w = newWorkflow(ws, "Unit");
    const c = await newChat(base, ws, "Unit");
    const chat = store.getChat(c.id);
    assert.equal(graphTurnCompletion(chat, { clean: true }), null, "without an open start: nothing");
    const z = store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: c.id, workflowId: w.id, workflowName: w.name, shortName: "unit", status: "earmarked" });
    assert.equal(graphTurnCompletion(chat, { parked: true }), null);
    assert.equal(store.graphStart(z.id).status, "earmarked", "parked is like running - the continuation redeems");
    store.changeGraphStart(z.id, { status: "waiting_lock" });
    assert.equal(graphTurnCompletion(chat, { aborted: true }), null);
    assert.equal(graphTurnCompletion(chat, { clean: false }), null);
    assert.equal(store.graphStart(z.id).status, "waiting_lock", "a waiting row is not discarded by a turn end");
    store.changeGraphStart(z.id, { status: "dismissed" });
  }, { claude });
});

// ── Turn end ────────────────────────────────────────────────────────────────────────────────────────────────────

test("clean: the workflow begins after the turn, the start turn is no step; the attachments go along", async () => {
  await withAgentsServer(async ({ base, ws, chat, root, waitForQuiet }) => {
    const w = newWorkflow(ws, "Golden Graph", "STEP ONE");
    const s = stream(chat.id);
    try {
      const r = await send(base, chat.id, `/workflow:golden-graph please go GS[a]:{"workflow":"golden-graph","input":"please go"}§`);
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const [e] = await toolResults(root, "a");
      const z = await rowInState(e.start.startId, "started");
      assert.ok(z.runId, "run_id set");
      assert.equal(store.getWorkflowRunById(z.runId).workflowId, w.id);
      const run = await runFinished(z.runId);
      assert.equal(run.status, "done", run.note);
      const [step, ...more] = stepTexts(z.runId);
      assert.deepEqual(more, [], "exactly ONE step - the start turn does not count");
      assert.match(step, /STEP ONE/);
      assert.match(step, /please go/, "the input of the tool is the input of the run");
      assert.doesNotMatch(step, /Started\./);
      await waitForQuiet();
      const followUp = states(s.events, z.id);
      assert.equal(followUp[0], "earmarked");
      assert.ok(followUp.includes("running"), `events: ${followUp.join(" → ")}`);
      assert.equal(store.graphStart(z.id).status, "started");
    } finally { s.close(); }
  }, { claude });
});

test("stopped turn and error exit discard the earmarked start - no run comes into being", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, waitForIdle }) => {
    newWorkflow(ws, "Ship");
    const a = await newChat(base, ws, "Stop");
    await send(base, a.id, `/workflow:ship GS[s]:{"workflow":"ship","input":"x"}§ GATE:s`);
    const [es] = await toolResults(root, "s");
    await gate.reached("s");
    assert.equal((await raw(`${base}/api/chats/${a.id}/stop`, "POST")).status, 200);
    const zs = await rowInState(es.start.startId, "dismissed");
    assert.match(zs.reason, /Der Turn wurde gestoppt — „Ship“ startet nicht\./);
    // A fresh chat (without session): an exit without result would otherwise be the resume retry of the same turn.
    const b = await newChat(base, ws, "Error");
    await send(base, b.id, `/workflow:ship GS[f]:{"workflow":"ship","input":"y"}§ EXIT1`);
    const [ef] = await toolResults(root, "f");
    const zf = await rowInState(ef.start.startId, "dismissed");
    assert.match(zf.reason, /Der Turn endete mit einem Fehler — „Ship“ startet nicht\./);
    await waitForIdle();
    assert.deepEqual(store.listWorkflowRuns({ chatId: a.id }), []);
    assert.deepEqual(store.listWorkflowRuns({ chatId: b.id }), []);
  }, { claude });
});

// ── Waiting queue ───────────────────────────────────────────────────────────────────────────────────────────────────

test("lock: the start waits for the holder (waiting_lock, reason, key) and begins as soon as its run ends (waker)", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, waitForQuiet }) => {
    const w = newWorkflow(ws, "Rebuild", "REBUILD HALT:h");
    const holders = await newChat(base, ws, "Holder Chat");
    const a = await newChat(base, ws, "Waiter");
    const s = stream(a.id);
    try {
      // The holder starts by hand - its step stands at the gate, its run holds the lock of the workspace.
      const h = await raw(`${base}/api/chats/${holders.id}/workflow`, "POST", { workflowId: w.id });
      assert.equal(h.status, 202, JSON.stringify(h.body));
      await gate.reached("h");
      await send(base, a.id, `/workflow:rebuild GS[w]:{"workflow":"rebuild","input":"afterwards"}§`);
      const [e] = await toolResults(root, "w");
      const z = await rowInState(e.start.startId, "waiting_lock");
      assert.equal(z.reason, "wartet auf „Holder Chat“");
      assert.equal(z.lockKey, runLockKey(w, store.getChat(a.id)));
      assert.ok(!store.getWorkflowRun(a.id), "no run in the waiting chat yet");
      // The holder ends: its run end wakes the queue.
      gate.open("h");
      await runFinished(h.body.run.id);
      const started = await rowInState(z.id, "started");
      const run = await runFinished(started.runId);
      assert.equal(run.status, "done", run.note);
      assert.equal(started.reason, "", "the reason for waiting is gone");
      await waitForQuiet();
      const followUp = states(s.events, z.id);
      assert.deepEqual(followUp.slice(0, 2), ["earmarked", "waiting_lock"], followUp.join(" → "));
      assert.ok(followUp.includes("running"), followUp.join(" → "));
    } finally { s.close(); }
  }, { claude });
});

test("tick: a lock that becomes free without a run end (holder chat deleted) wakes the queue at the next tick; a stopped waiting row never starts", async () => {
  const prior = process.env.CBASE_GRAPH_TICK_MS;
  process.env.CBASE_GRAPH_TICK_MS = "200";
  try {
    await withAgentsServer(async ({ base, ws, root, waitForQuiet }) => {
      const w = newWorkflow(ws, "Rebuild");
      const holders = await newChat(base, ws, "Holder Chat");
      // An open run with a lock without a driver - it never ends by itself, only with its chat.
      const hRun = store.startWorkflowRun({ id: crypto.randomUUID(), chatId: holders.id, workflowId: w.id, workflowName: w.name, workspaceId: ws.id });
      assert.equal(store.acquireLock(runLockKey(w, store.getChat(holders.id)), { runId: hRun.id, chatId: holders.id, workflowId: w.id, workflowName: w.name, workspaceId: ws.id }).ok, true);
      const a = await newChat(base, ws, "A");
      const b = await newChat(base, ws, "B");
      await send(base, a.id, `/workflow:rebuild GS[a]:{"workflow":"rebuild","input":"A"}§`);
      await send(base, b.id, `/workflow:rebuild GS[b]:{"workflow":"rebuild","input":"B"}§`);
      const [ea] = await toolResults(root, "a");
      const [eb] = await toolResults(root, "b");
      await rowInState(ea.start.startId, "waiting_lock");
      await rowInState(eb.start.startId, "waiting_lock");
      // Stop of a waiting row (route): it leaves the queue.
      const st = await raw(`${base}/api/chats/${b.id}/graph-workflows/${encodeURIComponent(eb.start.startId)}/stop`, "POST", { from: "human" });
      assert.equal(st.status, 200, JSON.stringify(st.body));
      assert.equal(st.body.run.state, "stopped");
      // The holder falls with its chat (abandonWorkflowRuns: lock gone, NO emitWorkflowRun - so no waker).
      assert.equal((await raw(`${base}/api/chats/${holders.id}`, "DELETE")).status, 200);
      const za = await rowInState(ea.start.startId, "started");
      assert.equal((await runFinished(za.runId)).status, "done");
      await waitForQuiet();
      wakeGraphStarts(); // once more by hand: a stopped row is not in the queue
      assert.equal(store.graphStart(eb.start.startId).status, "stopped");
      assert.deepEqual(store.listWorkflowRuns({ chatId: b.id }), []);
    }, { claude });
  } finally {
    if (prior === undefined) delete process.env.CBASE_GRAPH_TICK_MS;
    else process.env.CBASE_GRAPH_TICK_MS = prior;
  }
});

// ── Loop engine ────────────────────────────────────────────────────────────────────────────────────────────

const last = (b) => (b.messages || []).at(-1) || {};
const content = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
const engine = {
  round: (b) => {
    const m = last(b);
    if (m.role === "tool") return { text: "Started." };
    if (m.role === "user" && content(m).includes("[cbase workflow")) return { text: "ERLEDIGT ENGINE-STEP" };
    return { toolCalls: [{ id: "call_gs", name: "mcp__cbase__cbase_workflow_start", arguments: { workflow: "engine-graph", input: "by engine" } }] };
  },
};

test("loop engine: the start tool runs at the server, the workflow begins after the turn", async () => {
  await withAgentsServer(async ({ base, ws, engine: e, waitForQuiet }) => {
    newWorkflow(ws, "Engine Graph", "ENGINE WORK");
    const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: e.id, model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Engine" }) });
    const r = await send(base, c.id, "/workflow:engine-graph please");
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const z = await waitForTruthy(() => store.graphStartsOf(c.id).find((x) => x.status === "started") || null, "start via the engine");
    assert.equal(z.input, "by engine");
    const run = await runFinished(z.runId);
    assert.equal(run.status, "done", run.note);
    assert.equal(stepTexts(z.runId).length, 1);
    assert.match(stepTexts(z.runId)[0], /ENGINE WORK/);
    await waitForQuiet();
  }, { claude, engine });
});

// ── Restart ────────────────────────────────────────────────────────────────────────────────────────────────

test("crash between call and turn end: the restart calls the tool once more (already), exactly ONE run comes into being", async () => {
  await withAgentsServer(async ({ base, ws, root, gate, crash, db }) => {
    const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name: "After Crash" }) });
    await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ run: { doneAll: false }, graph: {
      nodes: [{ id: "s", type: "start", title: "Start" }, { id: "n1", type: "instruction", title: "Step", text: "AFTER THE CRASH" }, { id: "e", type: "end", title: "End" }],
      edges: [{ from: "s", to: "n1" }, { from: "n1", to: "e" }],
    } }) });
    const c = await newChat(base, ws, "Crash");
    await send(base, c.id, `/workflow:after-crash GS[k]:{"workflow":"after-crash","input":"one"}§ GATE:k`);
    const [first] = await toolResults(root, "k");
    await gate.reached("k");
    assert.equal(first.start.state, "earmarked");
    await crash();
    // The restart (CBASE_RESTART_GRACE_MS=0) runs the same turn with its announcement once more - the gate is open.
    gate.open("k");
    const [, second] = await toolResults(root, "k", 2);
    assert.equal(second.already, true, JSON.stringify(second));
    assert.equal(second.start.startId, first.start.startId);
    const read = db();
    try {
      const row = await waitForTruthy(() => {
        const z = read.prepare("SELECT status, run_id FROM graph_starts WHERE id = ?").get(first.start.startId);
        return z?.status === "started" ? z : null;
      }, "row started after the crash");
      await waitForTruthy(() => read.prepare("SELECT status FROM workflow_runs WHERE id = ?").get(row.run_id)?.status === "done", "run done");
      assert.equal(read.prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE chat_id = ?").get(c.id).n, 1, "exactly one run");
      assert.equal(read.prepare("SELECT COUNT(*) AS n FROM graph_starts WHERE chat_id = ?").get(c.id).n, 1, "exactly one row");
    } finally { read.close(); }
    await waitForTruthy(async () => (await json(`${base}/api/runs/active`)).quiet, "quiet after the crash");
  }, { claude, childProcess: true });
});

test("late start: an earmarked row without a turn is redeemed after the restart", async () => {
  await withAgentsServer(async ({ ws, chat, restart, waitForQuiet }) => {
    const w = newWorkflow(ws, "Late Start", "AFTER THE RESTART");
    const z = store.createGraphStart({ id: `gs-${crypto.randomUUID()}`, chatId: chat.id, workflowId: w.id, workflowName: w.name,
      shortName: "restartGrace", input: "further", status: "earmarked" });
    // The late-start timer runs at once (the harness otherwise sets it to a day; it resets the variable at the end).
    process.env.CBASE_RESTART_GRACE_MS = "0";
    await restart();
    const g = await rowInState(z.id, "started");
    const run = await runFinished(g.runId);
    assert.equal(run.status, "done", run.note);
    assert.match(stepTexts(g.runId)[0], /AFTER THE RESTART/);
    await waitForQuiet();
  }, { claude });
});
