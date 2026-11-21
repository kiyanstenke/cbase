// A subagent lands under THE call block that started it - via an explicit id (Claude: `_meta.claudecode/toolUseId`, loop engine:
// `_meta.cbase/toolUseId`), for Codex via the open blocks of its stream (route B with argument comparison and back-confirmation,
// runs/call-blocks.js). Never LIFO. Real server, real MCP server, fake CLIs (agent-harness.mjs); the subagents are fake-Claude
// runs whose finding comes from their task or start number - so it is readable at each block WHOSE events sit there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { LOCATION, fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";
import { agentIdFromResult, createCallBlocks, canonical } from "../electron/server/runs/call-blocks.js";
import { liveAgents } from "../electron/server/runs/agents.js";

const SUB_MODEL = "claude::claude-haiku-4-5-20251001";

// The subagent: marker from the task (ONE/TWO/...) or, for equal tasks, from its start number. Own token counts per marker,
// a tool call with its own id. "WAIT" in the task: it stands at a gate until the test opens it.
const SUB = `
  let nr = 0;
  try { nr = Number(fs.readFileSync(path.join(LOCATION, "sub-counter"), "utf8")) || 0; } catch {}
  nr += 1;
  fs.writeFileSync(path.join(LOCATION, "sub-counter"), String(nr));
  const m = /Task (\\w+)/.exec(text);
  const marker = m && m[1] !== "EQUAL" ? m[1] : "#" + nr;
  const aus = { ONE: 11, TWO: 22, THREE: 33 }[marker] || 40 + nr;
  if (text.includes("WAIT")) await gate("sub");
  say({ type: "assistant", message: { id: "sub-" + marker, usage: { input_tokens: 100, output_tokens: aus },
    content: [{ type: "tool_use", id: "toolu_sub_" + marker.replace("#", "n"), name: "Read", input: { file_path: "/tmp/" + marker } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub_" + marker.replace("#", "n"), content: "read" }] } });
  say({ type: "assistant", message: { id: "sub-t-" + marker, content: [{ type: "text", text: "Finding " + marker }] } });
  finished();
  say({ type: "result", result: "Finding " + marker, session_id: "sub-" + marker });`;

