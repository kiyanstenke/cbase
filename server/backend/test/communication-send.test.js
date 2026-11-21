// Agent communication: the send route POST /api/chats/:id/agent/send (runs/routes.js -> communication/send.js) on the real server.
// The sender is the chat in the path, the mark `ofProfile` comes (as from the MCP server) in the body.
//
// What is checked is the allowlist per target: every manager chat (agent, administrator, pipeline, subagent inside) gets 409 before
// any check (the lock of the kind "manager") and no channel arises; a subagent 403; `channel:<id>` only a participant; paused =>
// stored and delivered after resuming; closed => rejected without a new channel; the coding main agent is free (silent
// channel); graph: unknown run 404; wf: unknown run 404; `from` missing => 400; foreign workspace => 403.
//
// Counter-tests (which sabotage turns which test red):
//   chats/routes.js: the line of the manager lock removed          => (1) red (403/200 instead of 409)
//   send.js: check `role === "subagent"` on the channel removed    => (5) red
//   send.js: `workflowAgent` not passed to senderOf                => (5b) red (the route dropped it => role coding, channel 200)
//   send.js: requirement `from` removed                            => (8) red
//   target-channel.js: participant check removed                   => (4) red (sendToChannel throws 409 instead of 403)
//   visibility.js: workspace check removed                         => (9) red
//   target-chat.js: only `commonChannel` again (the newest)        => (10) red
//   send.js: ambiguity again with resolveAgent(..., {}) without instance check => (11) red (foreign agentId in the 400)

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { sendMessage } from "../electron/server/communication/send.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";
import { json, makeChat, makeWorkspace, ok, withServer } from "./server-harness.mjs";

const send = (base, chatId, body) => json(`${base}/api/chats/${chatId}/agent/send`, { method: "POST", body: JSON.stringify(body) });

// A workspace with two coding chats, a manager-agent chat, administrator and pipeline (through the store: the server creates the
// special roles otherwise only through its ticks).
async function situation(base, wsPath) {
  const ws = await makeWorkspace(base, "Comm", wsPath);
  const a = await makeChat(base, ws.id);
  const b = await makeChat(base, ws.id);
  const t = Date.now();
  const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", createdAt: t, updatedAt: t });
  const verw = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", createdAt: t, updatedAt: t });
  store.updateChat(verw.id, { specialRole: "administrator" });
  const pipe = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", createdAt: t, updatedAt: t });
  store.updateChat(pipe.id, { specialRole: "pipeline" });
  return { ws, a, b, mgr, verw, pipe };
}
const channel = (base, wsId, participants, creator) =>
  ok(`${base}/api/workspaces/${wsId}/channels`, { method: "POST", body: JSON.stringify({ name: "K", participants, creatorChatId: creator, cap: 0 }) });

