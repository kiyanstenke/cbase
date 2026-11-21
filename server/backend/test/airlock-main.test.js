// Coding MCP airlock: the address "main".
//
// A subagent or workflow agent of a CODING chat reaches the main agent of its chat with `cbase_agent_send { to: "main" }` —
// the way to a coding MCP server that it does not inherit. Delivered through deliverUserPrompt (occasion "message",
// `toolLimit: true`) in the form of the agent message (`<cbase-message … kind="agent" …>`). Checked on the real server:
//   (1) subagent, while the turn waits for it => 200 "delivered" (Claude: at the tool boundary), the message stands in the history;
//   (2) workflow agent, chat resting => 200 "delivered", the chat is woken (new turn), return address `wf:<runId>:<n>`;
//   (3) archived chat => 409, nothing in the history;
//   (4) counter-check manager: in a manager chat "main" stays a subagent address — no way to the main agent;
//   (5) counter-check main agent: it writes to "main" itself as it would to a label (no talking to itself).
// Codex queues up to the `result` (state "after_turn") — the mapping `queued` => "after_turn" is the same row as for Claude
// outside a tool boundary; not run on the Codex wire (named).
//
// Counter-proofs (each in a copy; which sabotage turns which test red):
//   send.js: branch "main" removed                             => (1) and (2) red (404/400 — no subagent "main")
//   send.js: condition `senderOf(chat) === "coding"` removed   => (4) red (the manager chat got the message)
//   target-main.js: `toolLimit: true` removed             => (1) red ("after_turn" instead of "delivered")
//
// Run (alone): CBASE_LIMIT_GRACE_MS=2000 CBASE_LIMIT_MIN_WAIT_MS=2000 CBASE_SWEEP_MS=2000 CBASE_AGENT_STALL_MS=3600000
// CBASE_EMBED_OFFLINE=1 node --test --test-reporter=tap server/backend/test/airlock-main.test.js
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { sendMessage } from "../electron/server/communication/send.js";
import { chatArchive } from "../electron/server/chats/archive.js";
import { workflowAliasHits } from "../electron/server/dynworkflows/message.js";
import { fakeClaude, withAgentsServer } from "./agent-harness.mjs";
import { json } from "./server-harness.mjs";

const MAIN = `
  if (text.includes("<task-notification>")) { finished(); say({ type: "result", result: "Notice read", session_id: "main-session" }); return; }
  const m = /OPS:(\\[.*\\])/.exec(text);
  const ops = m ? JSON.parse(m[1]) : [];
  for (const op of ops) {
    const id = "toolu_" + op.tag;
    say({ type: "assistant", message: { id: "main-" + op.tag, content: [{ type: "tool_use", id, name: "mcp__cbase__" + op.w, input: op.args }] } });
    let t = "";
    try { const r = await mcpCall(op.w, op.args); t = (r.result && r.result.isError ? "FEHLER " : "") + textOf(r); } catch (e) { t = "FEHLER " + (e && e.message ? e.message : String(e)); }
    { const z = path.join(LOCATION, "result-" + op.tag); fs.writeFileSync(z + ".teil", t); fs.renameSync(z + ".teil", z); }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: t }] } });
  }
  finished();
  say({ type: "result", result: "done", session_id: "main-session" });`;
const SUB = `
    const ab = text.lastIndexOf("Here is the task:");
    const job = ab >= 0 ? text.slice(ab) : text;
    const tag = job.includes("{TAG:") ? job.split("{TAG:")[1].split("}")[0] : "x";
    say({ type: "system", subtype: "init", session_id: "sub-" + tag });
    if (job.includes("{GATE:")) await gate(job.split("{GATE:")[1].split("}")[0]);
    finished();
    say({ type: "result", result: "Report " + tag, session_id: "sub-" + tag });`;

const jz = (url, init = {}) => json(url, { ...init, headers: { "Content-Type": "application/json", Connection: "close", ...(init.headers || {}) } });
const messagesOf = (chatId, content) => store.listMessages(chatId).filter((m) => m.role === "user" && String(m.text ?? m.content ?? "").includes(content));
const textOf = (m) => String(m.text ?? m.content ?? "");