// Fake Codex with one procedure per keyword in the prompt. Every step speaks like `codex exec --json` 0.153.1:
// `item.started`/`item.completed` of an `mcp_tool_call` (with `arguments` resp. the result), in between the REAL
// MCP call with Codex `_meta` (callId/itemId, no toolUseId - measured, t23-meta-fang.mjs).
const fakeCodexProcedure = () => `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const LOCATION = ${JSON.stringify(LOCATION)};
// Atomic: a test often waits only for the EXISTENCE of a file and then reads it - without the rename it read an empty one
// under load. pids/ and gates/ are enumerated and stay raw, as do calls with options.
{ const raw = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { if (typeof p !== "string" || o !== undefined || p.split(path.sep).some((s) => s === "pids" || s === "gates")) return raw(p, d, o); const t = path.join(path.dirname(p), "." + path.basename(p) + ".teil-" + process.pid); raw(t, d); fs.renameSync(t, p); }; }
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
const argv = process.argv.slice(2);
const joined = argv.join(" ");
const ri = argv.indexOf("resume");
const cfg = { env: {} };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "-c") continue;
  const m = /^mcp_servers\\.cbase\\.(command|args|env\\.(\\w+))=(.*)$/.exec(argv[i + 1] || "");
  if (!m) continue;
  const value = JSON.parse(m[3]);
  if (m[1] === "command") cfg.command = value; else if (m[1] === "args") cfg.args = value; else cfg.env[m[2]] = value;
}
function mcpCall(name, args, meta) {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "inherit"], detached: true });
    try { fs.writeFileSync(path.join(LOCATION, "pids", "g" + child.pid), "mcp"); } catch {}
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) { try { child.stdin.end(); } catch {} resolve(m.result || {}); }
      }
    });
    child.on("error", reject);
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, _meta: meta } });
  });
}
function gate(name) {
  const file = path.join(LOCATION, "gates", name);
  try { fs.writeFileSync(file + ".waiting", String(process.pid)); } catch {}
  return new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); resolve(); } }, 20); });
}
// Foreground explicitly (background is the default): these tests measure the assignment within the turn.
const job = (word, extra = {}) => ({ description: "Part " + word, prompt: "Task " + word, model: ${JSON.stringify(SUB_MODEL)}, run_in_background: false, ...extra });
let n = 0;
const on = (id, args) => say({ type: "item.started", item: { id, type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: args, status: "in_progress" } });
const call = (args) => { n += 1; return mcpCall("cbase_agent", args, { callId: "call_" + n, itemId: "fc_" + n, threadId: "codex-thread", "x-codex-turn-metadata": { turn_id: "t1" } }); };
const zu = (id, args, r) => say({ type: "item.completed", item: { id, type: "mcp_tool_call", server: "cbase", tool: "cbase_agent", arguments: args,
  result: { content: r.content || [], structured_content: null }, status: r.isError ? "failed" : "completed" } });
const results = [];
const remember = (r) => { results.push(r); fs.writeFileSync(path.join(LOCATION, "codex-results-" + process.pid + ".json"), JSON.stringify(results)); return r; };

(async () => {
  say({ type: "thread.started", thread_id: ri >= 0 ? argv[ri + 1] : "codex-thread" });
  say({ type: "turn.started" });
  if (ri < 0) {
    if (joined.includes("TWO-GRANDCHILD")) {
      // A Codex SUBAGENT starts two grandchildren with equal arguments before the first block closes - and
      // keeps both blocks open until the test opens the gate (the grandchildren have reported by then).
      const a = job("EQUAL WAIT", { run_in_background: true });
      on("item_e1", a); const r1 = remember(await call(a));
      on("item_e2", a); const r2 = remember(await call(a));
      await gate("codex-closed");
      zu("item_e1", a, r1); zu("item_e2", a, r2);
    } else if (joined.includes("PROCEDURE-UNDER")) {
      // The main agent starts the Codex subagent that starts the two grandchildren (branch above).
      const a = job("CODEX TWO-GRANDCHILD", { model: "codex::gpt-5.6-sol" });
      on("item_1", a); zu("item_1", a, remember(await call(a)));
    } else if (joined.includes("PROCEDURE-SEQUENTIAL")) {
      // Two calls in ONE turn - the way 0.153.1 executes them: one after another, one open block each.
      for (const [id, w] of [["item_1", "ONE"], ["item_2", "TWO"]]) { const a = job(w); on(id, a); zu(id, a, remember(await call(a))); }
    } else if (joined.includes("PROCEDURE-STAGE1")) {
      // Two blocks open, different tasks, the requests arrive in REVERSED order.
      const a1 = job("ONE"), a2 = job("TWO");
      on("item_1", a1); on("item_2", a2);
      const r2 = remember(await call(a2)); const r1 = remember(await call(a1));
      zu("item_2", a2, r2); zu("item_1", a1, r1);
    } else if (joined.includes("PROCEDURE-STAGE2")) {
      // Two blocks open with BYTE-IDENTICAL arguments; the first request belongs to item_2 (arrived swapped).
      const a = job("EQUAL");
      on("item_1", a); on("item_2", a);
      const first = remember(await call(a)); const second = remember(await call(a));
      zu("item_2", a, first); zu("item_1", a, second);
    } else if (joined.includes("PROCEDURE-NONE")) {
      // Two blocks open, the request matches neither: hard error with a reason.
      const a1 = job("ONE"), a2 = job("TWO");
      on("item_1", a1); on("item_2", a2);
      const r = remember(await call(job("THREE")));
      zu("item_1", a1, r); zu("item_2", a2, r);
    } else if (joined.includes("PROCEDURE-BACKGROUND")) {
      // Three background agents one after another: each block closes with the start answer, the agents keep running.
      for (const [id, w] of [["item_1", "ONE"], ["item_2", "TWO"], ["item_3", "THREE"]]) {
        const a = job(w + " WAIT", { run_in_background: true }); on(id, a); zu(id, a, remember(await call(a)));
      }
    } else if (joined.includes("PROCEDURE-GATE")) {
      // Block open, then wait until the test opens the gate - two chats stand there SIMULTANEOUSLY with an open block.
      const w = /PROCEDURE-GATE (\\w+)/.exec(joined)[1];
      const a = job(w); on("item_1", a); await gate("codex-" + w); zu("item_1", a, remember(await call(a)));
    }
  }
  say({ type: "item.completed", item: { id: "response", type: "agent_message", text: "finished" } });
  say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
})();
`;

const newChat = (base, ws, provider, model) => json(`${base}/api/chats`, {
  method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider, model, permissionMode: "bypassPermissions" }),
});
const send = (base, chatId, text) => json(`${base}/api/chats/${chatId}/message`, { method: "POST", body: JSON.stringify({ text }) });
const rows = (log, role) => log.filter((m) => m.role === role).map((m) => JSON.parse(m.text));

