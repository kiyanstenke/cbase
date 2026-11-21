// The prompt structure of the loop engine for OpenRouter: one guard per finding.
//
//   1  From turn 2 on the preambles of the first turn were missing (agenda, hints, ultracode, summary): buildTranscript
//      replayed only what was typed, and the engine's session id counted as "resumed" — the agenda never came again, the
//      prompt cache broke at the first user message. Now: role `input` (runs/do-run.js) and byte-identical replay
//      (providers/transcript.js).
//   2  Short names (cbase_agenda) worked neither in ToolSearch nor at the call — now mapped unambiguously to the full name.
//   3  BashOutput/KillShell were in the offer, Bash rejects run_in_background — both gone, the field out of the Bash schema.
//   4  No environment block — now in the system prompt (working directory, directories, platform), the date as a line at
//      the turn.
//   5  "deferred tools cannot be called directly" was wrong — the sentence is honest.
//   6  Read appended an empty phantom line after a final line break.
//   7  TodoWrite.status without an enum.
//   8  Schemas that strict endpoints reject (Grep "-i" …, dynamic_workflow.args without a type); reference to Claude Code's tool.
//   9  Anthropic models via OpenRouter without cache_control.
//
// Counter-tests: see the comments at the tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_NOT_PROVIDED, dateLine, todayIso, runChatViaEngine } from "../electron/server/providers/engine.js";
import { builtinToolDefs, runBuiltinTool } from "../electron/server/providers/tool-runtime.js";
import { buildTranscript } from "../electron/server/providers/transcript.js";
import { makeOpenRouterConnector } from "../electron/server/providers/connectors/openrouter.js";
import { strictSchema } from "../electron/server/providers/connectors/openai-chat.js";
import { withAgentsServer, json } from "./agent-harness.mjs";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-audit-"));
const rm = (r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const D = `${dateLine(todayIso())}\n\n`;

function connector({ turns }) {
  let n = 0;
  const seen = [];
  return {
    id: "fake", label: "fake",
    models: [{ id: "m1", label: "M1", context: 200_000 }],
    caps: { ownsAgentLoop: false, nativeToolCalling: true, streaming: false, subagents: false, vision: false },
    cleanEnv: () => ({}),
    resolveModel: (m) => m || "m1",
    runOnce: async () => "",
    seen,
    complete: async (a) => {
      seen.push(JSON.parse(JSON.stringify({ tools: a.tools, messages: a.messages })));
      const turn = turns[Math.min(n, turns.length - 1)];
      n++;
      return { text: "", thinking: "", toolCalls: [], usage: { input: 1, output: 1, cached: 0 }, stop: "end", ...turn(a, n - 1) };
    },
  };
}
async function runEngine(conn, spec) {
  const events = [];
  let handle;
  const holders = setInterval(() => {}, 1 << 30);
  try {
    const res = await runChatViaEngine(conn, {
      spec: { input: "go", systemPrompt: "SYS", addDirs: [], permissionMode: "bypassPermissions", mcpServers: {}, model: "", effort: "", engine: {}, transcript: [], ...spec },
      onSpawn: (h) => { handle = h; },
      onEvent: (e) => { events.push(e); if (e.type === "result") handle.cbaseEndInput(); },
    });
    return { res, events };
  } finally { clearInterval(holders); }
}
const toolResults = (events) => events.filter((e) => e.type === "user" && e.message?.content?.[0]?.type === "tool_result").map((e) => e.message.content[0]);

// Two MCP servers: `a` with 50 tools (above the deferral threshold of 45) and `duplicate`, which carries one name of `a` again.
const SERVER_SRC = (name, names) => `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const tools = ${JSON.stringify(names)}.map((n) => ({ name: n, description: "Test tool " + n, inputSchema: { type: "object", properties: {} } }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: ${JSON.stringify(name)}, version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: ${JSON.stringify(name)} + " called " + msg.params.name }] } });
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
`;

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: providers/transcript.js resp. runs/do-run.js in their state before the fix => red.
test("1: turn 2 and turn 3 (after a restart) begin with the bytes of the last request before them — including the agenda and hint preamble", async () => {
  const { changeAgenda } = await import("../electron/server/agenda/change.js");
  const { depositHint } = await import("../electron/server/runs/hints.js");
  const store = await import("../electron/server/store.js");
  const round = async (b) => {
    const hasTool = (b.messages || []).some((m) => m.role === "tool");
    if (b.tools?.length && !hasTool) return { toolCalls: [{ id: "call_r1", name: "Read", arguments: { file_path: "note.txt" } }] };
    return { text: "Response" };
  };
  await withAgentsServer(async (ctx) => {
    const { base, ws, waitForTruthy, waitForIdle, engine, root } = ctx;
    fs.writeFileSync(path.join(root, "workspace", "note.txt"), "Line one\n");
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "openrouter", model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Audit" }) });
    changeAgenda(chat.id, ws.id, { title: "Plan X", description: "Goal Y", steps: [{ op: "fresh", text: "Step A" }] }, { originator: "server" });
    const limits = [];
    const turn = async (text, target) => {
      const from = engine.requests.length;
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      await waitForTruthy(async () => {
        const log = await json(`${base}/api/chats/${chat.id}/log`);
        return log.filter((m) => m.role === "assistant").length >= target;
      }, `reply ${target}`);
      await waitForIdle();
      limits.push({ from, until: engine.requests.length });
    };
    await turn("T1 read note", 1);
    depositHint(chat.id, "TESTHINT before T2", { source: "audit" });
    await turn("T2 second question", 2);
    await ctx.restart();
    await turn("T3 after restart", 3);

    const A = engine.requests;
    const agendaIn = (req) => req.messages.filter((m) => m.role === "user" && /Plan X/.test(JSON.stringify(m.content))).length;
    assert.match(JSON.stringify(A[0].messages[1].content), /Plan X/, "turn 1 carries the agenda (otherwise this test checks nothing)");
    for (const k of [1, 2]) {
      const last = A[limits[k - 1].until - 1];
      const first = A[limits[k].from];
      assert.equal(first.messages[0].content, last.messages[0].content, `turn ${k + 1}: system prompt`);
      assert.deepEqual(first.tools, last.tools, `turn ${k + 1}: tools`);
      for (let i = 1; i < last.messages.length; i++) {
        assert.deepEqual(first.messages[i], last.messages[i], `turn ${k + 1}: message ${i} differs — the prefix cache breaks there`);
      }
      assert.equal(agendaIn(first), 1, `turn ${k + 1}: the agenda appears exactly once in the history (replayed, not prepended anew)`);
    }
    // The hint before T2 stands in T3 where the model read it in T2.
    const firstT3 = A[limits[2].from];
    assert.ok(firstT3.messages.some((m) => m.role === "user" && /TESTHINT before T2/.test(String(m.content)) && /T2 second question/.test(String(m.content))));
    assert.equal(firstT3.messages.at(-1).content, "T3 after restart", "the history already names the date — T3 carries no second date line");
    // The clients see only what was typed, no `input` row, and the counters match the history.
    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(!log.some((m) => m.role === "input"), "an `input` row in the clients' history");
    assert.deepEqual(log.filter((m) => m.role === "user").map((m) => m.text), ["T1 read note", "T2 second question", "T3 after restart"]);
    const stats = store.messageStats(chat.id);
    assert.equal(stats.total, log.length);
    assert.equal(stats.lastId, Math.max(...log.map((m) => m.id)));
    assert.equal(store.listMessagesWithInputs(chat.id).filter((m) => m.role === "input").length, 3, "one `input` row per turn");
  }, { engine: { round } });
});

// The retry without a session (runs/do-run.js: exit != 0 without an answer with a session id set): it takes back the
// failed attempt's input — in the lookback the turn appears ONCE.
// Counter-test: do-run.js with `if (false)` instead of the call of `store.deleteInputs` => red; do-run.js in its old state => red.
test("1: a failed attempt leaves no second input — the retry takes back its own", async () => {
  const store = await import("../electron/server/store.js");
  let fail = false;
  const round = async () => {
    if (fail) { fail = false; return { status: 400, body: { error: { message: "broken" } } }; }
    return { text: "Response" };
  };
  await withAgentsServer(async ({ base, ws, waitForTruthy, waitForIdle, engine }) => {
    const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "openrouter", model: "m1", permissionMode: "bypassPermissions" }) });
    await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Retry" }) });
    const turn = async (text, target) => {
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      await waitForTruthy(async () => (await json(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "assistant").length >= target, `reply ${target}`);
      await waitForIdle();
    };
    await turn("T1", 1);
    fail = true;
    await turn("T2 second", 2);
    assert.equal(fail, false, "the first attempt of T2 failed (otherwise this test checks nothing)");
    const beforeT3 = engine.requests.length;
    await turn("T3", 3);
    const inputs = store.listMessagesWithInputs(chat.id).filter((m) => m.role === "input");
    assert.equal(inputs.length, 3, inputs.map((m) => m.text).join("\n"));
    const t3 = engine.requests[beforeT3];
    assert.equal(t3.messages.filter((m) => m.role === "user" && String(m.content).includes("T2 second")).length, 1, "T2 appears once in the lookback");
  }, { engine: { round } });
});