// A manager chat - manager agent, administrator, pipeline - is read-only (runs/manager-lock.js); its send route answers 409
// before any check, no item and no channel arises.
test("send route: allowlist per target - a subagent 403; every manager chat (agent, administrator, pipeline, subagent inside) 409 without a channel", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const { ws, a, b, mgr, verw, pipe } = await situation(base, wsPath);
    const channels = store.listChannels(ws.id).length;

    // (1) Administrator, pipeline and manager agent: the lock.
    for (const special of [verw, pipe, mgr]) {
      const r = await send(base, special.id, { to: `chat:${a.id}`, message: "Hello", from: "agent" });
      assert.equal(r.status, 409, `${special.specialRole || special.id}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.managerLocked, true);
    }
    assert.equal(store.listChannels(ws.id).length, channels, "no channel through a manager chat");

    // (2) A subagent writes to no other chat - in a coding chat 403, in a manager chat the lock applies first.
    const rs = await send(base, a.id, { to: `chat:${b.id}`, message: "Hello", from: "agent", ofProfile: `${a.id}-agent-x1` });
    assert.equal(rs.status, 403, JSON.stringify(rs.body));
    const rm = await send(base, mgr.id, { to: `chat:${b.id}`, message: "Hello", from: "agent", ofProfile: `${mgr.id}-agent-x1` });
    assert.equal(rm.status, 409, JSON.stringify(rm.body));
    await waitForQuiet();
  });
});

test("send route: channel:<id> only for participants, paused => stored and delivered after resuming, closed => rejected without a new channel", async () => {
  await withServer(async ({ base, wsPath, waitForQuiet }) => {
    const { ws, a, b, mgr } = await situation(base, wsPath);
    const c = await makeChat(base, ws.id);
    const k = await channel(base, ws.id, [a.id, b.id], a.id);

    // (4) A non-participant => 403.
    const r4 = await send(base, c.id, { to: `channel:${k.id}`, message: "Hello", from: "agent" });
    assert.equal(r4.status, 403, JSON.stringify(r4.body));
    // (5) A subagent of the participant => 403 (it leads only its own children).
    const r5 = await send(base, a.id, { to: `channel:${k.id}`, message: "Hello", from: "agent", ofProfile: `${a.id}-agent-x1` });
    assert.equal(r5.status, 403, JSON.stringify(r5.body));
    // (5b) The workflow mark of the MCP server makes the sender a workflow agent - even without a profile: no channel, no wf:, and
    // the rejection says who it is.
    const r5b = await send(base, a.id, { to: `channel:${k.id}`, message: "Hello", from: "agent", workflowAgent: "wf-agent-1" });
    assert.equal(r5b.status, 403, JSON.stringify(r5b.body));
    assert.match(r5b.body.error, /Agent eines Workflows schreibt in keinen Kanal/);
    const r5c = await send(base, a.id, { to: "wf:run-1:1", message: "Hello", from: "agent", workflowAgent: "wf-agent-1" });
    assert.equal(r5c.status, 403, JSON.stringify(r5c.body));
    assert.equal(store.getChannel(k.id).lastSeq, 0, "nothing in the channel");

    // (6) Paused => "paused - will be delivered after the channel resumes"; B sees nothing until the human resumes.
    await ok(`${base}/api/channels/${k.id}/pause`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    const r6 = await send(base, a.id, { to: `channel:${k.id}`, message: "MARKER-PAUSE", from: "agent" });
    assert.equal(r6.status, 200, JSON.stringify(r6.body));
    assert.equal(r6.body.state, "paused");
    assert.match(r6.body.text, /pausiert — wird nach dem Fortsetzen zugestellt/);
    const inHistory = async () => (await ok(`${base}/api/chats/${b.id}/log`)).some((z) => z.role === "channel" && String(z.text).includes("MARKER-PAUSE"));
    assert.equal(await inHistory(), false, "paused: not delivered");
    await ok(`${base}/api/channels/${k.id}/resume`, { method: "POST", body: JSON.stringify({}) });
    await waitForQuiet();
    assert.equal(await inHistory(), true, "delivered after resuming");

    // (7) Closed => rejected, and NO new channel arises.
    await ok(`${base}/api/channels/${k.id}/close`, { method: "POST", body: JSON.stringify({ reason: "test" }) });
    const count = store.listChannels(ws.id).length;
    const r7 = await send(base, a.id, { to: `channel:${k.id}`, message: "Hello", from: "agent" });
    assert.equal(r7.status, 409, JSON.stringify(r7.body));
    assert.equal(r7.body.state, "denied");
    assert.match(r7.body.error, /abgewiesen: Kanal closed/);
    assert.equal(store.listChannels(ws.id).length, count, "no new channel");
    // A manager chat does not reach it (the lock, 409 before the participant check).
    assert.equal((await send(base, mgr.id, { to: `channel:${k.id}`, message: "x", from: "agent" })).status, 409);
    await waitForQuiet();
  });
});

test("send route: coding main agent to chat:<id> free through a silent channel, graph: unknown 404, `from` missing => 400, foreign workspace => 403", async () => {
  await withServer(async ({ base, wsPath, root, waitForQuiet }) => {
    const { a, b } = await situation(base, wsPath);
    // (8) Without `from` it is no statement - also to a subagent.
    for (const to of [`chat:${b.id}`, "agent-1"]) {
      const r = await send(base, a.id, { to, message: "Hello" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /from (required|erforderlich)/);
    }
    // The coding main agent: free - a silent channel (the channel table in detail: communication-chat.test.js).
    const rc = await send(base, a.id, { to: `chat:${b.id}`, message: "Hello", from: "agent" });
    assert.equal(rc.status, 200, JSON.stringify(rc.body));
    assert.equal(store.getChannel(rc.body.channelId)?.cap, 0);
    await waitForQuiet();
    // graph: exists (communication-graph.test.js): an unknown run is 404. The sender is the coding chat (a manager chat would get
    // the lock first, 409).
    const rg = await send(base, a.id, { to: "graph:g-1", message: "Hello", from: "agent" });
    assert.equal(rg.status, 404, JSON.stringify(rg.body));
    // wf: exists (communication-workflow.test.js): an unknown run is 404.
    const rw = await send(base, a.id, { to: "wf:run-1:1", message: "Hello", from: "agent" });
    assert.equal(rw.status, 404, JSON.stringify(rw.body));
    // (9) A chat of another workspace => 403.
    const ws2 = await makeWorkspace(base, "Foreign", path.join(root, "foreign"));
    const f = await makeChat(base, ws2.id);
    const rf = await send(base, a.id, { to: `chat:${f.id}`, message: "Hello", from: "agent" });
    assert.equal(rf.status, 403, JSON.stringify(rf.body));
    assert.match(rf.body.error, /anderen Workspace/);
    // The subagent route stays as it was: without a run 409 "No active run".
    const rs = await send(base, a.id, { to: "agent-1", message: "Hello", from: "agent" });
    assert.equal(rs.status, 409, JSON.stringify(rs.body));
    assert.match(rs.body.error, /No active run/);
  });
});

// The main agent executes the calls from "OPS:[...]" and writes every result to result-<tag> (as in communication-workflow).
const MAIN = `
  if (text.includes("<task-notification>")) { finished(); say({ type: "result", result: "Notice read", session_id: "main-session" }); return; }
  const m = /OPS:(\\[.*\\])/.exec(text);
  const ops = m ? JSON.parse(m[1]) : [];
  for (const op of ops) {
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: op.args }] } });
    let t = "";
    try { const r = await mcpCall(op.w, op.args); t = (r.result && r.result.isError ? "ERROR " : "") + textOf(r); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "result-" + op.tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;
// Subagent and workflow agent: {GATE:x} holds only the FIRST run per {TAG:x}.
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    const log = path.join(LOCATION, "jobs-" + tag);
    fs.appendFileSync(log, "x\\n");
    const attempt = fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).length;
    const session = "sub-" + tag + attempt;
    say({ type: "system", subtype: "init", session_id: session });
    if (job.includes("{GATE:") && attempt === 1) await gate(job.split("{GATE:")[1].split("}")[0]);
    finished();
    say({ type: "result", result: "Finding " + tag + " v" + attempt, session_id: session });`;

// Without keep-alive (agent-harness.mjs: no connection may stay open after the test).
const jz = (url, init = {}) => json(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });

test("send route (11): a label carried by a workflow agent AND a subagent's own child - the subagent reaches its child (200); from a project network the check names no agentId of a foreign instance", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, gate, root } = ctx;
    const read = (d) => { try { return fs.readFileSync(path.join(root, d), "utf8"); } catch { return ""; } };
    await jz(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const script = "export const meta = { name: 'same', description: 'Same name' }\nreturn await agent('A {TAG:a} {GATE:a}', { label: 'Reviewer' })";
    const ops = [
      { w: "cbase_agent", tag: "l", args: { description: "Leader", name: "Leader", prompt: "L {TAG:l} {GATE:l}" } },
      { w: "cbase_dynamic_workflow", tag: "w", args: { script } },
    ];
    await jz(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `Go OPS:${JSON.stringify(ops)}` }) });
    await ctx.waitForTruthy(() => read("result-w") || null, "result w");
    const leaderId = JSON.parse(read("result-l")).agentId;
    const runId = JSON.parse(read("result-w")).runId;
    assert.ok(leaderId && runId, `${read("result-l")} ${read("result-w")}`);
    await gate.reached("l");
    await gate.reached("a");
    await ctx.waitForTruthy(() => store.readDynJournal(runId).some((e) => e.n === 1 && e.kind === "started") || null, "workflow agent started");
    await ctx.waitForTruthy(async () => ((await jz(`${base}/api/runs/active`)).body?.runs === 0 ? true : null), "turn over");
    // The leader starts its own child "Reviewer" (like its MCP server: with its profile).
    const profile = `${chat.id}-agent-${leaderId}`;
    const child = await jz(`${base}/api/chats/${chat.id}/agent`, { method: "POST", body: JSON.stringify({ prompt: "K {TAG:k} {GATE:k}", description: "Child", name: "Reviewer", callId: "toolu_kind", ofProfile: profile }) });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    const childId = child.body.agentId;
    await gate.reached("k");

    // (11a) The leader writes to its child by label: 200 - the workflow agent of the same name is no target for it (wf: is 403).
    const r = await jz(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: "Reviewer", message: "More X", from: "agent", ofProfile: profile }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.agentId, childId, JSON.stringify(r.body));
    // The main agent stays at "ambiguous" with candidates of both kinds.
    const h = await jz(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: "Reviewer", message: "who?", from: "agent" }) });
    assert.equal(h.status, 400, JSON.stringify(h.body));
    assert.ok(h.body.candidates.includes(childId) && h.body.candidates.includes(`wf:${runId}:1`), JSON.stringify(h.body));
    // (11b) From a project network (fence of another instance): the child lives in B - its agentId is in no answer.
    const z = await sendMessage({ chat: store.getChat(chat.id), body: { to: "Reviewer", message: "from the fence", from: "agent" }, fence: { identifier: "copy-foreign" } });
    assert.ok(!JSON.stringify(z.body).includes(childId), `no foreign agentId: ${JSON.stringify(z.body)}`);
    assert.ok(!z.body.candidates, JSON.stringify(z.body));

    for (const t of ["k", "l", "a"]) gate.open(t);
    await ctx.waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? true : null), "run finished");
    await ctx.waitForIdle();
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
});