// What sits under a block: text and tool rows of its subagents, its (last) result.
function under(log, block) {
  const result = rows(log, "tool_result").filter((r) => r.id === block).at(-1);
  return {
    texts: rows(log, "sub_text").filter((t) => t.parent === block).map((t) => t.text),
    tools: rows(log, "tool").filter((t) => t.parent === block).map((t) => t.id),
    result: result ? String(result.result) : "",
  };
}
const report = (text) => { try { return JSON.parse(text); } catch { return null; } };

test("call-blocks: canonical comparison, agentId from the result, assignment per stream", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: "x" } }), canonical({ a: { c: "x", d: [2, { x: 0, y: 1 }] }, b: 1 }));
  assert.notEqual(canonical({ a: "1" }), canonical({ a: 1 }));
  assert.equal(canonical({ a: 1, callId: "x" }), canonical({ a: 1 }), "the call id is not an argument");
  assert.equal(agentIdFromResult(JSON.stringify({ status: "running", agentId: "a1-1" }, null, 2)), "a1-1");
  assert.equal(agentIdFromResult([{ type: "text", text: JSON.stringify({ agentId: "a2-2" }) }]), "a2-2");
  assert.equal(agentIdFromResult("Error: broken"), "");

  const b = createCallBlocks();
  assert.deepEqual(b.assign({ p: 1 }), { wait: true }, "without an open block it waits, it does not guess");
  b.on("x1", { p: 1 }, "stream-a");
  assert.deepEqual(b.assign({ p: 1 }), { wait: true }, "a block of ANOTHER stream does not count");
  assert.deepEqual(b.assign({ p: 1 }, "stream-a"), { block: "x1", provisional: false });
});

// Codex counts item ids anew per process. A subagent P (Codex) calls cbase_agent as `item_2`, its child starts, P is stopped -
// the block never closes. When P resumes (new process), its next call is again `item_2`: until then the old, bound block stayed,
// the start found no free one, waited 5 s and failed. Now the new call applies; a repeated announcement of the same one (equal
// arguments, unbound) stays one.
test("call-blocks: a reused Codex item id in the next process is a NEW block", () => {
  const b = createCallBlocks();
  const stream = "toolu_parent";
  b.on("item_2", { prompt: "Child 1" }, stream);
  assert.deepEqual(b.assign({ prompt: "Child 1" }, stream), { block: "item_2", provisional: false });
  b.bind("item_2", "kind-1", { stream });
  // Resume: new process, same id, a different task.
  b.on("item_2", { prompt: "Child 2" }, stream);
  assert.deepEqual(b.assign({ prompt: "Child 2" }, stream), { block: "item_2", provisional: false }, "the new call is free");
  b.bind("item_2", "kind-2", { stream });
  // The same id with the SAME arguments, but the old one is bound: that too is a new process.
  b.on("item_2", { prompt: "Child 2" }, stream);
  assert.deepEqual(b.assign({ prompt: "Child 2" }, stream), { block: "item_2", provisional: false });
  // A repeated announcement of the same open, unbound call stays ONE block.
  b.on("item_5", { prompt: "x" }, stream);
  b.on("item_5", { prompt: "x" }, stream);
  assert.equal(b.assign({ prompt: "x" }, stream).error, undefined);
});