// The gap rule, pure: an input replaces the user rows of its gap (even one written AFTER it), a subagent row does not end
// the gap, without an input everything stays as before, and `beginningPreserved` says whether the input with the preambles is there.
// Counter-test: dropping `&& state() !== prior` (every model row ends the gap, a subagent's too) => red; transcript.js in its
// old state => red.
test("1: buildTranscript — the input replaces the user rows of its gap, untrimmed; without an input as before", () => {
  const e = (text, beginning = false) => ({ role: "input", text: JSON.stringify({ text, beginning }) });
  const rows = [
    { role: "user", text: "hello" }, e("[Agenda]\n\nhello  ", true), { role: "assistant", text: "a1" },
    { role: "user", text: "second" },
    { role: "tool", text: JSON.stringify({ name: "Read", id: "s1", input: {}, parent: "agent1" }) }, // subagent, on the side
    e("[Hint]\n\nsecond"), { role: "assistant", text: "a2" },
    e("injected"), { role: "user", text: "injected (row after)" }, { role: "assistant", text: "a3" },
    { role: "user", text: "without input (Claude turn)" }, { role: "assistant", text: "a4" },
    { role: "user", text: "now" },
  ];
  const t = buildTranscript(rows, { contextWindow: 200_000 });
  assert.deepEqual(t.map((m) => m.content), ["[Agenda]\n\nhello  ", "a1", "[Hint]\n\nsecond", "a2", "injected", "a3", "without input (Claude turn)", "a4"]);
  assert.equal(t.beginningPreserved, true);
  assert.equal(buildTranscript(rows.filter((r) => r.role !== "input"), { contextWindow: 200_000 }).beginningPreserved, false);
});

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-test: `fullName` as identity => red.
test("2: short names — ToolSearch select and call map the unambiguous short name, an ambiguous one names the candidates", async () => {
  const root = tmpRoot();
  try {
    const a = path.join(root, "a.mjs");
    const b = path.join(root, "b.mjs");
    fs.writeFileSync(a, SERVER_SRC("a", Array.from({ length: 50 }, (_, i) => `tool_${i}`)));
    fs.writeFileSync(b, SERVER_SRC("duplicate", ["tool_9"]));
    const conn = connector({ turns: [
      () => ({ toolCalls: [{ id: "c1", name: "ToolSearch", input: { query: "select:tool_3" } }], stop: "tool_calls" }),
      () => ({ toolCalls: [{ id: "c2", name: "tool_3", input: {} }, { id: "c3", name: "tool_5", input: {} }, { id: "c4", name: "tool_9", input: {} }], stop: "tool_calls" }),
      () => ({ toolCalls: [{ id: "c5", name: "ToolSearch", input: { query: "select:tool_9" } }], stop: "tool_calls" }),
      () => ({ text: "finished" }),
    ] });
    const { res, events } = await runEngine(conn, { cwd: root, mcpServers: { a: { command: process.execPath, args: [a] }, duplicate: { command: process.execPath, args: [b] } } });
    assert.equal(res.code, 0, res.stderr);
    const r = toolResults(events);
    assert.equal(r[0].is_error, false, String(r[0].content));
    assert.match(String(r[0].content), /mcp__a__tool_3/);
    assert.ok(conn.seen[1].tools.some((t) => t.name === "mcp__a__tool_3"), "after ToolSearch with the short name the tool is loaded");
    assert.equal(r[1].is_error, false, String(r[1].content));
    assert.match(String(r[1].content), /a called tool_3/);
    assert.match(String(r[2].content), /a called tool_5/, "also a not yet loaded deferred tool under its short name");
    assert.equal(r[3].is_error, true);
    assert.match(String(r[3].content), /ambiguous.*mcp__a__tool_9.*mcp__duplicate__tool_9/);
    assert.equal(r[4].is_error, true);
    assert.match(String(r[4].content), /ambiguous.*mcp__a__tool_9.*mcp__duplicate__tool_9/);
    // Event and history carry the full name (runs/do-run.js recognizes calls by it).
    const calls = events.filter((e) => e.type === "assistant").flatMap((e) => e.message.content).filter((x) => x.type === "tool_use").map((x) => x.name);
    assert.deepEqual(calls.slice(1, 3), ["mcp__a__tool_3", "mcp__a__tool_5"]);
  } finally { rm(root); }
});

