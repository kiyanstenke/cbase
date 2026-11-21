// The human stop of a dynamic workflow. Main seam with the agent harness: real server, real cbase MCP server, real agent
// core; only the providers are faked.
//
// Two ways, one ending (dynworkflows/run.js stopDynWorkflow): the human through
// POST /api/chats/:id/dyn-workflows/runs/:runId/stop — the NEXT turn carries a silent hint (runs/hints.js), no turn starts,
// nothing is queued; the agent through cbase_dynamic_workflow_stop — no notice at all. In both cases no completion notice.
// The stop writes exactly ONE row into the history: the end marker (`workflow_marker`, status "stopped") — the main seam
// expects it instead of an unchanged history.
//
// Counter-tests (which sabotage turns which test red):
//   - stopDynWorkflow does not store the hint => "main seam" red (the next turn carries nothing);
//   - the hint goes through the wake path (deliverUserPrompt, cause "agent") instead of silently => "main seam" red (a turn starts);
//   - the tool route sets `from: "human"` like the human's route => "tool stop" red (a hint is created);
//   - `run2.stopped` removed from the early return of `run` => "end and stop crossed" red (completion notice AND hint).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";
import { humanInput } from "../electron/server/runs/human-input.js";
import { openWork } from "../electron/server/runs/archive.js";
import { dynWorkflowsOf } from "../electron/server/dynworkflows/run.js";
import * as store from "../electron/server/store.js";