test("\"main\": subagent and workflow agent of a coding chat reach the main agent — running at the tool boundary, resting woken; archived 409; manager and main agent unchanged", { timeout: 120_000 }, async () => {
  await withAgentsServer(async (ctx) => {
    const { base, chat, ws, gate, root } = ctx;
    const read = (d) => { try { return fs.readFileSync(path.join(root, d), "utf8"); } catch { return ""; } };
    await jz(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "claude-opus-5-5", ultracode: true }) });
    const script = "export const meta = { name: 'ask', description: 'Asks' }\nreturn await agent('A {TAG:a} {GATE:a}', { label: 'Checker' })";
    const ops = [
      { w: "cbase_dynamic_workflow", tag: "w", args: { script: script } },
      { w: "cbase_agent", tag: "l", args: { description: "Leader", name: "Leader", prompt: "L {TAG:l} {GATE:l}", run_in_background: false } },
    ];
    await jz(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: `Go OPS:${JSON.stringify(ops)}` }) });
    await ctx.waitForTruthy(() => read("result-w") || null, "result w");
    const runId = JSON.parse(read("result-w")).runId;
    await gate.reached("l");
    const agents = (await jz(`${base}/api/chats/${chat.id}/agents`)).body?.agents || [];
    const leaderId = agents.find((a) => a.name === "Leader")?.agentId;
    assert.ok(leaderId, `Leader among the agents: ${JSON.stringify(agents)}`);
    assert.equal((await jz(`${base}/api/runs/active`)).body?.runs, 1, "the turn waits for the leader");

    // (1) The subagent asks the main agent while its turn runs.
    const profile = `${chat.id}-agent-${leaderId}`;
    const r1 = await jz(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: "main", message: "Please Teams LEADER", from: "agent", ofProfile: profile }) });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.state, "delivered", JSON.stringify(r1.body));
    gate.open("l");
    await ctx.waitForTruthy(() => (messagesOf(chat.id, "Please Teams LEADER").length ? true : null), "message of the leader in the history");
    const n1 = textOf(messagesOf(chat.id, "Please Teams LEADER")[0]);
    assert.ok(n1.startsWith("<cbase-message") && n1.includes('kind="agent"') && n1.includes(`address="${leaderId}"`) && n1.includes('from="Leader"'), n1);
    await ctx.waitForTruthy(async () => ((await jz(`${base}/api/runs/active`)).body?.runs === 0 ? true : null), "turn over");

    // (2) The workflow agent asks while the chat rests: woken.
    await gate.reached("a");
    const t = workflowAliasHits(chat.id, "Checker")[0];
    assert.ok(t, "workflow agent \"Checker\" lives");
    const wfAgentId = [...t.run.entries.values()].find((e) => e.n === t.n)?.agentId;
    assert.ok(wfAgentId, "agentId of the workflow agent");
    const prior = store.listMessages(chat.id).filter((m) => m.role === "assistant").length;
    const r2 = await jz(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: "main", message: "Please Teams WF", from: "agent", workflowAgent: wfAgentId }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.state, "delivered", JSON.stringify(r2.body));
    await ctx.waitForTruthy(() => (messagesOf(chat.id, "Please Teams WF").length ? true : null), "message of the workflow agent in the history");
    const n2 = textOf(messagesOf(chat.id, "Please Teams WF")[0]);
    assert.ok(n2.includes('kind="agent"') && n2.includes(`address="wf:${runId}:${t.n}"`) && n2.includes('from="Checker"'), n2);
    await ctx.waitForTruthy(() => (store.listMessages(chat.id).filter((m) => m.role === "assistant").length > prior ? true : null), "woken turn answers");

    // (5) The main agent itself: "main" stays a subagent address for it (unknown here) — no way to itself.
    const r5 = await jz(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: "main", message: "to me?", from: "agent" }) });
    assert.notEqual(r5.status, 200, JSON.stringify(r5.body));
    assert.equal(messagesOf(chat.id, "to me?").length, 0);

    gate.open("a");
    await ctx.waitForTruthy(() => (store.readDynRun(runId)?.status !== "running" ? true : null), "run over");
    await ctx.waitForIdle();

    // (3) Archived => 409 (through the route's function, role workflow agent of another, empty coding chat).
    const second = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "coding", createdAt: Date.now(), updatedAt: Date.now() });
    assert.equal(chatArchive(second.id).archived, true);
    const r3 = await sendMessage({ chat: store.getChat(second.id), body: { to: "main", message: "still there?", from: "agent", workflowAgent: "wf-agent-x" } });
    assert.equal(r3.status, 409, JSON.stringify(r3.body));
    assert.equal(store.listMessages(second.id).length, 0);

    // (4) Counter-check manager: a subagent of a manager chat means by "main" a subagent of that name.
    const mgr = store.createChat({ id: crypto.randomUUID(), workspaceId: ws.id, kind: "manager", agentId: "ag-1", createdAt: Date.now(), updatedAt: Date.now() });
    const r4 = await sendMessage({ chat: store.getChat(mgr.id), body: { to: "main", message: "to the manager?", from: "agent", ofProfile: `${mgr.id}-agent-x` } });
    assert.notEqual(r4.body?.state, "delivered", JSON.stringify(r4.body));
    assert.equal(store.listMessages(mgr.id).length, 0, "the manager chat got nothing");
  }, { claude: fakeClaude({ main: MAIN, sub: SUB }) });
});