// ── 3, 4, 5 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-tests: ENGINE_NOT_PROVIDED without BashOutput/KillShell => red; the date line switched off => red;
// tool-runtime.js in its old state (Bash with run_in_background) => red. The same check catches the environment block and
// the sentence on deferred tools.
test("3–5: offer without BashOutput/KillShell and without run_in_background, environment block, date line, honest sentence on deferred tools", async () => {
  const root = tmpRoot();
  try {
    const a = path.join(root, "a.mjs");
    fs.writeFileSync(a, SERVER_SRC("a", Array.from({ length: 50 }, (_, i) => `tool_${i}`)));
    const conn = connector({ turns: [
      () => ({ toolCalls: [{ id: "c1", name: "BashOutput", input: { bash_id: "x" } }, { id: "c2", name: "KillShell", input: { shell_id: "x" } }], stop: "tool_calls" }),
      () => ({ text: "finished" }),
    ] });
    const { events } = await runEngine(conn, { cwd: root, addDirs: [path.join(root, "extra")], mcpServers: { a: { command: process.execPath, args: [a] } } });
    const names = conn.seen[0].tools.map((t) => t.name);
    for (const n of ["BashOutput", "KillShell"]) {
      assert.ok(!names.includes(n), `${n} in the offer`);
      assert.ok(ENGINE_NOT_PROVIDED.has(n));
    }
    for (const e of toolResults(events)) assert.match(String(e.content), /is not available in this chat/);
    const bash = conn.seen[0].tools.find((t) => t.name === "Bash");
    assert.ok(bash && !("run_in_background" in bash.inputSchema.properties), "run_in_background in the Bash schema");
    assert.match(bash.description, /run_in_background/, "the rule itself stays in the description");
    const sys = conn.seen[0].messages[0].content;
    assert.match(sys, /# Environment/);
    assert.ok(sys.includes(`Working directory: ${root}`));
    assert.ok(sys.includes(path.join(root, "extra")));
    assert.ok(sys.includes(`Platform: ${process.platform}`));
    assert.ok(!sys.includes(todayIso()), "the date is NOT in the system prompt (cache)");
    assert.equal(conn.seen[0].messages[1].content, `${D}go`, "the date stands as a line before the first input");
    assert.doesNotMatch(sys, /not call (them )?directly|cannot be called directly/);
    assert.match(sys, /so you do not know their parameters/);
    assert.doesNotMatch(conn.seen[0].tools.find((t) => t.name === "ToolSearch").description, /Only (after that|then) can they be called/i);
    // If the history already carries today's date, no second line comes.
    const conn2 = connector({ turns: [() => ({ text: "ok" })] });
    await runEngine(conn2, { cwd: root, input: "further", transcript: [{ role: "user", content: `${D}go` }, { role: "assistant", content: "finished" }] });
    assert.equal(conn2.seen[0].messages.at(-1).content, "further");
  } finally { rm(root); }
});

// ── 6, 7, 8 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-tests: tool-runtime.js in its old state (phantom line, status without an enum, "-i") => red;
// mcp/tools/dynworkflows.js in its old state => red. The effect of strictSchema on the wire is checked by test 9
// (toOpenAiTools without strictSchema => red there).
test("6–8: Read without a phantom line, TodoWrite.status with an enum, schemas for strict endpoints", async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, "n.txt"), "Line one\nLine two\n");
    const ctx = { cwd: root, addDirs: [], env: process.env };
    const r = await runBuiltinTool("Read", { file_path: "n.txt" }, ctx);
    assert.equal(r.content, "     1\tLine one\n     2\tLine two");
    fs.writeFileSync(path.join(root, "o.txt"), "no line break");
    assert.equal((await runBuiltinTool("Read", { file_path: "o.txt" }, ctx)).content, "     1\tno line break");
    fs.writeFileSync(path.join(root, "empty.txt"), "a\n\n");
    assert.equal((await runBuiltinTool("Read", { file_path: "empty.txt" }, ctx)).content, "     1\ta\n     2\t", "a real empty line stays");

    const defs = Object.fromEntries(builtinToolDefs().map((d) => [d.name, d]));
    assert.deepEqual(defs.TodoWrite.inputSchema.properties.todos.items.properties.status.enum, ["pending", "in_progress", "completed"]);
    const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const d of Object.values(defs)) for (const k of Object.keys(d.inputSchema.properties || {})) assert.match(k, NAME, `${d.name}.${k}`);
    // The new Grep names work, the old ones (Claude Code's Grep) still do.
    fs.writeFileSync(path.join(root, "g.txt"), "one\nTWO\nthree\n");
    const fresh = await runBuiltinTool("Grep", { pattern: "two", path: "g.txt", case_insensitive: true, context: 1, line_numbers: false }, ctx);
    const old = await runBuiltinTool("Grep", { pattern: "two", path: "g.txt", "-i": true, "-C": 1, "-n": false }, ctx);
    assert.equal(fresh.content, old.content);
    assert.match(fresh.content, /one[\s\S]*TWO[\s\S]*three/);

    // strictSchema: a field without a type gets anyOf, typed ones stay untouched (also nested).
    const raw = { type: "object", properties: { args: { description: "anything" }, n: { type: "integer" }, list: { type: "array", items: { type: "object", properties: { x: {} } } } } };
    const strict = strictSchema(raw);
    assert.ok(Array.isArray(strict.properties.args.anyOf) && strict.properties.args.anyOf.every((s) => s.type), JSON.stringify(strict.properties.args));
    assert.equal(strict.properties.args.description, "anything");
    assert.equal(strict.properties.n, raw.properties.n);
    assert.ok(Array.isArray(strict.properties.list.items.properties.x.anyOf));
    assert.equal(raw.properties.args.anyOf, undefined, "the MCP schema itself stays unchanged");

    const source = fs.readFileSync(new URL("../electron/mcp/tools/dynworkflows.js", import.meta.url), "utf8");
    const set = /name: "cbase_dynamic_workflow",[\s\S]*?description: "([^"]*)/.exec(source)?.[1] || "";
    assert.ok(set, "description of cbase_dynamic_workflow not found");
    assert.doesNotMatch(set, /Claude Code/);
    assert.match(set, /agent\(\)\/parallel\(\)\/pipeline\(\)\/phase\(\)/);
  } finally { rm(root); }
});

