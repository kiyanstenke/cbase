// The main agent never waits (providers/agent-wait.js), at the main seam with the agent harness: real server, real cbase MCP
// server, real routes, only the providers are faked.
//
// What holds: a subagent of the MAIN agent always runs in the background at once, even with `run_in_background: false`, for
// Claude and for the loop engine alike (Codex takes the same way: MCP -> POST /agent -> core, no switch of its own). The turn
// ends with run_done and the report arrives as a completion notice; cbase_agent_output does not wait for the main agent. A
// subagent that delegates itself keeps the foreground: an agent waits for its child, not the chat.
//
// The gate sets CBASE_MAIN_AGENT_WAIT_MS (the other agent tests fetch the report in the call that way). This file measures the
// product and so removes the knob from its environment before a server starts.
//
// Counter-tests (each shown red once):
//   - the old core (background only without `false`) => "Claude" and "Engine" see the foreground agent in the bar instead of
//     run_done; the old output way => "queries" waits out its deadline (`waited`) and offers waiting.
//   - the rule without the subagent exception (background always) => "depth 2" sees the grandchild result as "running".
//   - communication/target-subagent.js without `parentAgent` on the send => "continuation" red: the note read the parent agent
//     of the TARGET (the grandchild has one) and offered the main agent cbase_agent_output.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { isCompletionNotice } from "../electron/server/runs/completionNotice.js";

delete process.env.CBASE_MAIN_AGENT_WAIT_MS;

// The SSE stream of a chat, recorded; waits for the event, no deadline.
async function openStream(url) {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
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
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
          }
        }
      }
    } catch { /* abort on close */ }
  })();
  return {
    events,
    wait: (p, what) => waitForTruthy(() => events.find(p) || null, what),
    async shutdown() { ac.abort(); await pump; },
  };
}

const post = (url, body) => json(url, { method: "POST", body: JSON.stringify(body) });
// Waits for the FIRST answer of the main agent to a completion notice and judges afterwards; a predicate "exactly one notice"
// would hang on a second one instead of turning red.
const notices = (log) => log.filter((m) => m.role === "user" && isCompletionNotice(m.text));
const liveIn = async (base, chatId) => (await json(`${base}/api/runs/active`)).agents.filter((a) => a.chatId === chatId);
const readOrEmpty = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
// The verdict on the turn, without a clock: does it end (run_done), or does an agent stand as foreground in the bar (the old
// behaviour: a call waits for it, the turn goes on)? Whatever comes first in the stream decides.
const turnEndOrForeground = (stream) => stream.wait((e) => e.subtype === "run_done"
  || (e.subtype === "background" && (e.agents || []).some((a) => a.foreground === true)), "run_done or a foreground agent");

// The subagent reports "Finding 42" once the gate "sub" is open ({KURZ}: without gate). With {DELEGIERE} it starts a subagent of
// its own in the FOREGROUND and reports what its call returned.
const SUB = `
    if (text.includes("{DELEGIERE}")) {
      const args = { description: "Grandchild", prompt: "Look into it {KURZ}.", run_in_background: false };
      say({ type: "assistant", message: { id: "sub-d", content: [{ type: "tool_use", id: "toolu_grandchild", name: "mcp__cbase__cbase_agent", input: args }] } });
      let t = "";
      try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_grandchild", content: t }] } });
      const r = (() => { try { return JSON.parse(t); } catch { return {}; } })();
      const report = "Grandchild " + r.status + ": " + (r.report || "");
      say({ type: "assistant", message: { id: "sub-e", content: [{ type: "text", text: report }] } });
      finished();
      say({ type: "result", result: report, session_id: "sub-session" });
      return;
    }
    if (!text.includes("{KURZ}")) await gate("sub");
    say({ type: "assistant", message: { id: "sub-2", content: [{ type: "text", text: "Finding 42" }] } });
    finished();
    say({ type: "result", result: "Finding 42", session_id: "sub-session" });`;

