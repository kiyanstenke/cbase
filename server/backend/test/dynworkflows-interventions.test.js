// Skipping and restarting per workflow agent at the main seam, real server, real cbase MCP server, real agent core, only the
// providers faked (harness of agent-harness.mjs). The two manual actions go through the routes
// `POST /api/chats/:id/dyn-workflows/runs/:runId/agents/:n/skip` and `…/restart` (dynworkflows/routes.js) to run.js
// skipDynAgent/restartDynAgent and from there to the core of the run.
//
// No test waits for the thing under test itself: after the action it opens ALL gates; without effect the agent would run to
// the end and the test would turn red (at the result) instead of hanging.
//
// COUNTER-TESTS (each turns the named test red):
//   - routes.js does not pass `skip` on to the runtime (answers only `{ok:true}`) => "skipping" red at the answer; run.js
//     skipDynAgent not calling the core (`ctl.stop` removed, answer unchanged) => red at the result (B delivers
//     "Finding b v1" instead of null);
//   - run.js restartDynAgent not calling the core (the restart call removed) => "restart" red (the script gets "v1");
//   - run.js without the explicit flag (`e.skipped` removed, the flag again follows only "stopped" and the reason the report)
//     => "skipping" red at the log() line ("returned null — skipped by the user").
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { readJsonl } from "./jsonl.mjs";
import * as store from "../electron/server/store.js";

process.env.CBASE_DYNWF_STAGGER_MS = "0";

const MAIN = `
  if (text.startsWith("<task-notification>")) {
    say({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  const i = text.indexOf("WF[");
  if (i >= 0) {
    const tag = text.slice(i + 3, text.indexOf("]:", i));
    const args = JSON.parse(text.slice(text.indexOf("]:", i) + 2));
    const id = "toolu_wf_" + tag;
    say({ type: "assistant", message: { id: "a-" + tag, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_dynamic_workflow", input: args }] } });
    let t = "";
    try { const r = await mcpCall("cbase_dynamic_workflow", args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "wf-" + tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); } // atomic: the test waits only for the existence
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "done" }] } });
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;

// The prompt log of the fake CLI: every spawn of a workflow agent appends its task to `tasks-<tag>`; the number of lines
// is the attempt. {GATE:x} holds ONLY the first attempt at the gate.
const SUB = `
    const start = text.lastIndexOf("Here is the task:");
    const job = start >= 0 ? text.slice(start) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    const log = path.join(LOCATION, "tasks-" + tag);
    fs.appendFileSync(log, JSON.stringify(job) + "\\n");
    const attempt = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;
    say({ type: "assistant", message: { id: "s1-" + tag + attempt, content: [{ type: "text", text: "Interim " + tag + " v" + attempt }] } });
    if (job.includes("{GATE:") && attempt === 1) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s2-" + tag + attempt, content: [{ type: "text", text: "Finding " + tag + " v" + attempt }] } });
    finished();
    say({ type: "result", result: "Finding " + tag + " v" + attempt, session_id: "sub-" + tag + attempt });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });
const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
async function raw(url, body) {
  const res = await fetch(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", Connection: "close" } });
  let b = null;
  try { b = await res.json(); } catch { /* no JSON */ }
  return { status: res.status, body: b };
}

async function startWf(ctx, tag, script) {
  await post(`${ctx.base}/api/chats/${ctx.chat.id}/message`, { text: `WF[${tag}]:${JSON.stringify({ script })}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(r.status, "started", JSON.stringify(r));
  return r;
}
const ultracode = (ctx) => json(`${ctx.base}/api/chats/${ctx.chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const intervention = (ctx, runId, n, kind) => raw(`${ctx.base}/api/chats/${ctx.chat.id}/dyn-workflows/runs/${encodeURIComponent(runId)}/agents/${n}/${kind}`);
const journalHas = (runId, check, what) => waitForTruthy(() => check(store.readDynJournal(runId)), what);
const has = (j, n, kind) => j.some((e) => e.n === n && e.kind === kind);
const agentIdOf = (runId, n) => store.readDynJournal(runId).find((e) => e.n === n && e.kind === "started")?.agentId;
const pidAtGate = (ctx, name) => Number(fs.readFileSync(path.join(ctx.root, "gates", `${name}.waiting`), "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The fake (a child process) writes tasks-<tag>: only completed lines (jsonl.mjs).
const jobs = (ctx, tag) => readJsonl(path.join(ctx.root, `tasks-${tag}`));
const treeOf = async (ctx, runId) => (await json(`${ctx.base}/api/chats/${ctx.chat.id}/dyn-workflows/tree`)).runs.find((b) => b.runId === runId);
const cbHints = (chatId) => store.openHints(chatId).filter((h) => /dynworkflow|agent/.test(String(h.source || "")));

test("skipping (main seam): the agent ends, agent() yields null, in parallel only ITS slot; journal failed with flag, tree \"skipped\", log() names it, no hint to the main agent, and the run runs to the end", async () => {
  await withAgentsServer(async (ctx) => {
    const { chat, gate } = ctx;
    await ultracode(ctx);
    const script = [
      "export const meta = { name: 'skip', description: 'Skipping', phases: [{ title: 'One' }, { title: 'Two' }] }",
      "phase('One')",
      "const r = await parallel([",
      "  () => agent('A {TAG:a} {GATE:a}', { label: 'A' }),",
      "  () => agent('B {TAG:b} {GATE:b}', { label: 'B' }),",
      "  () => agent('C {TAG:c} {GATE:c}', { label: 'C' }),",
      "])",
      "phase('Two')",
      "const d = await agent('D {TAG:d}', { label: 'D' })",
      "return { r, d }",
    ].join("\n");
    const wf = await startWf(ctx, "s1", script);
    await Promise.all(["a", "b", "c"].map((t) => gate.reached(t)));
    await journalHas(wf.runId, (j) => [1, 2, 3].every((n) => has(j, n, "started")), "A, B, C started");
    const pidB = pidAtGate(ctx, "b");
    const idB = agentIdOf(wf.runId, 2);

    const r = await intervention(ctx, wf.runId, 2, "skip");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, runId: wf.runId, n: 2, agentId: idB, status: "skipped" });
    // All gates open: without effect B would run to the end and deliver "Finding b v1".
    for (const t of ["a", "b", "c"]) gate.open(t);
    await waitForTruthy(() => store.readDynRun(wf.runId)?.status !== "running", "run finished");
    const row = store.readDynRun(wf.runId);
    assert.equal(row.status, "finished", row.error);
    assert.deepEqual(row.returnValue, { r: ["Finding a v1", null, "Finding c v1"], d: "Finding d v1" },
      "parallel does not throw: the skipped slot is null, the others carry their result, and the run goes on");
    await waitForTruthy(() => !alive(pidB), "the fake CLI child of B has ended");

    const j = store.readDynJournal(wf.runId).filter((e) => e.n === 2);
    assert.deepEqual(j.map((e) => e.kind), ["launched", "started", "failed"], "in the journal skipping counts as failed");
    assert.equal(j[2].skipped, true, "with the flag of the action");
    const b = await treeOf(ctx, wf.runId);
    assert.deepEqual(b.agents.map((a) => [a.label, a.status]), [["A", "finished"], ["B", "skipped"], ["C", "finished"], ["D", "finished"]]);
    const logs = store.readDynEvents(wf.runId).filter((e) => e.kind === "log").map((e) => e.text);
    assert.deepEqual(logs, [`agent “B” (${idB}) returned null — skipped by the user`], "log() names the skipped agent in the wording of the original");
    assert.deepEqual(cbHints(chat.id), [], "skipping is no human stop of the workflow: no silent hint");
    assert.equal(row.stoppedOf, "", "the run is not stopped");

    // A second time does not work: the agent no longer runs.
    const again = await intervention(ctx, wf.runId, 2, "skip");
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, "run-closed", "the run is over");
    await ctx.waitForIdle();
  }, { claude });
});

test("restart: the running attempt ends, a SECOND spawn with the same task; the script gets its result, that of the first goes nowhere; journal and tree show the restart", async () => {
  await withAgentsServer(async (ctx) => {
    const { gate } = ctx;
    await ultracode(ctx);
    const script = "export const meta = { name: 'again', description: 'Restart' }\nconst a = await agent('A {TAG:n} {GATE:n}', { label: 'Worker' })\nreturn a";
    const wf = await startWf(ctx, "n1", script);
    await gate.reached("n");
    await journalHas(wf.runId, (j) => has(j, 1, "started"), "Worker started");
    const pid1 = pidAtGate(ctx, "n");
    const id = agentIdOf(wf.runId, 1);

    const r = await intervention(ctx, wf.runId, 1, "restart");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, runId: wf.runId, n: 1, agentId: id, restart: true });
    gate.open("n"); // without effect the first attempt would now run to the end ("Finding n v1")
    await waitForTruthy(() => store.readDynRun(wf.runId)?.status !== "running", "run finished");
    const row = store.readDynRun(wf.runId);
    assert.equal(row.status, "finished", row.error);
    assert.equal(row.returnValue, "Finding n v2", "the script gets the result of the NEW attempt");
    const a = jobs(ctx, "n");
    assert.equal(a.length, 2, "exactly one second spawn");
    assert.equal(a[1], a[0], "with the same task");
    assert.equal(alive(pid1), false, "the first attempt has ended");

    const j = store.readDynJournal(wf.runId);
    assert.deepEqual(j.map((e) => e.kind), ["launched", "started", "restart", "result"], "one agent() call, one restart, one result");
    assert.equal(j[2].from, "human");
    assert.equal(j[2].agentId, id);
    assert.equal(j[3].value, "Finding n v2");
    assert.ok(!JSON.stringify({ j, returnValue: row.returnValue }).includes("Finding n v1"), "the result of the first attempt is nowhere");
    const b = await treeOf(ctx, wf.runId);
    assert.deepEqual(b.agents.map((x) => [x.label, x.status, x.restarts]), [["Worker", "finished", 1]]);
    assert.deepEqual(cbHints(ctx.chat.id), [], "the restart deposits no hint either");

    const late = await intervention(ctx, wf.runId, 1, "restart");
    assert.equal(late.status, 409, "a finished run restarts no agent");
    await ctx.waitForIdle();
  }, { claude });
});

test("no mix-up: there is no \"stop per agent\" for workflow agents; the subagent stop does not reach them, a route …/agents/:n/stop does not exist; a waiting and an unknown agent are refused, a foreign run is 404", async () => {
  const prior = process.env.CBASE_DYNWF_RUN_CAP;
  process.env.CBASE_DYNWF_RUN_CAP = "1";
  try {
    await withAgentsServer(async (ctx) => {
      const { base, chat, gate } = ctx;
      await ultracode(ctx);
      const script = "export const meta = { name: 'one', description: 'Cap 1' }\nreturn await parallel([() => agent('V {TAG:v} {GATE:v}', { label: 'V' }), () => agent('W {TAG:w}', { label: 'W' })])";
      const wf = await startWf(ctx, "k1", script);
      await gate.reached("v");
      await journalHas(wf.runId, (j) => has(j, 1, "started") && has(j, 2, "waiting"), "V runs, W waits for the slot");
      const idV = agentIdOf(wf.runId, 1);

      // The stop per subagent (cbase_agent) does not know the cores of the workflows.
      const s1 = await raw(`${base}/api/chats/${chat.id}/agent/stop`, { agentId: idV, from: "human" });
      assert.notEqual(s1.status, 200, `the subagent stop reaches no workflow agent: ${JSON.stringify(s1.body)}`);
      const s2 = await post(`${base}/api/chats/${chat.id}/agents/stop`, { from: "human" });
      assert.deepEqual(s2.stopped, [], "\"stop all\" takes no workflow agent along");
      const s3 = await raw(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.runId}/agents/1/stop`);
      assert.equal(s3.status, 404, "there is no third word \"stop per agent\"");

      const wait = await intervention(ctx, wf.runId, 2, "skip");
      assert.equal(wait.status, 409);
      assert.equal(wait.body.reason, "not-started");
      const unknown = await intervention(ctx, wf.runId, 9, "restart");
      assert.equal(unknown.status, 409);
      assert.equal(unknown.body.reason, "agent-closed");
      const foreign = await intervention(ctx, "wf_unknown", 1, "skip");
      assert.equal(foreign.status, 404);
      assert.ok(!has(store.readDynJournal(wf.runId), 1, "failed"), "V lives after all that");
      assert.equal(alive(pidAtGate(ctx, "v")), true);

      // The stop of the WHOLE workflow stays at the header.
      const header = await post(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${wf.runId}/stop`, {});
      assert.equal(header.status, "stopped");
      gate.open("v");
      await journalHas(wf.runId, (j) => has(j, 1, "failed"), "V ends with the run");
      const b = await treeOf(ctx, wf.runId);
      assert.equal(b.agents[0].status, "stopped", "stopped with the run is not skipped");
      await ctx.waitForIdle();
    }, { claude });
  } finally {
    if (prior === undefined) delete process.env.CBASE_DYNWF_RUN_CAP; else process.env.CBASE_DYNWF_RUN_CAP = prior;
  }
});