// ── 9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Counter-tests: openrouter.js in its old state (without `cacheMarkers`) => red; toOpenAiTools without strictSchema => red.
test("9: OpenRouter — cache_control on the system block and at the top of the body, only for anthropic/*; tool schemas strict", async () => {
  const conn = makeOpenRouterConnector({ access: () => ({ apiKey: "sk-test", extraBody: {} }) });
  const body = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    body.push(JSON.parse(init.body));
    const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const messages = [{ role: "system", content: "SYSTEM" }, { role: "user", content: "hello" }];
  const tools = [{ name: "cbase_dynamic_workflow", description: "x", inputSchema: { type: "object", properties: { args: { description: "arbitrary" } } } }];
  try {
    for (const model of ["anthropic/claude-sonnet-5.5", "z-ai/glm-5.3"]) await conn.complete({ messages, tools, model, effort: "", signal: undefined, onDelta: () => {} });
  } finally { globalThis.fetch = origFetch; }
  const [anth, glm] = body;
  assert.deepEqual(anth.cache_control, { type: "ephemeral" });
  assert.deepEqual(anth.messages[0], { role: "system", content: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }] });
  assert.equal(anth.messages[1].content, "hello");
  assert.equal(glm.cache_control, undefined);
  assert.equal(glm.messages[0].content, "SYSTEM", "other models: the request stays as it was");
  assert.ok(Array.isArray(glm.tools[0].function.parameters.properties.args.anyOf), "args carries a type on the wire");
  assert.equal(messages[0].content, "SYSTEM", "the engine's messages stay untouched");
});