// The main agent: turn 1 starts a subagent with the arguments behind "ARGS:"; with {AUSGABE} it then asks cbase_agent_output
// (with a 5 s deadline; the old behaviour waited it out). It writes a completion notice to a file.
const MAIN = `
  if (text.startsWith("<task-notification>")) {
    fs.writeFileSync(path.join(LOCATION, "notice-" + turn), text);
    say({ type: "assistant", message: { id: "main-m" + turn, content: [{ type: "text", text: "Notice read" }] } });
    finished();
    say({ type: "result", result: "Notice read", session_id: "main-session" });
    return;
  }
  // "SEND:<agentId>" continues a finished agent with cbase_agent_send; the answer then stands in senden-<turn>.
  if (text.includes("SEND:")) {
    const args = { to: /SEND:(\\S+)/.exec(text)[1], message: "Go on {KURZ}" };
    say({ type: "assistant", message: { id: "main-s-" + turn, content: [{ type: "tool_use", id: "toolu_send" + turn, name: "mcp__cbase__cbase_agent_send", input: args }] } });
    let t = "";
    try { t = textOf(await mcpCall("cbase_agent_send", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, "senden-" + turn), t);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_send" + turn, content: t }] } });
    say({ type: "assistant", message: { id: "main-s2-" + turn, content: [{ type: "text", text: "Sent" }] } });
    finished();
    say({ type: "result", result: "Sent", session_id: "main-session" });
    return;
  }
  const args = JSON.parse(/ARGS:(\\{.*\\})/.exec(text)[1]);
  say({ type: "assistant", message: { id: "main-1-" + turn, content: [{ type: "tool_use", id: "toolu_bg" + turn, name: "mcp__cbase__cbase_agent", input: args }] } });
  let t = "";
  try { t = textOf(await mcpCall("cbase_agent", args)); } catch (e) { t = "ERROR " + (e && e.message ? e.message : String(e)); }
  fs.writeFileSync(path.join(LOCATION, "result-" + turn), t);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg" + turn, content: t }] } });
  if (text.includes("{AUSGABE}")) {
    const agentId = JSON.parse(t).agentId;
    say({ type: "assistant", message: { id: "main-o-" + turn, content: [{ type: "tool_use", id: "toolu_out" + turn, name: "mcp__cbase__cbase_agent_output", input: { agentId } }] } });
    let o = "";
    try { o = textOf(await mcpCall("cbase_agent_output", { agentId, timeout: 5000 })); } catch (e) { o = "ERROR " + (e && e.message ? e.message : String(e)); }
    fs.writeFileSync(path.join(LOCATION, "output-" + turn), o);
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_out" + turn, content: o }] } });
  }
  say({ type: "assistant", message: { id: "main-2-" + turn, content: [{ type: "text", text: "Turn " + turn + " done" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`;

const fake = fakeClaude({ sub: SUB, main: MAIN });

test("Claude: run_in_background false of the main agent: the call returns at once, the turn ends, the report comes as a completion notice", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForLog }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream is up");
      const args = { description: "Test run", prompt: "Look into it.", run_in_background: false };
      await post(`${base}/api/chats/${chat.id}/message`, { text: `Start ARGS:${JSON.stringify(args)}` });
      await gate.reached("sub");
      const verdict = await turnEndOrForeground(stream);
      assert.equal(verdict.subtype, "run_done", `the main agent waits for the subagent: ${JSON.stringify(verdict)}`);

      const t = readOrEmpty(path.join(root, "result-1"));
      assert.match(t, /"started": true/, t.slice(0, 300));
      assert.match(t, /"background": true/, "the call reports the background");
      assert.match(t, /you do not wait for it/, "the note tells the main agent that it does not wait");
      assert.doesNotMatch(t, /If you need it in the same turn/, "the note offers no waiting");
      const [live, ...more] = await liveIn(base, chat.id);
      assert.ok(live && !more.length, "exactly one subagent lives after run_done");
      assert.equal(live.foreground, undefined, "no call waits for it");

      gate.open("sub");
      const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
      const notice = notices(log)[0].text;
      assert.equal(readOrEmpty(path.join(root, "notice-1")), notice, "the completion notice is a turn of its own (a new process) of the main agent");
      assert.match(notice, /<tool-use-id>toolu_bg1<\/tool-use-id>/, "under the call block of the start");
      assert.match(notice, /<result>Finding 42<\/result>/);
      assert.ok(!stream.events.some((e) => e.subtype === "background" && (e.agents || []).some((a) => a.foreground === true)),
        "no foreground agent in the whole stream");
    } finally {
      gate.open("sub");
      await stream.shutdown();
    }
  }, { claude: fake });
});