test("Claude: two cbase_agent calls in ONE response land under their own block - text, tools, report, numbers", async () => {
  const claude = fakeClaude({
    sub: SUB,
    main: `
  const one = { description: "Part ONE", prompt: "Task ONE", run_in_background: false }, two = { description: "Part TWO", prompt: "Task TWO", run_in_background: false };
  say({ type: "assistant", message: { id: "main-1", content: [
    { type: "tool_use", id: "toolu_one", name: "mcp__cbase__cbase_agent", input: one },
    { type: "tool_use", id: "toolu_two", name: "mcp__cbase__cbase_agent", input: two }] } });
  const r1 = textOf(await mcpCall("cbase_agent", one));
  const r2 = textOf(await mcpCall("cbase_agent", two));
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_one", content: r1 }, { type: "tool_result", tool_use_id: "toolu_two", content: r2 }] } });
  say({ type: "assistant", message: { id: "main-2", content: [{ type: "text", text: "finished" }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  });
  await withAgentsServer(async ({ base, chat, waitForLog }) => {
    await send(base, chat.id, "Two subtasks");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    for (const [block, marker, tokens] of [["toolu_one", "ONE", 111], ["toolu_two", "TWO", 122]]) {
      const u = under(log, block);
      assert.deepEqual(u.texts, [`Finding ${marker}`], `text under ${block}`);
      assert.deepEqual(u.tools, [`toolu_sub_${marker}`], `tool rows under ${block}`);
      const r = report(u.result);
      assert.equal(r?.report, `Finding ${marker}`, `report under ${block}`);
      assert.equal(r?.totalTokens, tokens, `numbers under ${block}`);
    }
  }, { claude });
});

test("Without a call id nothing is guessed: clear error to the agent, one console line, no subagent", async () => {
  const claude = fakeClaude({
    sub: SUB,
    main: `
  const a = { description: "Part ONE", prompt: "Task ONE" };
  say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_without", name: "mcp__cbase__cbase_agent", input: a }] } });
  const res = await mcpCall("cbase_agent", a, null);
  say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_without", content: textOf(res), is_error: Boolean(res.result && res.result.isError) }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  });
  const warnings = [];
  const warnPrior = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  try {
    await withAgentsServer(async ({ base, chat, waitForLog }) => {
      await send(base, chat.id, "Without id");
      const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
      const r = rows(log, "tool_result").find((x) => x.id === "toolu_without");
      assert.equal(r.isError, true, "the call ends as an error");
      assert.match(r.result, /no call id/);
      assert.equal(rows(log, "sub_text").length + rows(log, "tool").filter((t) => t.parent).length, 0, "no subagent ran");
    }, { claude });
  } finally {
    console.warn = warnPrior;
  }
  assert.ok(warnings.some((w) => w.includes("without a call id")), `console line: ${warnings.join(" | ")}`);
});

test("Loop engine: two tool calls in ONE response of the preset land under their own block", async () => {
  const call = (id, w) => ({ id, name: "mcp__cbase__cbase_agent", arguments: { description: "Part " + w, prompt: "Task " + w, model: SUB_MODEL, run_in_background: false } });
  const round = (b) => ((b.messages || []).some((m) => m.role === "tool") ? null : { toolCalls: [call("call_one", "ONE"), call("call_two", "TWO")] });
  await withAgentsServer(async ({ base, ws, engine, waitForLog }) => {
    const chat = await newChat(base, ws, engine.id, "m1");
    await send(base, chat.id, "Two subtasks");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    for (const [block, marker] of [["call_one", "ONE"], ["call_two", "TWO"]]) {
      const u = under(log, block);
      assert.deepEqual(u.texts, [`Finding ${marker}`], `text under ${block}`);
      assert.deepEqual(u.tools, [`toolu_sub_${marker}`], `tool rows under ${block}`);
      assert.match(u.result, new RegExp(`Finding ${marker}`), `report under ${block}`);
    }
  }, { claude: fakeClaude({ sub: SUB }), engine: { round } });
});

test("Codex: two MCP calls in one turn (one after another, like 0.153.1) land under their own block", async () => {
  await withAgentsServer(async ({ base, ws, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-SEQUENTIAL");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    for (const [block, marker] of [["item_1", "ONE"], ["item_2", "TWO"]]) {
      const u = under(log, block);
      assert.deepEqual(u.texts, [`Finding ${marker}`], `text under ${block}`);
      assert.deepEqual(u.tools, [`toolu_sub_${marker}`], `tool rows under ${block}`);
    }
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

test("Codex stage 1: two open blocks, different tasks, requests reversed - the arguments decide", async () => {
  await withAgentsServer(async ({ base, ws, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-STAGE1");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    for (const [block, marker] of [["item_1", "ONE"], ["item_2", "TWO"]]) {
      assert.deepEqual(under(log, block).texts, [`Finding ${marker}`], `text under ${block}`);
    }
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

test("Codex stage 2: equal arguments in two open blocks, arrived swapped - after closing both are right", async () => {
  await withAgentsServer(async ({ base, ws, root, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-STAGE2");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const file = fs.readdirSync(root).find((f) => f.startsWith("codex-results-"));
    const [first, second] = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).map((r) => agentIdFromResult(r.content));
    assert.ok(first && second && first !== second, "two agents started");
    // The first request (subagent #1) belonged to item_2, the second (#2) to item_1.
    assert.deepEqual(under(log, "item_2").texts, ["Finding #1"], "subagent #1 under item_2");
    assert.deepEqual(under(log, "item_1").texts, ["Finding #2"], "subagent #2 under item_1");
    assert.deepEqual(under(log, "item_2").tools, ["toolu_sub_n1"]);
    assert.deepEqual(under(log, "item_1").tools, ["toolu_sub_n2"]);
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

test("Codex: if the request matches no open block, it ends with the reason - no subagent", async () => {
  await withAgentsServer(async ({ base, ws, root, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-NONE");
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
    const file = fs.readdirSync(root).find((f) => f.startsWith("codex-results-"));
    const [r] = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /none carries exactly these arguments/);
    assert.equal(rows(log, "sub_text").length, 0, "no subagent ran");
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

test("Codex: three background agents one after another run simultaneously, each under its own block - blocks are counted, not agents", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForTruthy, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-BACKGROUND");
    const live = await waitForTruthy(() => {
      const z = liveAgents().filter((a) => a.chatId === chat.id);
      return z.length === 3 ? z : null;
    }, "three live subagents");
    assert.deepEqual(live.map((z) => z.toolUseId).sort(), ["item_1", "item_2", "item_3"]);
    gate.open("sub");
    const log = await waitForLog(chat.id, (l) => ["item_1", "item_2", "item_3"].every((b) => under(l, b).texts.length));
    for (const [block, marker] of [["item_1", "ONE"], ["item_2", "TWO"], ["item_3", "THREE"]]) {
      assert.deepEqual(under(log, block).texts, [`Finding ${marker}`], `text under ${block}`);
    }
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

test("Codex: two Codex agents each start a subagent at the same time - open counts per stream, both land correctly", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForLog }) => {
    const a = await newChat(base, ws, "codex", "gpt-5.6-sol");
    const b = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, a.id, "PROCEDURE-GATE ONE");
    await send(base, b.id, "PROCEDURE-GATE TWO");
    await gate.reached("codex-ONE");
    await gate.reached("codex-TWO");
    gate.open("codex-ONE");
    gate.open("codex-TWO");
    for (const [chat, marker] of [[a, "ONE"], [b, "TWO"]]) {
      const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));
      assert.deepEqual(under(log, "item_1").texts, [`Finding ${marker}`], `Chat ${marker}`);
      assert.equal(rows(log, "tool_result").find((r) => r.id === "item_1")?.isError, false, `no error in chat ${marker}`);
    }
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});

// The call block of a grandchild is bound in the SUB-STREAM (runs/agents.js onStart passes `stream` to `blocks.bind`). Without it
// the first block stayed "free" in the sub-stream: the second grandchild was provisionally assigned the SAME block, the first
// one's events landed in its buffer and with its confirmation under the second block.
// Counter-test (shown red once): `stream` omitted in onStart => under item_e1 nothing sits, under item_e2 both findings.
test("Codex subagent starts two grandchildren with equal arguments before a block closes - each hangs on its own block, the back-confirmation works in the sub-stream", async () => {
  await withAgentsServer(async ({ base, ws, gate, waitForTruthy, waitForLog }) => {
    const chat = await newChat(base, ws, "codex", "gpt-5.6-sol");
    await send(base, chat.id, "PROCEDURE-UNDER");
    await gate.reached("codex-closed");
    const grandchild = liveAgents().filter((a) => a.chatId === chat.id && a.toolUseId.startsWith("item_e"));
    assert.deepEqual(grandchild.map((a) => a.toolUseId).sort(), ["item_e1", "item_e2"], JSON.stringify(grandchild));
    // The grandchildren report WHILE both blocks are open: the second is provisional (same arguments as the first).
    gate.open("sub");
    const ids = grandchild.map((a) => a.agentId);
    await waitForTruthy(() => (liveAgents().some((a) => ids.includes(a.agentId)) ? null : true), "both grandchildren are done");
    gate.open("codex-closed");
    const log = await waitForLog(chat.id, (l) => under(l, "item_e1").texts.length + under(l, "item_e2").texts.length >= 2
      && l.some((m) => m.role === "meta"));
    assert.deepEqual(under(log, "item_e1").texts, ["Finding #1"], "grandchild #1 under its block");
    assert.deepEqual(under(log, "item_e2").texts, ["Finding #2"], "grandchild #2 under its block");
    assert.deepEqual(under(log, "item_e1").tools, ["toolu_sub_n1"]);
    assert.deepEqual(under(log, "item_e2").tools, ["toolu_sub_n2"]);
  }, { claude: fakeClaude({ sub: SUB }), codex: fakeCodexProcedure() });
});
