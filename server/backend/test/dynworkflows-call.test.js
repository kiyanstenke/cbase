// Calling by name: saved workflows are building blocks. Main seam with the harness of agent-harness.mjs (real server, real
// cbase MCP server, real agent core, only the providers faked): `cbase_dynamic_workflow` with `name` starts a saved workflow
// without `script`, and `workflow('name')` in its script runs a second saved one as a sub-step. Its agents stand in the
// journal OF THE PARENT run, its return value arrives in the parent script, a stop of the parent run ends them. The
// semantics without a server (one level, cap, budget, abort) are in dynworkflows-sandbox.test.js.
//
// COUNTER-TESTS (each turns the named test red):
//   - bypassing the opt-in guard in run.js startDynWorkflow for `name` (`&& !nameChoice`) makes "opt-in" start a run;
//   - replacing the project view in run.js savedWorkflow by the whole workspace list turns "project chat" red.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { db } from "../electron/server/store/db.js";

// The main agent: "WF[<tag>]:{json}" calls cbase_dynamic_workflow with these arguments and stores the result under
// wf-<tag> (like dynworkflows-run.test.js). A completion notice it answers briefly.
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
    say({ type: "assistant", message: { id: "b-" + tag, content: [{ type: "text", text: "Workflow kicked off" }] } });
    finished();
    say({ type: "result", result: "Workflow kicked off", session_id: "main-session" });
    return;
  }
  say({ type: "assistant", message: { id: "c-" + Date.now(), content: [{ type: "text", text: "Response" }] } });
  finished();
  say({ type: "result", result: "Response", session_id: "main-session" });`;

// A workflow agent: {TAG:x} in the computed task, {GATE:x} holds it at the gate; it stores its pid and reports
// "Finding <tag>".
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    fs.writeFileSync(path.join(LOCATION, "sub-pid-" + tag), String(process.pid));
    say({ type: "assistant", message: { id: "s1-" + tag, usage: { input_tokens: 11, output_tokens: 5 }, content: [{ type: "text", text: "work" }] } });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    say({ type: "assistant", message: { id: "s2-" + tag, content: [{ type: "text", text: "Finding " + tag }] } });
    finished();
    say({ type: "result", result: "Finding " + tag, session_id: "sub-" + tag });`;