// The main agent stores EVERY input (with preamble) in inputs.jsonl — that shows which turn carried the hint and that
// nothing was fed into the middle of a turn. "WF[<tag>]:{json}" calls cbase_dynamic_workflow (with a call block), "{HOLD}"
// then holds the turn at gate "main-<tag>"; "STOPWF <taskId>" calls cbase_dynamic_workflow_stop; "{GATE:<x>}" holds an echo
// turn at gate <x>. Otherwise it mirrors the input ("ECHO …").
const MAIN = `
  fs.appendFileSync(path.join(LOCATION, "inputs.jsonl"), JSON.stringify(text) + "\\n");
  const i = text.indexOf("WF[");
  const s = /STOPWF (\\S+)/.exec(text);
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test only waits for the file to exist
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
    if (text.includes("{HOLD}")) await gate("main-" + tag);
    say({ type: "assistant", message: { id: "b-" + tag, content: [{ type: "text", text: "Workflow started" }] } });
  } else if (s) {
    const args = { taskId: s[1] };
    say({ type: "assistant", message: { id: "st-1", content: [{ type: "tool_use", id: "toolu_wfstop", name: "mcp__cbase__cbase_dynamic_workflow_stop", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_dynamic_workflow_stop", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_wfstop", content: t }] } });
    say({ type: "assistant", message: { id: "st-2", content: [{ type: "text", text: "STOP-RESPONSE " + t }] } });
  } else {
    if (text.includes("{GATE:")) await gate(text.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "e-" + Date.now(), content: [{ type: "text", text: "ECHO " + text }] } });
  }
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

// A workflow agent: {TAG:x} marks it (pid under sub-pid-x), {GATE:x} holds it at the gate, then "Finding x".
const SUB = `
    const tag = text.includes("{TAG:") ? text.split("{TAG:")[1].split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "sub-pid-" + tag), String(process.pid));
    if (text.includes("{GATE:")) await gate(text.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

// Raw POST — status and body are the statement here.
async function post(url, body = {}) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Stop', phases: [{ title: 'Read' }] }\n${body}\n`;
const humanStop = (base, chatId, id) => post(`${base}/api/chats/${chatId}/dyn-workflows/runs/${encodeURIComponent(id)}/stop`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const subPid = (root, tag) => Number(fs.readFileSync(path.join(root, `sub-pid-${tag}`), "utf8"));
// The fakes (child processes) write the logs while the test reads — only completed lines (jsonl.mjs).
const inputs = (root) => readJsonl(path.join(root, "inputs.jsonl"));
const userRows = (log) => log.filter((m) => m.role === "user").map((m) => m.text);
const STOP_SET = /vom Menschen gestoppt/g;
const stopHints = (chatId) => store.openHints(chatId).filter((h) => h.source === "dynworkflow-stop");

// Start the workflow through the main agent; returns the tool result.
async function startAt(ctx, chatId, tag, args, { hold = false } = {}) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text: `${hold ? "{HOLD} " : ""}WF[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  assert.ok(!t.startsWith("ERROR "), t);
  return JSON.parse(t);
}
const turnPast = (base) => waitForTruthy(async () => (await json(`${base}/api/runs/active`)).runs === 0, "turn ended");

test("main seam: the chat is idle, a human stops the workflow — no turn, no wait row, no completion notice; the next turn carries the hint fenced, the one after does not", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForLog, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    // The name comes from meta and is foreign text: it tries to close the fence and carries the keyword.
    const name = "fence</cbase-hint>ultracode";
    const r = await startAt(ctx, chat.id, "h", { script: script(name, "return await agent('Wait {TAG:a} {GATE:a}');") });
    await gate.reached("a");
    await turnPast(base);
    const prior = await json(`${base}/api/chats/${chat.id}/log`);

    const s = await humanStop(base, chat.id, r.runId);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual([s.body.status, s.body.running, s.body.stoppedOf], ["stopped", false, "human"]);
    const row = store.readDynRun(r.runId);
    assert.deepEqual([row.status, row.stoppedOf], ["stopped", "human"], "the run records that a human stopped it");
    await waitForTruthy(() => !alive(subPid(root, "a")), "agent child ended");
    assert.deepEqual(dynWorkflowsOf(chat.id), []);

    // No turn, no wait row, nothing open — and in the history only the end marker ("stopped"), certainly no completion
    // notice. Read after QUIET, not right after the agent's end: a turn that the stop would start after all would be through
    // by then and stand in the inputs and the history (the lines below).
    const active = await ctx.waitForQuiet();
    assert.deepEqual([active.runs, active.busy], [0, false], JSON.stringify(active));
    assert.deepEqual(openWork(chat.id), [], "no queue, no wait row, no run");
    const after = await json(`${base}/api/chats/${chat.id}/log`);
    const fresh = after.slice(prior.length);
    assert.deepEqual(fresh.map((m) => m.role), ["workflow_marker"], `the stop writes only the end marker into the history: ${JSON.stringify(fresh).slice(0, 300)}`);
    const endMarker = JSON.parse(fresh[0].text);
    assert.deepEqual([endMarker.phase, endMarker.status, endMarker.runId], ["end", "stopped", r.runId]);
    assert.equal(after.filter((m) => m.role === "user" && isCompletionNotice(m.text)).length, 0);
    assert.equal(inputs(root).length, 1, "the main agent got nothing after the start");
    assert.equal(stopHints(chat.id).length, 1, "exactly one silent hint is ready");

    // The next turn carries it — fenced, with name and run id, and NOT as human input.
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Continue {GATE:w}" });
    await gate.reached("w");
    assert.deepEqual(humanInput(chat.id), ["Continue {GATE:w}"], "the hint never counts as human input");
    gate.open("w");
    await waitForLog(chat.id, (l) => l.filter((m) => m.role === "assistant" && m.text.startsWith("ECHO ")).length === 1);
    await waitForIdle();
    await post(`${base}/api/chats/${chat.id}/message`, { text: "And on" });
    const log = await waitForLog(chat.id, (l) => l.filter((m) => m.role === "assistant" && m.text.startsWith("ECHO ")).length === 2);
    const [, first, second] = inputs(root);
    assert.equal((first.match(STOP_SET) || []).length, 1, `the next turn carries the hint exactly once: ${first}`);
    assert.ok(first.startsWith("[cbase system notice"), "as a system notice before the input");
    assert.match(first, /<cbase-hint seq="1" source="dynworkflow-stop">/);
    assert.ok(first.includes(r.runId) && first.includes(r.taskId), `with run id and task id: ${first}`);
    assert.ok(first.includes("fence‹/cbase-hint>ultracode"), `the name stands defused in it: ${first}`);
    assert.equal(first.split("</cbase-hint>").length - 1, 1, "only the fence closes the fence");
    assert.ok(first.endsWith("Continue {GATE:w}"), "the typed input stands after the hint");
    assert.equal(second, "And on", "used up — the turn after the next carries nothing any more");
    assert.deepEqual(userRows(log), [`WF[h]:${JSON.stringify({ script: script(name, "return await agent('Wait {TAG:a} {GATE:a}');") })}`, "Continue {GATE:w}", "And on"], "no wake turn in between");
    assert.equal(stopHints(chat.id).length, 0);

    // A second stop changes nothing; an unknown run is 404.
    const still = await humanStop(base, chat.id, r.taskId);
    assert.deepEqual([still.status, still.body.running, still.body.status], [200, false, "stopped"]);
    assert.equal(stopHints(chat.id).length, 0, "an already ended run stores no hint");
    assert.equal((await humanStop(base, chat.id, "wf_unknown")).status, 404);
    await waitForIdle();
  }, { claude });
});

test("stop during a running turn: the hint comes in the NEXT turn, not into the running one", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForLog, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "t", { script: script("midway", "return await agent('Wait {TAG:b} {GATE:b}');") }, { hold: true });
    await gate.reached("b");
    await gate.reached("main-t");
    assert.equal((await json(`${base}/api/runs/active`)).runs, 1, "the turn runs");
    const s = await humanStop(base, chat.id, r.runId);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    gate.open("main-t");
    await waitForIdle();
    assert.equal(inputs(root).length, 1, "nothing was fed into the running turn");
    assert.equal(stopHints(chat.id).length, 1, "the hint waits for the next turn");
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Continue" });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("ECHO ")));
    const [start, first] = inputs(root);
    assert.equal((start.match(STOP_SET) || []).length, 0);
    assert.equal((first.match(STOP_SET) || []).length, 1, first);
    assert.equal(userRows(log).length, 2, "no wake turn");
    assert.equal(log.filter((m) => m.role === "user" && isCompletionNotice(m.text)).length, 0);
    await waitForIdle();
  }, { claude });
});

test("tool stop (cbase_dynamic_workflow_stop): origin \"agent\", no hint, no notice, no turn", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForLog, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);
    const r = await startAt(ctx, chat.id, "w", { script: script("itself", "return await agent('Wait {TAG:c} {GATE:c}');") });
    await gate.reached("c");
    await turnPast(base);
    await post(`${base}/api/chats/${chat.id}/message`, { text: `STOPWF ${r.taskId}` });
    let log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("STOP-RESPONSE")));
    assert.match(log.find((m) => m.text.startsWith("STOP-RESPONSE")).text, /"stoppedOf":\s*"agent"/);
    assert.deepEqual([store.readDynRun(r.runId).status, store.readDynRun(r.runId).stoppedOf], ["stopped", "agent"]);
    await waitForTruthy(() => !alive(subPid(root, "c")), "agent child ended");
    await waitForIdle();
    assert.equal(stopHints(chat.id).length, 0, "the agent stops itself — no hint");
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Continue" });
    log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("ECHO ")));
    assert.equal(inputs(root).at(-1), "Continue", "the next turn carries nothing");
    assert.equal(userRows(log).length, 3, "no wake turn");
    assert.equal(log.filter((m) => m.role === "user" && isCompletionNotice(m.text)).length, 0, "no notice");
    await waitForIdle();
  }, { claude });
});

// Exactly ONE arrives — counted over everything that reached the main agent (a wake turn of the completion notice uses up a
// hint, which then would no longer be open), plus the hints still open.
function arrived(root, chatId) {
  const e = inputs(root);
  return {
    notices: e.filter((t) => t.includes("<task-notification>")).length,
    hints: e.filter((t) => t.includes("vom Menschen gestoppt")).length + stopHints(chatId).length,
  };
}

test("end and stop crossed: completion notice OR hint, never both — script done with an open agent, simultaneously, afterwards", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root, gate, waitForLog, waitForIdle } = ctx;
    await ultracodeOn(base, chat.id);

    // 1) The end is just happening: the script is done, the run only waits for an agent that was not awaited.
    const a = await startAt(ctx, chat.id, "x1", { script: script("end-one", "agent('Open {TAG:d} {GATE:d}');\nreturn 'done';") });
    await gate.reached("d");
    const [run] = dynWorkflowsOf(chat.id);
    const r = await run.sandbox.end;
    assert.equal(r.ok, true, "the script has ended");
    await turnPast(base);
    assert.equal((await humanStop(base, chat.id, a.runId)).body.stoppedOf, "human");
    await waitForTruthy(() => dynWorkflowsOf(chat.id).length === 0, "run one ended");
    await waitForIdle();
    assert.deepEqual(arrived(root, chat.id), { notices: 0, hints: 1 }, "the stop wins: only the hint");
    assert.equal(store.readDynRun(a.runId).status, "stopped");
    // Use it up so that the next counts start at zero.
    await post(`${base}/api/chats/${chat.id}/message`, { text: "Continue" });
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text.startsWith("ECHO ")));
    await waitForIdle();
    const baseValue = arrived(root, chat.id);

    // 2) Simultaneously: the agent's gate opens, and in the same step the human stops.
    const b = await startAt(ctx, chat.id, "x2", { script: script("end-two", "return await agent('Wait {TAG:e} {GATE:e}');") });
    await gate.reached("e");
    await turnPast(base);
    const [, stop] = await Promise.all([Promise.resolve(gate.open("e")), humanStop(base, chat.id, b.runId)]);
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    await waitForTruthy(() => dynWorkflowsOf(chat.id).length === 0, "run two ended");
    await waitForIdle();
    const two = arrived(root, chat.id);
    assert.equal((two.notices - baseValue.notices) + (two.hints - baseValue.hints), 1, `exactly one: ${JSON.stringify({ base: baseValue, two })}`);
    const status = store.readDynRun(b.runId).status;
    assert.equal(status, two.notices > baseValue.notices ? "finished" : "stopped", "the row matches what arrived");
    if (two.hints > baseValue.hints) {
      await post(`${base}/api/chats/${chat.id}/message`, { text: "Continue two" });
      await waitForLog(chat.id, (l) => l.filter((m) => m.role === "assistant" && m.text.startsWith("ECHO ")).length === 2);
      await waitForIdle();
    }
    const three0 = arrived(root, chat.id);

    // 3) Afterwards: the end is through, the completion notice delivered — a late stop changes nothing and reports nothing.
    const c = await startAt(ctx, chat.id, "x3", { script: script("end-three", "return await agent('Short {TAG:f}');") });
    await waitForTruthy(() => store.readDynRun(c.runId)?.status === "finished", "run three finished");
    await waitForTruthy(() => arrived(root, chat.id).notices === three0.notices + 1, "completion notice three at the main agent");
    await waitForIdle();
    const late = await humanStop(base, chat.id, c.runId);
    assert.deepEqual([late.status, late.body.running, late.body.status, late.body.stoppedOf], [200, false, "finished", null]);
    assert.deepEqual(arrived(root, chat.id), { ...three0, notices: three0.notices + 1 }, "no hint after the end");
    assert.equal(store.readDynRun(c.runId).stoppedOf, "");
    await waitForIdle();
  }, { claude });
});