test("Queries: cbase_agent_output of the main agent does not wait; it gets the state, its turn ends", async () => {
  await withAgentsServer(async ({ base, chat, root, gate, waitForLog }) => {
    const stream = await openStream(`${base}/api/chats/${chat.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream is up");
      const args = { description: "Aside", prompt: "Look into it." };
      await post(`${base}/api/chats/${chat.id}/message`, { text: `Start {AUSGABE} ARGS:${JSON.stringify(args)}` });
      await gate.reached("sub");
      await stream.wait((e) => e.subtype === "run_done", "turn end");
      const o = readOrEmpty(path.join(root, "output-1"));
      assert.match(o, /"status": "running"/, o.slice(0, 300));
      assert.doesNotMatch(o, /"waited"/, "the call waited");
      assert.match(o, /you do not wait for it/, "the note says it does not wait");
      assert.equal((await liveIn(base, chat.id)).length, 1, "the subagent lives on after run_done");

      gate.open("sub");
      await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    } finally {
      gate.open("sub");
      await stream.shutdown();
    }
  }, { claude: fake });
});

test("Depth 2: a subagent that delegates itself keeps the foreground; its call waits for the grandchild report", async () => {
  await withAgentsServer(async ({ base, chat, waitForLog }) => {
    const args = { description: "Delegating", prompt: "{DELEGIERE}" };
    await post(`${base}/api/chats/${chat.id}/message`, { text: `Start ARGS:${JSON.stringify(args)}` });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    const notice = notices(log)[0].text;
    assert.match(notice, /<result>Grandchild completed: Finding 42<\/result>/, notice.slice(0, 600));
  }, { claude: fake });
});

test("Continuation: when the main agent continues a finished GRANDCHILD, the note offers no waiting; it follows the caller", async () => {
  await withAgentsServer(async ({ base, chat, root, waitForLog }) => {
    const args = { description: "Delegating", prompt: "{DELEGIERE}" };
    await post(`${base}/api/chats/${chat.id}/message`, { text: `Start ARGS:${JSON.stringify(args)}` });
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice read"));
    const view = await json(`${base}/api/chats/${chat.id}/agents`);
    const grandchild = (view.agents || []).find((a) => a.description === "Grandchild");
    assert.ok(grandchild, `the grandchild (started by the subagent) is in the list: ${JSON.stringify(view.agents)}`);

    await post(`${base}/api/chats/${chat.id}/message`, { text: `SEND:${grandchild.agentId}` });
    await waitForLog(chat.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Sent"));
    const t = fs.readdirSync(root).filter((f) => f.startsWith("senden-")).map((f) => readOrEmpty(path.join(root, f))).join("\n");
    assert.match(t, /Resumed/, t.slice(0, 400));
    assert.doesNotMatch(t, /If you need it in the same turn/, "the note offers the main agent the fetching; it read the parent agent of the target");
  }, { claude: fake });
});

// ── Loop-Engine ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// The same case through the engine (cbase_agent over MCP, call id as `_meta["cbase/toolUseId"]`): the subagent holds at its
// first model request until the test opens the gate.
const AGENT = "mcp__cbase__cbase_agent";
const isSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));
const content = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const hasTool = (b) => (b.messages || []).some((m) => m.role === "tool");

let openTheGate;
const gateEngine = new Promise((r) => { openTheGate = r; });
let subArrived;
const subArrival = new Promise((r) => { subArrived = r; });
const engineRound = async (b) => {
  if (isSub(b)) {
    subArrived();
    await gateEngine;
    return { text: "SUB-REPORT-ENGINE" };
  }
  const last = content(b.messages.at(-1) || {});
  if (last.includes("<task-notification>")) return { text: "Notice seen" };
  if (hasTool(b)) return { text: "finished" };
  return { toolCalls: [{ id: "call_front", name: AGENT, arguments: { description: "Look", prompt: "Look into it.", run_in_background: false } }] };
};

test("Engine: run_in_background false of the main agent: the call returns at once, the turn ends, the report comes as a completion notice", async () => {
  await withAgentsServer(async ({ base, ws, engine, waitForLog }) => {
    const c = await post(`${base}/api/chats`, { workspaceId: ws.id, provider: engine.id, model: "m1", permissionMode: "bypassPermissions" });
    await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title: "Engine never waits" }) });
    const stream = await openStream(`${base}/api/chats/${c.id}/stream`);
    try {
      await stream.wait((e) => e.subtype === "connected", "stream is up");
      await post(`${base}/api/chats/${c.id}/message`, { text: "Please use a subagent" });
      await subArrival;
      const verdict = await turnEndOrForeground(stream);
      assert.equal(verdict.subtype, "run_done", `the main agent waits for the subagent: ${JSON.stringify(verdict)}`);
      const tool = engine.requests.find((b) => !isSub(b) && hasTool(b))?.messages.find((m) => m.role === "tool");
      assert.ok(tool, "the second request of the main agent carries the tool result");
      assert.match(content(tool), /\\?"started\\?": true/, content(tool).slice(0, 300));
      assert.match(content(tool), /you do not wait for it/);

      openTheGate();
      const log = await waitForLog(c.id, (l) => l.some((m) => m.role === "assistant" && m.text === "Notice seen"));
      assert.match(notices(log)[0].text, /SUB-REPORT-ENGINE/);
    } finally {
      openTheGate();
      await stream.shutdown();
    }
  }, { engine: { round: engineRound } });
});