const claude = fakeClaude({ main: MAIN, sub: SUB });

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
const ultracodeOn = (base, chatId) => json(`${base}/api/chats/${chatId}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
const script = (name, body) => `export const meta = { name: '${name}', description: 'Building block ${name}', phases: [{ title: 'Part' }] }\n${body}\n`;
// Store in the library through the route of the chat; from a project chat it is adopted there at the same time.
async function save(base, chatId, text) {
  const r = await fetch(`${base}/api/chats/${chatId}/dyn-workflows`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ script: text }) });
  assert.equal(r.status, 201, await r.text());
}
async function start(ctx, chatId, tag, args) {
  await post(`${ctx.base}/api/chats/${chatId}/message`, { text: `WF[${tag}]:${JSON.stringify(args)}` });
  const file = path.join(ctx.root, `wf-${tag}`);
  await waitForTruthy(() => fs.existsSync(file), `tool result ${tag}`);
  const t = fs.readFileSync(file, "utf8");
  return t.startsWith("ERROR ") ? { error: t } : JSON.parse(t);
}
const notMoreRunning = (runId) => waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? store.readDynRun(runId) : null), `run ${runId} finished`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const subPid = (root, tag) => Number(fs.readFileSync(path.join(root, `sub-pid-${tag}`), "utf8"));
const runCount = (chatId) => db.prepare("SELECT COUNT(*) n FROM dyn_workflow_runs WHERE chat_id = ?").get(chatId).n;

const BUILDING_BLOCK = script("block", "phase('Child'); const finding = await agent('Check ' + args.thema + ' {TAG:kind}', { label: 'kind' }); return { finding, thema: args.thema };");
const PARENT = script("parent", "const prior = await agent('Collect {TAG:parent}', { label: 'parent' }); const kind = await workflow('block', { thema: args.thema }); return { prior, kind };");

test("main seam: cbase_dynamic_workflow with name + args starts the saved workflow without script (same return, script file written); its workflow('block') runs as a sub-step, agents in the journal of the parent run, return value in the parent script", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await ultracodeOn(base, chat.id);
    await save(base, chat.id, BUILDING_BLOCK);
    await save(base, chat.id, PARENT);
    const r = await start(ctx, chat.id, "n", { name: "parent", args: { thema: "Checkout" } });
    assert.equal(r.status, "started", JSON.stringify(r));
    assert.equal(r.name, "parent");
    assert.match(r.runId, /^wf_[a-z0-9-]{6,}$/);
    assert.ok(r.taskId && r.taskId !== r.runId);
    assert.equal(fs.readFileSync(r.scriptPath, "utf8"), PARENT, "the script file is written, a later scriptPath finds it");
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.deepEqual(end.returnValue, { prior: "Finding parent", kind: { finding: "Finding kind", thema: "Checkout" } });
    assert.equal(end.agentCount, 2, "one counter for parent and child");
    const j = store.readDynJournal(r.runId);
    const started = j.filter((e) => e.kind === "launched").map((e) => [e.n, e.label, e.workflow ?? null, e.phase]);
    assert.deepEqual(started, [[1, "parent", null, null], [2, "kind", "block", "Child"]], "the child's agents stand in the journal of the parent run, with its name");
    assert.deepEqual(j.filter((e) => e.kind === "result").map((e) => [e.n, e.value]), [[1, "Finding parent"], [2, "Finding kind"]]);
    assert.equal(runCount(chat.id), 1, "the child is no run of its own");
    await ctx.waitForIdle();
  }, { claude });
});

test("a stop of the parent run ends the child's agents; an unknown name is an immediate error without a run", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, root } = ctx;
    await ultracodeOn(base, chat.id);
    await save(base, chat.id, script("hanger", "return await agent('Wait {TAG:hk} {GATE:hk}');"));
    await save(base, chat.id, script("top", "return await workflow('hanger');"));
    const unknown = await start(ctx, chat.id, "u", { name: "exists-not" });
    assert.match(unknown.error || "", /exists-not/);
    assert.match(unknown.error, /hanger, top/, "the error names the names available in the chat");
    assert.equal(runCount(chat.id), 0, "no run created");
    const r = await start(ctx, chat.id, "s", { name: "top" });
    assert.equal(r.status, "started", JSON.stringify(r));
    await ctx.gate.reached("hk");
    const pid = subPid(root, "hk");
    assert.ok(alive(pid));
    const s = await post(`${base}/api/chats/${chat.id}/dyn-workflows/runs/${encodeURIComponent(r.runId)}/stop`, {});
    assert.equal(s.status, "stopped", JSON.stringify(s));
    await waitForTruthy(() => !alive(pid), "the child's agent ended");
    assert.equal(store.readDynRun(r.runId).status, "stopped");
    await ctx.waitForIdle();
  }, { claude });
});

test("opt-in: a start by name without Ultracode and without keyword starts nothing, approval card as with a script", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat } = ctx;
    await save(base, chat.id, BUILDING_BLOCK);
    const r = await start(ctx, chat.id, "o", { name: "block", args: { thema: "x" } });
    assert.equal(r.status, "awaiting_approval", JSON.stringify(r));
    assert.equal(r.name, "block");
    assert.equal(r.runId, undefined, "no run");
    assert.equal(runCount(chat.id), 0, "no run created");
    await ctx.waitForIdle();
  }, { claude });
});

test("project chat: a workflow that is in the workspace but not adopted in the project counts as unknown, as name and as workflow() in the script", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, root } = ctx;
    await save(base, chat.id, BUILDING_BLOCK); // from the workspace chat: in the workspace, adopted in no project
    const filePath = path.join(root, "workspace", "till");
    fs.mkdirSync(filePath, { recursive: true });
    const project = await post(`${base}/api/workspaces/${ws.id}/projects`, { name: "Checkout", path: filePath });
    const pChat = await post(`${base}/api/chats`, { workspaceId: ws.id, projectId: project.id, provider: "claude", model: "claude-opus-5-5", permissionMode: "bypassPermissions" });
    assert.equal(pChat.projectId, project.id);
    await ultracodeOn(base, pChat.id);
    await save(base, pChat.id, script("calls", "try { return await workflow('block', { thema: 'p' }); } catch (e) { return e.message; }"));
    const asName = await start(ctx, pChat.id, "p1", { name: "block" });
    assert.match(asName.error || "", /block/);
    assert.match(asName.error, /calls/, "only what the project adopted is available");
    assert.doesNotMatch(asName.error, /Available: .*block/);
    const r = await start(ctx, pChat.id, "p2", { name: "calls" });
    assert.equal(r.status, "started", JSON.stringify(r));
    const end = await notMoreRunning(r.runId);
    assert.equal(end.status, "finished", end.error);
    assert.equal(end.returnValue, "workflow('block'): no workflow with that name. Available: calls");
    // Adopted, it counts: same name, same chat.
    const turnedOn = await fetch(`${base}/api/projects/${project.id}/workspace-dyn-workflows/block/enabled`, { method: "PATCH", headers: { "Content-Type": "application/json", Connection: "close" }, body: JSON.stringify({ enabled: true }) });
    assert.equal(turnedOn.status, 200);
    const r2 = await start(ctx, pChat.id, "p3", { name: "calls" });
    const end2 = await notMoreRunning(r2.runId);
    assert.equal(end2.status, "finished", end2.error);
    assert.deepEqual(end2.returnValue, { finding: "Finding kind", thema: "p" });
    await ctx.waitForIdle();
  }, { claude });
});
