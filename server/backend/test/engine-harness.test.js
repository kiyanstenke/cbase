// The loop engine as a whole, against fake connectors: exactly the mechanics that bring our own harness to Claude Code
// level — deferred tool schemas, images for vision-capable providers and the tool restriction. (`Task` through the agent
// core and the scheduled continuation `ScheduleWakeup` are gone — the guard for that stands right below.)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_NOT_PROVIDED, dateLine, todayIso, namesTool, runChatViaEngine } from "../electron/server/providers/engine.js";
import { buildTranscript } from "../electron/server/providers/transcript.js";
import { boundResult, boundToolInput } from "../electron/server/runs/system-prompt.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// The date line with which the engine begins the first input of a run whose history does not yet name the date
// (providers/engine.js `environmentBlock`, guard in engine-prompt-audit.test.js).
const D = `${dateLine(todayIso())}\n\n`;
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "cbase-engine-"));
const rm = (r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

function connector({ id = "fake", vision = false, subagents = true, turns }) {
  let n = 0;
  const seen = [];
  return {
    id, label: id,
    models: [{ id: "m1", label: "M1", context: 200_000 }],
    caps: { ownsAgentLoop: false, nativeToolCalling: true, streaming: false, subagents, vision },
    cleanEnv: () => ({}),
    resolveModel: (m) => m || "m1",
    runOnce: async () => "",
    seen,
    complete: async (a) => {
      seen.push(a);
      const turn = turns[Math.min(n, turns.length - 1)];
      n++;
      return { text: "", thinking: "", toolCalls: [], usage: { input: 1, output: 1, cached: 0 }, stop: "end", ...turn(a, n - 1) };
    },
  };
}

// Runs a run and closes the input only after `results` turns — background work and scheduled continuations need exactly
// this open phase (runs/do-run.js keeps it open in operation). Without a deadline (house rule "no timers in tests"): a
// hanging run shows up at the suite's deadline — a test that turns red on a clock reports the gate's load under
// parallelism, not the error. The holder only keeps the event loop open: the engine sometimes waited on timers with
// unref(), and without it the loop would run empty — node:test would then abort every following test ("Promise resolution
// is still pending…").
// `atResult(handle, n)`: after the n-th `result` (n < results), e.g. to kick off the next turn of the SAME run via
// cbaseInject. `events` (optional): an array into which EVERY event goes at once — so a connector fake sees in the middle of
// its round what the engine has already reported.
async function runEngine(conn, spec, { results = 1, atResult = null, events: eventsValue = null } = {}) {
  const events = [];
  let handle;
  let seen = 0;
  const holders = setInterval(() => {}, 1 << 30);
  try {
    const res = await runChatViaEngine(conn, {
      spec: {
        cwd: spec.cwd, input: spec.input || "los", systemPrompt: spec.systemPrompt || "",
        addDirs: [], permissionMode: "bypassPermissions", mcpServers: spec.mcpServers || {},
        model: "", effort: "", engine: spec.engine || {}, transcript: [],
        ...spec,
      },
      onSpawn: (h) => { handle = h; },
      onEvent: (e) => {
        events.push(e);
        eventsValue?.push(e);
        if (e.type !== "result") return;
        if (++seen >= results) handle.cbaseEndInput();
        else atResult?.(handle, seen);
      },
    });
    return { res, events };
  } finally {
    clearInterval(holders);
  }
}

const toolResults = (events) => events
  .filter((e) => e.type === "user" && e.message?.content?.[0]?.type === "tool_result")
  .map((e) => e.message.content[0]);

// The engine does not provide `Task`, `Monitor`, `TaskStop` and `ScheduleWakeup`: they would duplicate cbase_agent,
// cbase_monitor/_monitor_stop and cbase_wakeup, while the base rule (runs/system-prompt.js) forbade the built-in waiting
// tools. They are not in the offer (not even for a provider with `subagents`, not even with a core passed in), and they are
// rejected at execution — a resumed history can still carry the names, and dispatch by name would otherwise run them.
// Counter-test: an engine that provides all four => all four in the offer, `ScheduleWakeup` schedules ("continuation
// scheduled"), `Task` goes to the core.
test("Task, Monitor, TaskStop and ScheduleWakeup are not provided by the engine — not in the offer, rejected at execution", async () => {
  const root = tmpRoot();
  try {
    // Also BashOutput and KillShell (Bash rejects run_in_background — guard in engine-prompt-audit.test.js).
    assert.deepEqual([...ENGINE_NOT_PROVIDED].sort(), ["BashOutput", "KillShell", "Monitor", "ScheduleWakeup", "Task", "TaskStop"]);
    const calls = [
      { id: "c1", name: "Task", input: { description: "Part work", prompt: "check that" } },
      { id: "c2", name: "Monitor", input: { command: "echo hi", description: "Watch" } },
      { id: "c3", name: "TaskStop", input: { task_id: "x" } },
      { id: "c4", name: "ScheduleWakeup", input: { delaySeconds: 1, prompt: "further", reason: "wait" } },
    ];
    const conn = connector({
      subagents: true,
      turns: [() => ({ toolCalls: calls, stop: "tool_calls" }), () => ({ text: "understood" })],
    });
    const core = [];
    const { res, events } = await runEngine(conn, {
      cwd: root,
      // ON PURPOSE (negative test): the spec field `agents` no longer exists (contract.js) — a spec that carries it anyway
      // must not bring `Task` back to the engine. Likewise `subagents` in the fake's capabilities above.
      agents: { checker: { description: "Checks", prompt: "You check." } },
      // A core passed in and a monitor runtime (the hooks of old) change nothing about that.
      engine: {
        startAgent: async (args) => { core.push(args); return { status: "completed", agentId: "a1", report: "x" }; },
        startMonitor: async () => { core.push("monitor"); return { taskId: "m1" }; },
        stopMonitor: () => { core.push("stop"); return true; },
      },
    });
    const offering = conn.seen[0].tools.map((t) => t.name);
    for (const n of ENGINE_NOT_PROVIDED) assert.ok(!offering.includes(n), `${n} is in the offer: ${offering.join(",")}`);
    const results = toolResults(events);
    assert.equal(results.length, calls.length);
    for (const e of results) {
      assert.equal(e.is_error, true, JSON.stringify(e));
      assert.match(String(e.content), /is not available in this chat/);
    }
    assert.deepEqual(core, [], "nothing went to the core or the monitor runtime");
    assert.equal(conn.seen.length, 2, "main turn and completion — no subagent, no wakeup");
    assert.equal(res.code, 0);
    assert.match(res.resultText, /understood/);
  } finally { rm(root); }
});

test("Read delivers images — but only to providers that can handle images", async () => {
  const root = tmpRoot();
  try {
    const img = path.join(root, "image.png");
    fs.writeFileSync(img, Buffer.from(PNG_B64, "base64"));
    const turns = [
      () => ({ toolCalls: [{ id: "c1", name: "Read", input: { file_path: img } }], stop: "tool_calls" }),
      () => ({ text: "finished" }),
    ];

    const withVision = connector({ vision: true, turns });
    const a = await runEngine(withVision, { cwd: root });
    // The EVENT carries the display version (no base64 through SSE and DB) …
    const shown = toolResults(a.events)[0].content;
    assert.ok(Array.isArray(shown));
    assert.ok(!shown.some((b) => b.type === "image"), "image data does not belong in the event stream");
    // … the MODEL gets the real image block (the engine keeps writing to messages, so look for the tool_result block
    // specifically instead of taking the last message).
    const sentToModel = withVision.seen[1].messages
      .flatMap((mm) => (Array.isArray(mm.content) ? mm.content : []))
      .find((b) => b.type === "tool_result").content;
    assert.equal(sentToModel.find((b) => b.type === "image").source.data, PNG_B64);

    const noVision = connector({ vision: false, turns });
    const b = await runEngine(noVision, { cwd: root });
    const text = toolResults(b.events)[0].content;
    assert.equal(typeof text, "string", "without vision it is folded — no base64 to a text model");
    assert.match(text, /\[Image\]/);
  } finally { rm(root); }
});

// An MCP server with 50 tools — only that takes a run over the deferral threshold (45), even with a set cut down to three
// built-in tools (3 + 50; with 40 it would be 43).
const MANY_SERVER_SRC = `
let buf = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const tools = Array.from({ length: 50 }, (_, i) => ({
  name: "tool_" + i,
  description: i === 7 ? "searches coffee stains in the log" : ("Test tool " + i),
  inputSchema: { type: "object", properties: {} },
}));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "many", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "called: " + msg.params.name }] } });
    else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
`;

test("deferred tool schemas: first the catalog, after ToolSearch the schema", async () => {
  const root = tmpRoot();
  // An MCP server with many tools — only that takes the run over the threshold.
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "ToolSearch", input: { query: "coffee stains" } }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c2", name: "mcp__many__tool_7", input: {} }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    const { events } = await runEngine(conn, { cwd: root, mcpServers: { many: { command: process.execPath, args: [server] } } });

    // Round 1: the 50 MCP schemas are NOT in the package, ToolSearch is.
    const round1 = conn.seen[0].tools.map((t) => t.name);
    assert.ok(round1.includes("ToolSearch"));
    assert.ok(!round1.includes("mcp__many__tool_7"), "deferred schemas must not ride along");
    assert.ok(round1.length < 30, `core set too large: ${round1.length}`);
    // The system prompt names the names, so that the model knows at all that they exist.
    const sys = conn.seen[0].messages[0].content;
    assert.match(sys, /# Deferred tools/);
    assert.match(sys, /mcp__many__tool_7/);

    // ToolSearch delivers the schema …
    const found = toolResults(events)[0];
    assert.match(found.content, /mcp__many__tool_7/);
    // … and from the next round on the tool is really callable.
    assert.ok(conn.seen[1].tools.map((t) => t.name).includes("mcp__many__tool_7"));
    assert.match(toolResults(events)[1].content, /called: tool_7/);
  } finally { rm(root); }
});

// A manager chat has a CUT-DOWN set of built-in tools (Read/Glob/Grep) and 63 MCP tools. The engine deferred the schemas,
// offered ToolSearch and asked for it in the system prompt — and dispatch rejected ToolSearch as "not in the set". The model
// did what the prompt said and stood without a tool.
// The catalog line in the system prompt: per deferred tool the FIRST SENTENCE of the description (mcp/first-set.js), a
// description without a sentence end capped at 200 characters + "…". The sentence of tool_0 is longer than 110 characters and
// carries the sentence-boundary traps (German "z. B.", 2.048, src/app.ts) — counter-test: with the old cut `.slice(0, 110)`
// in engine.js this test is red (the sentence is not entirely there, and the line without a sentence end is 110 instead of
// 200 characters long).
const SET_FIRST = "Prüft eine Rechnung gegen den Vertrag, z. B. Beträge ab 2.048 Euro und Pfade wie src/app.ts, und meldet jede Abweichung mit Zeile.";
const SET_WITHOUT_END = "Word ".repeat(80).trim();
const SET_SERVER_SRC = MANY_SERVER_SRC.replace(
  'description: i === 7 ? "searches coffee stains in the log" : ("Test tool " + i),',
  `description: i === 0 ? ${JSON.stringify(SET_FIRST + " Der zweite Satz bleibt draußen.")} : i === 1 ? ${JSON.stringify(SET_WITHOUT_END)} : ("Test tool " + i + ". Nothing more here."),`,
);
test("deferred tool schemas: the catalog shows the first sentence of the description, a description without a sentence end capped", async () => {
  assert.notEqual(SET_SERVER_SRC, MANY_SERVER_SRC, "the fake server did not take the descriptions");
  assert.ok(SET_FIRST.length > 110, "the first sentence must be longer than the old cut, otherwise the test proves nothing");
  const root = tmpRoot();
  const server = path.join(root, "set.mjs");
  fs.writeFileSync(server, SET_SERVER_SRC);
  try {
    const conn = connector({ turns: [() => ({ text: "finished" })] });
    await runEngine(conn, { cwd: root, mcpServers: { set: { command: process.execPath, args: [server] } } });
    const rows = conn.seen[0].messages[0].content.split("\n");
    const row = (n) => rows.find((z) => z.startsWith(`- mcp__set__${n}: `)) || "";
    assert.equal(row("tool_0"), `- mcp__set__tool_0: ${SET_FIRST}`, "the first sentence stands entirely there, the second does not");
    assert.equal(row("tool_1"), `- mcp__set__tool_1: ${SET_WITHOUT_END.slice(0, 200).trimEnd()}…`, "without a sentence end: 200 characters and “…”");
    assert.equal(row("tool_9"), "- mcp__set__tool_9: Test tool 9.");
  } finally { rm(root); }
});

test("deferred tool schemas: ToolSearch stays callable even with a cut-down tool set", async () => {
  const root = tmpRoot();
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "ToolSearch", input: { query: "select:mcp__many__tool_3" } }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c2", name: "mcp__many__tool_3", input: {} }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c3", name: "Bash", input: { command: "id" } }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    const { events } = await runEngine(conn, { cwd: root, builtinTools: ["Read", "Glob", "Grep"], mcpServers: { many: { command: process.execPath, args: [server] } } });
    const round1 = conn.seen[0].tools.map((t) => t.name);
    assert.ok(round1.includes("ToolSearch"), "ToolSearch is offered as soon as anything is deferred");
    assert.ok(!round1.includes("Bash"), "the cut still applies");
    const [search, call, bash] = toolResults(events);
    assert.ok(!search.isError, `ToolSearch rejected: ${search.content}`);
    assert.match(search.content, /mcp__many__tool_3/);
    assert.match(call.content, /called: tool_3/, "after reloading the tool is callable");
    // What is not in the set stays outside — the exception applies only to the reloading itself.
    assert.match(bash.content, /Bash is not available in this chat/);
  } finally { rm(root); }
});

// A chat loaded cbase_dynamic_workflow by ToolSearch in turn 1 and started a workflow; in turn 2 the tool was missing from the
// offer again — the activation lived in runConversation, which runs anew per turn — while the history showed the model
// "These tools are callable from now on." and a successful call. Two ways into the next turn: (a) the same run (cbaseInject —
// likewise completion notice, monitor, wakeup), (b) a NEW run that gets the history as a transcript (fresh doRun, server
// restart). Both offer what was loaded in their first round.
// Counter-test: an engine that forgets the loaded tools => both fail, the tool is missing in seen[3] resp. seen[0].
test("tools loaded by ToolSearch stay loaded: into the next turn via cbaseInject", async () => {
  const root = tmpRoot();
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "ToolSearch", input: { query: "select:mcp__many__tool_3" } }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c2", name: "mcp__many__tool_3", input: {} }], stop: "tool_calls" }),
        () => ({ text: "one" }),
        () => ({ text: "two" }),
      ],
    });
    let handle;
    let results = 0;
    const res = await runChatViaEngine(conn, {
      spec: { cwd: root, input: "load and call", systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions", model: "", effort: "",
        engine: {}, transcript: [], mcpServers: { many: { command: process.execPath, args: [server] } } },
      onSpawn: (h) => { handle = h; },
      onEvent: (e) => {
        if (e.type !== "result") return;
        results++;
        if (results === 1) assert.equal(handle.cbaseInject("and now the next turn"), true);
        else handle.cbaseEndInput();
      },
    });
    assert.equal(res.code, 0);
    assert.equal(conn.seen.length, 4);
    assert.ok(!conn.seen[0].tools.some((t) => t.name === "mcp__many__tool_3"), "deferred before loading");
    assert.ok(conn.seen[3].tools.some((t) => t.name === "mcp__many__tool_3"), "disappeared again in the next turn");
    // The prompt cache: the tool list of the new turn is the end state of the old one.
    assert.deepEqual(conn.seen[3].tools.map((t) => t.name), conn.seen[2].tools.map((t) => t.name));
  } finally { rm(root); }
});

test("tools loaded by ToolSearch stay loaded: a new run rebuilds them from the transcript", async () => {
  const root = tmpRoot();
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    // Two ways in which a transcript shows a deferred tool as loaded: "select:" of a SUCCEEDED ToolSearch (tool_3) and a hit
    // of a keyword search in the result (tool_7) — the same rule as live. A DIRECT call (tool_5, without ToolSearch) loads
    // nothing: live it activates nothing, and if it counted here the new run would carry one tool more than the old one (cache
    // break; guard "turn boundary" below). What this run does not know (tool_99) or a FAILED ToolSearch named — as `<function>`
    // in the result of a keyword search (tool_8) as well as "select:" (tool_9; the build must look at the result before
    // activating select names) — stays outside: the model saw the failure in the history.
    // Counter-test tool_9: an engine that activates select names at the tool_use.
    const fn = (name) => `<function>${JSON.stringify({ description: "x", name, parameters: { type: "object", properties: {} } })}</function>`;
    const transcript = [
      { role: "user", content: "Turn 1" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "select:mcp__many__tool_3,mcp__many__tool_99" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `<functions>\n${fn("mcp__many__tool_3")}\n</functions>\nThese tools are callable from now on.` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "ToolSearch", input: { query: "coffee stains" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: `<functions>\n${fn("mcp__many__tool_7")}\n</functions>\nThese tools are callable from now on.` }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "ToolSearch", input: { query: "anything" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: fn("mcp__many__tool_8") }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t5", name: "ToolSearch", input: { query: "select:mcp__many__tool_9" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t5", is_error: true, content: "None of these tools is deferred: mcp__many__tool_9. Maybe it is already available or has a different name." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t4", name: "mcp__many__tool_5", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t4", content: "called: tool_5" }] },
      { role: "assistant", content: "Done." },
    ];
    const conn = connector({ turns: [() => ({ text: "Turn 2" })] });
    const { res } = await runEngine(conn, { cwd: root, transcript, mcpServers: { many: { command: process.execPath, args: [server] } } });
    assert.equal(res.code, 0);
    const round1 = conn.seen[0].tools.map((t) => t.name);
    for (const n of ["mcp__many__tool_3", "mcp__many__tool_7"]) {
      assert.ok(round1.includes(n), `${n} is missing in round 1 of the new run, although the history shows it as loaded`);
    }
    assert.ok(!round1.includes("mcp__many__tool_5"), "a direct call without ToolSearch loads nothing — live neither");
    assert.ok(!round1.includes("mcp__many__tool_8"), "a failed ToolSearch loads nothing (keyword search)");
    assert.ok(!round1.includes("mcp__many__tool_9"), "a failed ToolSearch loads nothing (select:)");
    assert.ok(!round1.some((n) => n.endsWith("tool_99")));
    assert.ok(!round1.includes("mcp__many__tool_0"), "the rest stays deferred");
  } finally { rm(root); }
});

// "Thought, did not act": the engine nudges only if nudging CAN change something — tools are offered AND the thinking names
// one that this run knows (offered, deferred or ToolSearch). Otherwise the fallback at once ("ready" in the thinking channel
// is the answer): ONE request, exactly one text delta, the round's self-report on stderr. The way through the real connector
// and the DB stands in engine-task-core.test.js ("thought, did not act", "answer only in the thinking channel").
// Counter-test: an engine that nudges without the name check => "ready" with tools costs two requests.
const onlyThinking = (thinking, extra = {}) => () => ({ thinking, thinkingWithoutResponse: true, stop: "stop",
  diagnostic: { id: "gen-42", provider: "Z.AI", native_finish_reason: "stop", reasoning_tokens: 180 }, ...extra });
const textDeltas = (events) => events.filter((e) => e.event?.delta?.type === "text_delta").map((e) => e.event.delta.text);
const thinkingRows = (events) => events.filter((e) => e.type === "assistant" && e.message?.content?.[0]?.type === "thinking");
const responseRows = (events) => events.filter((e) => e.type === "assistant" && e.message?.content?.[0]?.type === "text").map((e) => e.message.content[0].text);
const twoUserInARow = (messages) => messages.some((m, i) => i > 0 && m.role === "user" && messages[i - 1].role === "user");

// ── The prompt cache at the turn boundary ──────────────────────────────────────────────────────────────────────────────────
// Turn N+1 of an engine chat is normally a NEW run (fresh doRun): system prompt from the spec, history from the DB via
// buildTranscript. A third-party provider's prefix cache hits only if the first request of this run begins with the bytes of
// the previous run's last request — tool list, system prompt and all messages before it. Here turn 1 as run A, its events
// turned into DB rows as in runs/do-run.js (assistant/thinking/tool/tool_result, with boundToolInput/boundResult), from them
// turn 2 as run B. The invariant: the tool list of the first B request == that of the last A request, the system prompt
// byte-identical, and the serialized last A request is up to before its last message a byte prefix of the first B request —
// if its last message carries no nudge hint, with it too. "Up to before the last": if the last A request is itself the nudged
// one, its last message carries the hint that only this one request sees (intended — exactly its bytes are missing from the
// prefix).
// Known losses independent of these fixes are avoided by the test data, they are not checked: the transcript's budget (cut
// from behind — here a 200k window, a tiny history), the caps when storing (tool_result 24,000 characters, input fields 8,000
// and nested objects as "[…]" in boundToolInput), image blocks of an input, thinking blocks (no row in the model context) and
// the cbase compaction. NOT among them: the preambles (agenda, hints, ultracode, summary), the UserPromptSubmit hook and
// `trim()` on the user row — the engine reports the wording that went out (`cbase_input`), runs/do-run.js stores it as a row
// `input`, and buildTranscript replays it untrimmed (here via `rowsFromEvents`; the guard with real preambles stands in
// engine-prompt-audit.test.js).
// Edge whitespace in the ASSISTANT TEXT is covered: the engine files it in the transcript's form (trimmed, pure whitespace
// dropped), the events stay raw; the cases "tool round with/only …", "… slip at line end", "… nudged with whitespace and call"
// and "final answer with edge whitespace" (the same run carries them into a second turn via cbaseInject, `SUPPLIED_LATER`).
// Counter-test: an engine that stores the text untrimmed => all five red at message 2.
// Counter-tests: an engine that carries a directly called deferred tool into the new run => "direct call" red at the tool
// list (B carries tool_5 more), "nudge" red at message 1 (A "Turn 1\n\n[Harness hint…", B "Turn 1"); an engine that falls back
// to the core set in the new run => "ToolSearch" red at the tool list.
// Also "call as text": the first round writes the call as JSON into the answer text (detectTextualToolCall fires), the second
// calls for real — with and without its own text. The slip stays in the history (it went out as text), the hint rides only in
// the nudged request, and the calls of the nudged round hang on the slip's message as in buildTranscript. Counter-test: an
// engine without that merge => "call as text" red at message 2 (A the slip as a string, B carries the call on it already),
// "… with own text" red at message 3 (A the hint as a user message, B the nudged round).
const THINKING_HINT = /Harness hint: Your last round ended with deliberations only/;
const TEXT_HINT = /Harness hint: You output the tool call/;
const HINT = new RegExp(`${THINKING_HINT.source}|${TEXT_HINT.source}`);
const W = (n) => `mcp__many__tool_${n}`;
const call = (id, name, input = {}) => () => ({ toolCalls: [{ id, name, input }], stop: "tool_calls" });
const AS_TEXT = `{"name": "${W(3)}", "arguments": {}}`;
const TURN_LIMIT = {
  "ToolSearch": [call("c1", "ToolSearch", { query: `select:${W(3)}` }), call("c2", W(3)), () => ({ text: "one" })],
  "two ToolSearch in reverse order": [call("c1", "ToolSearch", { query: `select:${W(7)}` }), call("c2", "ToolSearch", { query: `select:${W(3)}` }), () => ({ text: "one" })],
  "direct call of a deferred tool": [call("c1", W(5)), () => ({ text: "one" })],
  "nudge": [onlyThinking("I should call tool_3."), call("c1", "ToolSearch", { query: `select:${W(3)}` }), call("c2", W(3)), () => ({ text: "one" })],
  "nudge, answer in the nudged round": [onlyThinking("I should call tool_3."), () => ({ text: "one" })],
  "plain text": [() => ({ text: "one" })],
  "call as text": [() => ({ text: AS_TEXT }), call("c1", W(3)), () => ({ text: "one" })],
  "call as text, nudged with own text": [() => ({ text: AS_TEXT }), () => ({ text: "Now correct.", toolCalls: [{ id: "c1", name: W(3), input: {} }], stop: "tool_calls" }), () => ({ text: "one" })],
  // Edge whitespace: text as a model really delivers it.
  "tool round with edge whitespace": [() => ({ text: "I look.\n", toolCalls: [{ id: "c1", name: W(3), input: {} }], stop: "tool_calls" }), () => ({ text: "one" })],
  "tool round with only whitespace as text": [() => ({ text: "\n\n", toolCalls: [{ id: "c1", name: W(3), input: {} }], stop: "tool_calls" }), () => ({ text: "one" })],
  "call as text, slip at line end": [() => ({ text: `${AS_TEXT}\n` }), call("c1", W(3)), () => ({ text: "one" })],
  "call as text, nudged with whitespace and call": [() => ({ text: AS_TEXT }), () => ({ text: " ", toolCalls: [{ id: "c1", name: W(3), input: {} }], stop: "tool_calls" }), () => ({ text: "one" })],
  "final answer with edge whitespace, the same run continues": [() => ({ text: "alpha\n" }), () => ({ text: "beta" })],
};
// Cases whose run A gets a second turn (cbaseInject after the first result) — the input stands as a user row behind the rows
// of the first turn, as runs/do-run.js stores it.
const SUPPLIED_LATER = { "final answer with edge whitespace, the same run continues": "Turn 1b" };
// Events -> DB rows, as runs/do-run.js writes them (only the roles buildTranscript reads, and the main stream).
// `suppliedLater`: the inputs of the following turns of the same run, one behind the result of the previous turn.
function rowsFromEvents(events, suppliedLater = []) {
  const rows = [];
  const open = [...suppliedLater];
  for (const e of events) {
    if (e.parent_tool_use_id) continue;
    if (e.type === "result" && open.length) rows.push({ role: "user", text: open.shift() });
    // The wording that went out (role `input` — runs/do-run.js handleRunEvent).
    if (e.type === "cbase_input") rows.push({ role: "input", text: JSON.stringify({ text: e.text, beginning: false }) });
    if (e.type === "assistant") {
      for (const blk of e.message?.content ?? []) {
        if (blk.type === "text" && blk.text?.trim()) rows.push({ role: "assistant", text: blk.text });
        else if (blk.type === "thinking" && blk.thinking?.trim()) rows.push({ role: "thinking", text: JSON.stringify({ text: String(blk.thinking).slice(0, 12000), parent: null }) });
        else if (blk.type === "tool_use") rows.push({ role: "tool", text: JSON.stringify({ name: blk.name, id: blk.id, input: boundToolInput(blk.input), parent: null }) });
      }
    } else if (e.type === "user") {
      for (const blk of e.message?.content ?? []) {
        if (blk?.type === "tool_result" && blk.tool_use_id) rows.push({ role: "tool_result", text: JSON.stringify({ id: blk.tool_use_id, result: boundResult(blk.content), isError: Boolean(blk.is_error) }) });
      }
    }
  }
  return rows;
}
// A request on the wire, in the order in which chat templates render: tools, then the first k messages.
const wire = (req, k) => [JSON.stringify(req.tools), ...req.messages.slice(0, k).map((m) => JSON.stringify(m))].join("\n");
const commonUntil = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

test("turn boundary: the first request of the new run begins with the bytes of the last of the old (tools, system prompt, history)", async (t) => {
  const root = tmpRoot();
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  const mcpServers = { many: { command: process.execPath, args: [server] } };
  try {
    // One subtest per case: a red case does not hide the others.
    for (const [fall, roundsA] of Object.entries(TURN_LIMIT)) await t.test(fall, async () => {
      // Every request copied as it went out (`messages` is the engine's growing array).
      const requests = [];
      const transcriptValue = (f) => (a, i) => { requests.push(JSON.parse(JSON.stringify({ tools: a.tools, messages: a.messages }))); return f(a, i); };
      const conn = connector({ turns: [...roundsA, () => ({ text: "two" })].map(transcriptValue) });
      const further = SUPPLIED_LATER[fall];
      const a = await runEngine(conn, { cwd: root, input: "Turn 1", systemPrompt: "SYSTEM-PROMPT", mcpServers },
        further ? { results: 2, atResult: (h) => assert.equal(h.cbaseInject(further), true) } : undefined);
      assert.equal(a.res.code, 0, `${fall}: run A, stderr ${a.res.stderr}`);
      const nA = requests.length;
      assert.equal(nA, roundsA.length, `${fall}: requests in run A`);
      const rows = [{ role: "user", text: "Turn 1" }, ...rowsFromEvents(a.events, further ? [further] : []), { role: "user", text: "Turn 2" }];
      const transcript = buildTranscript(rows, { contextWindow: 200_000 });
      const b = await runEngine(conn, { cwd: root, input: "Turn 2", systemPrompt: "SYSTEM-PROMPT", mcpServers, transcript });
      assert.equal(b.res.code, 0, `${fall}: run B, stderr ${b.res.stderr}`);
      assert.equal(requests.length, nA + 1, `${fall}: requests in run B`);
      const lastA = requests[nA - 1];
      const firstB = requests[nA];
      assert.equal(firstB.messages.at(-1).content, "Turn 2");

      assert.equal(firstB.messages[0].content, lastA.messages[0].content, `${fall}: system prompt`);
      assert.deepEqual(firstB.tools.map((t) => t.name), lastA.tools.map((t) => t.name), `${fall}: tool list`);
      const beforeA = wire(lastA, lastA.messages.length - 1);
      const everythingB = wire(firstB, firstB.messages.length);
      let k = 0;
      while (k < lastA.messages.length && JSON.stringify(lastA.messages[k]) === JSON.stringify(firstB.messages[k])) k++;
      assert.ok(everythingB.startsWith(beforeA), `${fall}: prefix breaks at character ${commonUntil(beforeA, everythingB)} of ${beforeA.length}, first differing message ${k}: A ${JSON.stringify(lastA.messages[k])?.slice(0, 200)} / B ${JSON.stringify(firstB.messages[k])?.slice(0, 200)}`);
      if (!HINT.test(JSON.stringify(lastA.messages.at(-1)))) {
        assert.ok(everythingB.startsWith(wire(lastA, lastA.messages.length)), `${fall}: the last message of the last A request is missing in the prefix`);
      }
      // No nudge hint in the history: neither in the new run nor in a request AFTER the nudged one.
      assert.ok(!HINT.test(JSON.stringify(firstB.messages)), `${fall}: the hint stands in the transcript`);

      // What the case is to check did happen — otherwise it checks nothing.
      const names = lastA.tools.map((t) => t.name);
      if (fall === "ToolSearch" || fall === "nudge") assert.ok(names.includes(W(3)), `${fall}: tool_3 not loaded`);
      if (fall === "two ToolSearch in reverse order") {
        assert.ok(names.includes(W(3)) && names.includes(W(7)));
        assert.ok(names.indexOf(W(3)) < names.indexOf(W(7)), "the list follows the catalog, not the load order");
      }
      if (fall === "direct call of a deferred tool") {
        assert.ok(!names.includes(W(5)), "a direct call loads nothing live");
        assert.match(String(toolResults(a.events)[0]?.content), /called: tool_5/, "dispatch by name runs it anyway");
      }
      if (fall.startsWith("nudge")) {
        // The nudged request carries the hint — otherwise the nudge has no effect — as a paragraph on the user message
        // (never two user roles in a row); the requests before and after do not carry it.
        assert.ok(!THINKING_HINT.test(JSON.stringify(requests[0].messages)));
        assert.ok(String(requests[1].messages.at(-1).content).startsWith(`${D}Turn 1\n\n[Harness hint: Your last round ended with deliberations only`));
        assert.match(String(requests[1].messages.at(-1).content), /ToolSearch \("select:<name>"\)/);
        assert.ok(!twoUserInARow(requests[1].messages), `${fall}: two user roles in a row`);
        for (const r of requests.slice(2)) assert.ok(!THINKING_HINT.test(JSON.stringify(r.messages)), `${fall}: the hint stayed in the history`);
        assert.equal(thinkingRows(a.events).length, 1, `${fall}: the thinking stands as thinking in the history`);
      }
      if (fall.startsWith("call as text")) {
        // The nudged request (the second) carries the slip AND the hint — otherwise the nudge has no effect — the hint as a
        // user message of its own behind the slip; no request before or after carries it.
        const second = requests[1].messages;
        const raw = roundsA[0]().text; // the slip, as the model wrote it
        assert.deepEqual(second.slice(-2).map((m) => m.role), ["assistant", "user"], `${fall}: ${JSON.stringify(second.map((m) => m.role))}`);
        assert.equal(second.at(-2).content, raw.trim(), `${fall}: the slip is missing in the nudged request (or is not in the transcript's form)`);
        assert.match(String(second.at(-1).content), /^\[Harness hint: You output the tool call "mcp__many__tool_3" only as text/);
        assert.ok(!twoUserInARow(second), `${fall}: two user roles in a row`);
        assert.ok(!HINT.test(JSON.stringify(requests[0].messages)));
        for (const r of requests.slice(2)) assert.ok(!HINT.test(JSON.stringify(r.messages)), `${fall}: the hint stayed in the history`);
        // The user still sees what the model wrote: the slip as an answer row, live and in the history — raw.
        assert.deepEqual(responseRows(a.events)[0], raw, `${fall}: the slip did not go out (raw) as text`);
        assert.match(String(toolResults(a.events)[0]?.content), /called: tool_3/, `${fall}: the nudged round did not call`);
        if (fall.endsWith("whitespace and call")) {
          // The nudged round's whitespace went out raw, and its call hangs on the slip anyway.
          assert.equal(responseRows(a.events)[1], " ", `${fall}: the whitespace did not go out raw`);
          assert.deepEqual(requests[2].messages.at(-2).content.map((b) => b.type === "text" ? `text:${b.text}` : `${b.type}:${b.id}`), [`text:${AS_TEXT}`, "tool_use:c1"],
            `${fall}: the call does not hang on the slip`);
        }
      }
      if (fall.startsWith("tool round")) {
        // The event to the user stays raw, the history holds the text trimmed — or not at all if it was only whitespace.
        const raw = roundsA[0]().text;
        assert.equal(responseRows(a.events)[0], raw, `${fall}: the event to the user is not raw`);
        assert.deepEqual(requests[1].messages.at(-2).content.map((b) => b.type === "text" ? `text:${b.text}` : `${b.type}:${b.id}`),
          raw.trim() ? [`text:${raw.trim()}`, "tool_use:c1"] : ["tool_use:c1"], `${fall}: the tool round is not in the transcript's form`);
      }
      if (further) {
        // The second turn of the SAME run carries the first one's final answer — trimmed; the event stays raw.
        assert.equal(responseRows(a.events)[0], "alpha\n", `${fall}: the event to the user is not raw`);
        assert.deepEqual(lastA.messages.slice(1).map((m) => m.content), [`${D}Turn 1`, "alpha", further], `${fall}: the second turn does not carry the final answer in the transcript's form`);
      }
    });
  } finally { rm(root); }
});

// Call as text with a connector that has CERTIFIED thinking blocks: anthropic-msgs delivers `thinkingBlocks` with a signature
// when a level is set, and the signature binds the prefix BEFORE the block. The merge form of the turn boundary (calls of the
// nudged round on the slip, hint only in the nudged request) pushed the nudged round's thinking block before the slip's text,
// and the hint under which it arose was missing from the request afterwards — Anthropic answers that with a 400, the turn
// aborts. For such connectors the form applies: slip as assistant, hint as user PERMANENTLY in the run's history, nothing
// merged. It is decided at the connector (the field is there, even empty), not at the block: with adaptive thinking the slip
// perhaps does not think, the nudged round does anyway (case "slip without a thinking block …"). The invariant over ALL
// requests: a thinking block stands first in ITS message, next to it only what its round delivered.
// Counter-test: an engine without that form => all three red at the third request (without own text:
// `assistant:[thinking:SIG2,text:<slip>,tool_use:c1]` right behind `user:go`; with own text: two assistant messages in a
// row, the hint missing).
const SIG = (n) => [{ type: "thinking", thinking: `think ${n}`, signature: `SIG${n}` }];
const AS_TEXT_GLOB = 'I call {"name": "Glob", "arguments": {}} now.';
const THINKING_BLOCK_CASES = {
  "nudged round without own text": { round1: SIG(1), text2: "" },
  "nudged round with own text": { round1: SIG(1), text2: "Now correct." },
  "slip without a thinking block, the nudged round thinks": { round1: [], text2: "" },
};
const blockShort = (b) => (b.type === "thinking" ? `thinking:${b.signature}` : b.type === "text" ? `text:${b.text}` : `${b.type}:${b.id ?? b.tool_use_id}`);
const messageShort = (m) => (typeof m.content === "string"
  ? `${m.role}:${TEXT_HINT.test(m.content) ? "<hint>" : m.content}`
  : `${m.role}:[${m.content.map(blockShort).join(",")}]`);
test("call as text with certified thinking blocks: the hint stays in the history, no thinking block wanders into a foreign message", async (t) => {
  const root = tmpRoot();
  try {
    for (const [fall, { round1, text2 }] of Object.entries(THINKING_BLOCK_CASES)) await t.test(fall, async () => {
      const requests = [];
      const rounds = [
        () => ({ text: AS_TEXT_GLOB, thinking: round1.length ? "think 1" : "", thinkingBlocks: round1 }),
        () => ({ text: text2, thinking: "think 2", thinkingBlocks: SIG(2), toolCalls: [{ id: "c1", name: "Glob", input: { pattern: "*.nomatch" } }], stop: "tool_calls" }),
        () => ({ text: "one", thinking: "think 3", thinkingBlocks: SIG(3) }),
      ];
      const conn = connector({ turns: rounds.map((f) => (a, i) => { requests.push(JSON.parse(JSON.stringify(a.messages))); return f(a, i); }) });
      const { res, events } = await runEngine(conn, { cwd: root, input: "los" });
      assert.equal(res.code, 0, `${fall}: stderr ${res.stderr}`);
      assert.equal(requests.length, 3, `${fall}: requests`);
      // The nudged request: the slip, the hint behind it.
      assert.deepEqual(requests[1].slice(1).map(messageShort), [`user:${D}los`, `assistant:${AS_TEXT_GLOB}`, "user:<hint>"], `${fall}: nudged request`);
      // The request after: the hint stays in the history, the thinking block first in the message of ITS round.
      assert.deepEqual(requests[2].slice(1).map(messageShort), [
        `user:${D}los`, `assistant:${AS_TEXT_GLOB}`, "user:<hint>",
        `assistant:[thinking:SIG2,${text2 ? `text:${text2},` : ""}tool_use:c1]`, "user:[tool_result:c1]",
      ], `${fall}: request after the nudged round`);
      // Over all requests: every thinking block first in its message, next to it only what its round delivered.
      const own = { SIG1: [`text:${AS_TEXT_GLOB}`], SIG2: [...(text2 ? [`text:${text2}`] : []), "tool_use:c1"], SIG3: ["text:one"] };
      for (const [r, messages] of requests.entries()) {
        for (const m of messages) {
          if (!Array.isArray(m.content) || !m.content.some((b) => b.type === "thinking")) continue;
          assert.equal(m.role, "assistant", `${fall}: request ${r + 1}: a thinking block in a ${m.role} message`);
          assert.equal(m.content[0].type, "thinking", `${fall}: request ${r + 1}: the thinking block is not first — ${messageShort(m)}`);
          assert.deepEqual(m.content.slice(1).map(blockShort), own[m.content[0].signature], `${fall}: request ${r + 1}: ${m.content[0].signature} stands in a foreign message — ${messageShort(m)}`);
        }
      }
      // What the case is to check did happen: the slip went out as text, the nudged round called.
      assert.equal(responseRows(events)[0], AS_TEXT_GLOB, `${fall}: the slip did not go out as text`);
      assert.equal(toolResults(events).length, 1, `${fall}: the nudged round did not call`);
    });
  } finally { rm(root); }
});

test("only thinking without tool names: the fallback at once — with and without tools exactly ONE request", async () => {
  const root = tmpRoot();
  try {
    // Without tools: one request, the thinking text is the answer — live exactly once as text.
    const without = connector({ turns: [onlyThinking("ready")] });
    const a = await runEngine(without, { cwd: root, builtinTools: [] });
    assert.equal(without.seen.length, 1);
    assert.deepEqual(without.seen[0].tools, []);
    assert.equal(a.res.resultText, "ready");
    assert.deepEqual(textDeltas(a.events), ["ready"]);
    assert.equal(thinkingRows(a.events).length, 0, "the thinking would otherwise stand twice in the history");
    assert.match(a.res.stderr, /thought, not acted — the thinking text is the answer \(gen=gen-42 provider=Z\.AI native_finish_reason=stop reasoning_tokens=180 stop=stop\)/);

    // With tools, but the thinking names none (a model on a provider: "ready"; "bashful" is not "Bash"): the same fallback,
    // without an extra request.
    for (const thinking of ["ready", "I feel a bit bashful about reading this."]) {
      const including = connector({ turns: [onlyThinking(thinking)] });
      const b = await runEngine(including, { cwd: root });
      assert.ok(including.seen[0].tools.length > 0, "the run has tools — otherwise this case checks nothing");
      assert.equal(including.seen.length, 1, `“${thinking}” costs more than one request`);
      assert.equal(b.res.resultText, thinking);
      assert.deepEqual(textDeltas(b.events), [thinking]);
      assert.equal(thinkingRows(b.events).length, 0);
      assert.doesNotMatch(b.res.stderr, /followed up/);
    }
  } finally { rm(root); }
});

test("only thinking with tool names: exactly one nudge, the hint hangs on the user message, the thinking stays thinking", async () => {
  const root = tmpRoot();
  try {
    // `seen` holds the engine's own messages array, and that keeps growing — the second request is therefore copied.
    let second = null;
    const conn = connector({ turns: [
      onlyThinking("I should look at the file with Read."),
      (a) => { second = a.messages.map((m) => ({ ...m })); return { toolCalls: [{ id: "r1", name: "Read", input: { file_path: path.join(root, "nonexistent") } }], stop: "tool_calls" }; },
      () => ({ text: "finished" }),
    ] });
    const b = await runEngine(conn, { cwd: root, input: "look" });
    assert.equal(b.res.code, 0);
    assert.equal(conn.seen.length, 3, "thinking, nudge, after the tool");
    assert.equal(b.res.resultText, "finished");
    // The hint stands at the user message itself — never two user roles in a row (strict chat templates: 400).
    assert.ok(!twoUserInARow(second), `two user roles in a row: ${JSON.stringify(second.map((m) => m.role))}`);
    assert.ok(String(second.at(-1).content).startsWith(`${D}look\n\n[Harness hint: Your last round ended with deliberations only`), String(second.at(-1).content));
    assert.doesNotMatch(String(second.at(-1).content), /ToolSearch/, "without deferred tools no reference to ToolSearch");
    assert.ok(!second.some((m) => m.role === "assistant"), "the thinking was played back to the model as an answer");
    assert.deepEqual(thinkingRows(b.events).map((e) => e.message.content[0].thinking), ["I should look at the file with Read."]);
    assert.match(b.res.stderr, /thought, not acted — followed up \(gen=gen-42 .* names=Read\)/);
  } finally { rm(root); }
});

// The nudged round delivers nothing usable — then the thinking of the FIRST round is the answer, with code 0: nudging must
// never yield less than the state before (one request, the thinking as the answer). Four ways: empty, only thinking, at the
// token limit, and the request fails (400 — no retry).
// Counter-test: an engine without that fallback => "empty" and "length" end with resultText "", "error" with null and code 1,
// "only thinking" with the thinking of the SECOND round.
test("nudged, but round 2 empty, only thinking, at the limit or failed: the thinking of round 1 is the answer", async () => {
  const root = tmpRoot();
  const ROUND1 = "I call tool_3.";
  const cases = {
    empty: () => ({ text: "", stop: "stop" }),
    onlyThinking: onlyThinking("The hint says I should act."),
    length: () => ({ text: "", thinking: "First I check", stop: "length" }),
    error: () => { throw new Error("400 Bad Request: Conversation roles must alternate user/assistant"); },
  };
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    for (const [fall, round2] of Object.entries(cases)) {
      let second = null; // the second request, copied (`seen` holds the engine's growing array)
      const conn = connector({ turns: [onlyThinking(ROUND1), (a) => { second = a.messages.map((m) => ({ ...m })); return round2(a); }] });
      const { res, events } = await runEngine(conn, { cwd: root, mcpServers: { many: { command: process.execPath, args: [server] } } });
      assert.equal(conn.seen.length, 2, `${fall}: exactly one nudge`);
      assert.equal(res.code, 0, `${fall}: code ${res.code}, stderr ${res.stderr}`);
      assert.equal(res.resultText, ROUND1, `${fall}: the answer from round 1 was lost`);
      assert.deepEqual(textDeltas(events), [ROUND1], `${fall}: the answer goes out live exactly once`);
      assert.deepEqual(responseRows(events), [ROUND1], `${fall}: the answer stands exactly once as an answer in the history`);
      assert.match(res.stderr, /followed up \(.* names=mcp__many__tool_3\)/, `${fall}: the name without prefix in the thinking suffices`);
      assert.match(res.stderr, /the thinking of the first round is the answer/);
      if (fall === "error") assert.match(res.stderr, /the request failed \(400 Bad Request/);
      // With deferred tools the hint names the way via ToolSearch.
      assert.match(String(second.at(-1).content), /ToolSearch \("select:<name>"\)/);
      assert.ok(!twoUserInARow(second), `${fall}: two user roles in a row`);
    }
  } finally { rm(root); }
});

// The name check itself: whole words, snake_case boundaries, with and without `mcp__<server>__`, case counts.
test("namesTool: whole words with snake_case boundaries, with and without MCP prefix", () => {
  const names = ["Bash", "ToolSearch", "mcp__cbase__cbase_dynamic_workflow", "mcp__many__tool_3", "mcp__claude-in-chrome__navigate"];
  const cases = [
    ["I'll attempt the stop call via cbase_dynamic_workflow.", "mcp__cbase__cbase_dynamic_workflow"],
    ["call mcp__cbase__cbase_dynamic_workflow now", "mcp__cbase__cbase_dynamic_workflow"],
    ["only cbase_dynamic_workflow_stop is here", null],
    ["my_cbase_dynamic_workflow", null],
    ["tool_30 and tool_3x", null],
    ["(tool_3)", "mcp__many__tool_3"],
    ["I take Bash.", "Bash"],
    ["bashful", null],
    ["bash", null],
    ["BashTool", null],
    ["Über ToolSearch laden", "ToolSearch"],
    ["navigate-call", "mcp__claude-in-chrome__navigate"],
    ["überBash", null],
    ["", null],
  ];
  for (const [text, expected] of cases) assert.equal(namesTool(text, names), expected, JSON.stringify(text));
});

// The stop tools never sit behind ToolSearch: in a chat cbase_dynamic_workflow_stop was in NO turn's offer, although the
// workflow's start note names exactly this way — the same trap lay open with cbase_monitor (always on) beside
// cbase_monitor_stop (deferred) and with cbase_agent_stop. A family whose stop is always visible shows its start too —
// cbase_dynamic_workflow and cbase_agent stand in round 1 without ToolSearch (with the stop in the offer and the start behind
// ToolSearch a model called cbase_dynamic_workflow_stop {taskId:"unused"} THREE times in order to start a workflow). The other
// family members (_send/_output/agents_list, _list/_save) stay deferred. A fake server under the key "cbase" with more than
// 45 tools.
// Counter-tests: an engine without the stops in ALWAYS_ON => none of the three stops in round 1; an engine without the starts
// in ALWAYS_ON => red at "cbase_dynamic_workflow sits behind ToolSearch".
test("deferred tool schemas: start and stop tools of the cbase families are always in the offer, the other members are not", async () => {
  const root = tmpRoot();
  const server = path.join(root, "cbase.mjs");
  const always = ["cbase_dynamic_workflow", "cbase_dynamic_workflow_stop", "cbase_monitor", "cbase_monitor_stop", "cbase_agent", "cbase_agent_stop"];
  const delayed = ["cbase_dynamic_workflow_list", "cbase_dynamic_workflow_save", "cbase_agent_send", "cbase_agent_output", "cbase_agents_list"];
  const names = [...always, ...delayed];
  const source = MANY_SERVER_SRC.replace(
    '  inputSchema: { type: "object", properties: {} },\n}));',
    `  inputSchema: { type: "object", properties: {} },\n})).concat(${JSON.stringify(names)}.map((name) => ({ name, description: "cbase " + name, inputSchema: { type: "object", properties: {} } })));`,
  );
  assert.notEqual(source, MANY_SERVER_SRC, "the fake server did not get its cbase tools");
  fs.writeFileSync(server, source);
  try {
    // Round 1 starts the workflow and an agent, round 2 stops both — all without ToolSearch.
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "mcp__cbase__cbase_dynamic_workflow", input: {} }, { id: "c2", name: "mcp__cbase__cbase_agent", input: {} }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c3", name: "mcp__cbase__cbase_dynamic_workflow_stop", input: {} }, { id: "c4", name: "mcp__cbase__cbase_agent_stop", input: {} }], stop: "tool_calls" }),
        () => ({ text: "stopped" }),
      ],
    });
    const { events } = await runEngine(conn, { cwd: root, mcpServers: { cbase: { command: process.execPath, args: [server] } } });
    const round1 = conn.seen[0].tools.map((t) => t.name);
    assert.ok(round1.includes("ToolSearch"), "the set lies above the threshold — otherwise this test checks nothing");
    const catalog = conn.seen[0].messages[0].content; // the catalog of the deferred ones stands in the system prompt
    for (const n of always) {
      assert.ok(round1.includes(`mcp__cbase__${n}`), `${n} sits behind ToolSearch`);
      assert.ok(!catalog.includes(`mcp__cbase__${n}:`), `${n} in the catalog of the deferred ones although offered`);
    }
    for (const n of delayed) {
      assert.ok(!round1.includes(`mcp__cbase__${n}`), `${n} is no longer deferred`);
      assert.ok(catalog.includes(`mcp__cbase__${n}:`), `${n} is missing in the catalog of the deferred ones`);
    }
    assert.equal(conn.seen.length, 3, "start, stop, answer — no ToolSearch in between");
    assert.ok(!events.some((e) => e.type === "assistant" && e.message?.content?.some((b) => b.type === "tool_use" && b.name === "ToolSearch")));
    assert.deepEqual(toolResults(events).map((r) => String(r.content).match(/called: (\S+)/)?.[1]),
      ["cbase_dynamic_workflow", "cbase_agent", "cbase_dynamic_workflow_stop", "cbase_agent_stop"]);
  } finally { rm(root); }
});

// There is ONE loading path for skills: the MCP tool `cbase_skill`. The loop engine has no built-in `Skill` tool of its own.
// Counter-test: an engine that offers `Skill` => "Skill" stands in the catalog and the call delivers the instructions.
test("the loop engine no longer offers a built-in Skill tool", async () => {
  const root = tmpRoot();
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "Skill", input: { name: "only-read" } }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    const { events } = await runEngine(conn, { cwd: root });
    assert.ok(!conn.seen[0].tools.some((t) => t.name === "Skill"),
      "\"Skill\" must no longer stand in the engine's tool catalog");
    // And the call past the catalog runs into nothing instead of loading instructions after all.
    const first = toolResults(events)[0];
    assert.equal(first.is_error, true);
    assert.match(first.content, /Unknown tool: Skill/);
  } finally { rm(root); }
});

// A cut-down chat (builtinTools: []) gets no built-in tools at all — only the MCP tools of its server. spec.builtinTools is
// the counterpart of Claude's --tools: list = exactly these, [] = none.
test("builtinTools: [] takes all built-in tools from the run — also at a call from the history", async () => {
  const root = tmpRoot();
  try {
    const conn = connector({
      turns: [
        // The agent tries to read anyway (as a resumed history would).
        () => ({ toolCalls: [{ id: "c1", name: "Read", input: { file_path: path.join(root, "secret.txt") } }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    fs.writeFileSync(path.join(root, "secret.txt"), "NOT-READ");
    const { events } = await runEngine(conn, { cwd: root, builtinTools: [] });

    // 1. No built-in tool is offered to the model in ANY round.
    assert.deepEqual(conn.seen[0].tools.map((t) => t.name), []);
    // 2. And the call past the catalog does not run it after all.
    const first = toolResults(events)[0];
    assert.equal(first.is_error, true);
    assert.match(first.content, /is not available in this chat/);
    assert.doesNotMatch(first.content, /NOT-READ/);
  } finally { rm(root); }
});

// Background Bash and detaching are rejected by the engine at the call (mcp/detach-rule.js); the way is no longer reachable
// from a model call.
// Counter-test: dropping the rejection in `bashTool` of tool-runtime.js => the command runs, red.
test("background Bash and nohup are rejected, with the way to the monitor — and the turn continues", async () => {
  const root = tmpRoot();
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [
          { id: "c1", name: "Bash", input: { command: "printf 'FINISHED-MARKER\\n'", run_in_background: true, description: "short run" } },
          { id: "c2", name: "Bash", input: { command: "nohup sleep 1 > /dev/null 2>&1 &" } },
          { id: "c3", name: "Bash", input: { command: "echo a && echo FRONT-OK 2>&1" } },
        ], stop: "tool_calls" }),
        () => ({ text: "further" }),
      ],
    });
    const { res, events } = await runEngine(conn, { cwd: root });
    const [r1, r2, r3] = toolResults(events);
    for (const r of [r1, r2]) {
      assert.equal(r.is_error, true);
      assert.match(r.content, /^Refused: /);
      assert.match(r.content, /cbase_monitor/);
    }
    assert.doesNotMatch(r1.content, /FINISHED-MARKER/);
    assert.equal(r3.is_error, false);
    assert.match(r3.content, /FRONT-OK/);
    assert.equal(events.some((e) => e.type === "system" && e.subtype === "task_started"), false, "no background task");
    assert.match(res.resultText, /further/);
  } finally { rm(root); }
});

test("hooks: SessionStart context, PreToolUse block and SessionEnd", async () => {
  const root = tmpRoot();
  const log = path.join(root, "hooks.log");
  try {
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "Bash", input: { command: "echo no" } }], stop: "tool_calls" }),
        () => ({ text: "understood" }),
      ],
    });
    const { events } = await runEngine(conn, {
      cwd: root,
      engine: {
        hooks: [
          { event: "SessionStart", matcher: "*", command: `printf '{"additionalContext":"HOOK-CONTEXT"}'` },
          { event: "PreToolUse", matcher: "^Bash$", command: `printf '{"decision":"block","reason":"not in this test"}'` },
          { event: "SessionEnd", matcher: "*", command: `printf 'end' >> ${JSON.stringify(log)}` },
        ],
      },
    });
    // SessionStart context stands in the system prompt.
    assert.match(conn.seen[0].messages[0].content, /HOOK-CONTEXT/);
    // PreToolUse blocked the command — with the reason as tool result.
    const r = toolResults(events)[0];
    assert.equal(r.is_error, true);
    assert.match(r.content, /not in this test/);
    // SessionEnd ran at teardown.
    assert.equal(fs.readFileSync(log, "utf8"), "end");
  } finally { rm(root); }
});

// ── Usage limit ──────────────────────────────────────────────────────────────────────────────────────────────────
// The three ways in which a limit used to leave the engine silently.
//
// The wordings are not invented but copied from the error documents of both providers — they arrive here as the body of the
// connector message ("HTTP <status> <text> — <body>").
const QUOTA_ANTHROPIC = 'HTTP 429 Too Many Requests — {"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization\'s API tier. You will regain access on 2026-10-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}}}';
const QUOTA_OPENAI = 'HTTP 429 Too Many Requests — {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}';
const OVERLOAD = 'HTTP 529 Overloaded — {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

test("quota 429 is not retried, an overload 529 is", async () => {
  const root = tmpRoot();
  try {
    // Anthropic's tier spend cap sends a 429 with `rate_limit_error` — without retry-after, and the documentation says
    // explicitly that every attempt fails until the reset.
    let quotaCalls = 0;
    const quota = connector({ turns: [() => { quotaCalls++; throw new Error(QUOTA_ANTHROPIC); }] });
    const a = await runEngine(quota, { cwd: root });
    assert.equal(quotaCalls, 1, "an exhausted quota must not cost a second attempt");
    assert.equal(a.res.code, 1);
    assert.ok(!a.events.some((e) => e.type === "harness" && e.subtype === "retry"), "no retry event");

    // Overload stays retryable: the same digit family, the other matter.
    let overloadCalls = 0;
    const overload = connector({
      turns: [() => { if (++overloadCalls <= 2) throw new Error(OVERLOAD); return { text: "finished after all" }; }],
    });
    const b = await runEngine(overload, { cwd: root });
    assert.equal(overloadCalls, 3, "an overload must still be retried");
    assert.equal(b.res.code, 0);
    assert.match(b.res.resultText, /finished after all/);
  } finally { rm(root); }
});

test("turn aborted at the limit: exit 1 and a result event that identifies itself as an error", async () => {
  const root = tmpRoot();
  try {
    const conn = connector({ turns: [() => { throw new Error(QUOTA_OPENAI); }] });
    const { res, events } = await runEngine(conn, { cwd: root });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /insufficient_quota/);
    // runs/do-run.js keeps the wording of a result event marked as an error as limit evidence (limitEvidence). The
    // engine used not to be able to say that.
    const result = events.find((e) => e.type === "result");
    assert.equal(result.is_error, true);
    assert.match(result.error.message, /insufficient_quota/);
  } finally { rm(root); }
});

test("a failed compaction names its reason on stderr", async () => {
  const root = tmpRoot();
  try {
    let call2 = 0;
    const conn = connector({
      turns: [
        // Turn 1 fills the context (200k of 200k) and calls a tool — so the auto-compaction is due at the beginning of the
        // next step.
        () => ({ toolCalls: [{ id: "c1", name: "Bash", input: { command: "echo hi" } }], stop: "tool_calls", usage: { input: 200_000, output: 1, cached: 0 } }),
        // The compaction call fails at the quota …
        () => { call2++; if (call2 === 1) throw new Error(QUOTA_OPENAI); return { text: "further" }; },
      ],
    });
    const { res } = await runEngine(conn, { cwd: root });
    // … and says so. Without this line a follow-up error ("context too large") would arrive at the server, where the limit
    // can no longer be seen.
    assert.match(res.stderr, /\[compact\] .*insufficient_quota/);
  } finally { rm(root); }
});

// ── The start of a tool call in the stream ──────────────────────────────────────────────────────────────────────────────────
// After the last sentence NOTHING stood there for several seconds while the model streamed thousands of characters of
// arguments — the engine reported the call only as an `assistant` event AFTER the round. Now the connector reports `toolStart`
// (connector-wire.test.js), and the engine emits `content_block_start`/tool_use from it, like the Claude CLI: WHILE the round
// is still running, before the `assistant` event with the same id, once per id. Otherwise nothing changes — the requests to
// the provider and the run's DB rows (`rowsFromEvents`, as runs/do-run.js writes them) are byte-identical with a run without a
// start, in both execution paths (parallel in bypass mode, call by call otherwise).
// Counter-test: an engine without `content_block_start` for tool calls => "no content_block_start …".
const isStart = (e) => e.type === "stream_event" && e.event?.type === "content_block_start" && e.event.content_block?.type === "tool_use";
const isCall = (id) => (e) => e.type === "assistant" && (e.message?.content || []).some((b) => b.type === "tool_use" && b.id === id);

test("tool start: content_block_start with the same id DURING the round and before the assistant event — requests and DB rows as without", async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, "a.txt"), "content");
  try {
    for (const permissionMode of ["bypassPermissions", "default"]) {
      const run = async (withStart) => {
        const requests = [];
        const eventsValue = [];
        const during = []; // per start: what the engine had reported when the connector reported it — the round was still running
        const calls = [{ id: "c1", name: "Read", input: { file_path: path.join(root, "a.txt") } }, { id: "c2", name: "Read", input: { file_path: path.join(root, "a.txt") } }];
        const conn = connector({
          turns: [
            (a) => {
              requests.push(JSON.parse(JSON.stringify({ tools: a.tools, messages: a.messages })));
              a.onDelta?.({ text: "I read two files." });
              if (withStart) {
                for (const c of calls) {
                  a.onDelta({ toolStart: { id: c.id, name: c.name } });
                  a.onDelta({ toolStart: { id: c.id, name: c.name } }); // reported twice — it goes out once
                  during.push({ id: c.id, start: eventsValue.filter(isStart).map((e) => e.event.content_block.id), call: eventsValue.some(isCall(c.id)) });
                }
              }
              return { text: "I read two files.", toolCalls: calls, stop: "tool_calls" };
            },
            (a) => { requests.push(JSON.parse(JSON.stringify({ tools: a.tools, messages: a.messages }))); return { text: "finished" }; },
          ],
        });
        const { res, events } = await runEngine(conn, { cwd: root, input: "Read a.txt twice", permissionMode }, { events: eventsValue });
        return { res, events, requests, during };
      };
      const including = await run(true);
      const without = await run(false);
      assert.equal(including.res.code, 0, `${permissionMode}: ${including.res.stderr}`);

      // During the round: the start was already in the stream, the call not yet.
      assert.deepEqual(including.during, [
        { id: "c1", start: ["c1"], call: false },
        { id: "c2", start: ["c1", "c2"], call: false },
      ], `${permissionMode}: no content_block_start during the round`);
      // Once per id, in Claude's form, in the main stream — and before the assistant event with the same id.
      const starts = including.events.filter(isStart);
      assert.deepEqual(starts, [
        { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "c1", name: "Read", input: {} } } },
        { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "c2", name: "Read", input: {} } } },
      ]);
      for (const id of ["c1", "c2"]) {
        const s = including.events.findIndex((e) => isStart(e) && e.event.content_block.id === id);
        const a = including.events.findIndex(isCall(id));
        assert.ok(s >= 0 && a > s, `${permissionMode}: ${id} start #${s}, call #${a}`);
      }
      // Display only: requests, DB rows and every other event as without a start.
      assert.equal(JSON.stringify(including.requests), JSON.stringify(without.requests), `${permissionMode}: the requests to the provider differ`);
      assert.deepEqual(rowsFromEvents(including.events), rowsFromEvents(without.events), `${permissionMode}: the DB rows differ`);
      const withoutSession = (es) => es.map((e) => (e.session_id ? { ...e, session_id: "<session>" } : e)); // a new uuid per run
      assert.deepEqual(withoutSession(including.events.filter((e) => !isStart(e))), withoutSession(without.events), `${permissionMode}: another event differs`);
      assert.equal(without.events.filter(isStart).length, 0);
    }
  } finally { rm(root); }
});

// If the round breaks off AFTER a reported start, it is not repeated (completeWithRetry: a delta seen, as with text) — the
// repeated round would give the call a new id, and the row of the first start would never get input and result. The run ends
// with the error; no assistant event, no DB row for the call. The same overload WITHOUT a start is still repeated (see "quota
// 429 …").
test("tool start: a round that breaks off after the start is not retried — the run ends, nothing is stored", async () => {
  const root = tmpRoot();
  try {
    const conn = connector({
      turns: [
        (a) => { a.onDelta({ toolStart: { id: "c1", name: "Read" } }); throw new Error(OVERLOAD); },
        () => ({ text: "second attempt" }),
      ],
    });
    const { res, events } = await runEngine(conn, { cwd: root });
    assert.equal(conn.seen.length, 1, "no retry after a reported start");
    assert.ok(!events.some((e) => e.type === "harness" && e.subtype === "retry"), "no retry event");
    assert.equal(res.code, 1);
    assert.equal(events.filter(isStart).length, 1);
    assert.ok(!events.some(isCall("c1")), "no assistant event for the broken-off call");
    assert.deepEqual(rowsFromEvents(events).filter((z) => z.role === "tool" || z.role === "tool_result"), [], "nothing of the call in the DB");
    assert.ok(events.at(-1)?.type === "result", "the turn ends with its result");
  } finally { rm(root); }
});

// ── Provider and loop engine ──────────────────────────────────────────────────────────────────────────────────────────────

// The tool list of a subagent (`agentTools`) and `enabledTools` at the server entry cut only the OFFER per round. The catalog in
// the system prompt and ToolSearch named and delivered the excluded tools, and a call under a name that was not offered went
// to the MCP server unchecked. Counter-test: ToolSearch delivers tool_9, the server runs it.
test("tool list at execution: the tool list applies at execution — ToolSearch, catalog and call know only what the run has", async () => {
  const root = tmpRoot();
  const server = path.join(root, "many.mjs");
  fs.writeFileSync(server, MANY_SERVER_SRC);
  try {
    // (a) A subagent's tool list.
    const conn = connector({
      turns: [
        () => ({ toolCalls: [{ id: "c1", name: "ToolSearch", input: { query: "select:mcp__many__tool_9" } }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c2", name: "mcp__many__tool_9", input: {} }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c3", name: "Bash", input: { command: "echo no" } }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "c4", name: "mcp__many__tool_3", input: {} }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    const { events } = await runEngine(conn, { cwd: root, agentTools: ["Read", "mcp__many__tool_3"], mcpServers: { many: { command: process.execPath, args: [server] } } });
    const [search, nine, bash, three] = toolResults(events);
    assert.doesNotMatch(search.content, /"name":"mcp__many__tool_9"/, `ToolSearch delivered a tool outside the list: ${search.content}`);
    assert.equal(nine.is_error, true, nine.content);
    assert.match(nine.content, /mcp__many__tool_9 is not available in this chat/);
    assert.doesNotMatch(nine.content, /called/);
    assert.match(bash.content, /Bash is not available in this chat/);
    assert.match(three.content, /called: tool_3/, "the listed tool works");
    for (const request of conn.seen) {
      const names = request.tools.map((t) => t.name);
      assert.ok(!names.includes("mcp__many__tool_9") && !names.includes("Bash"), `offered: ${names.join(", ")}`);
      assert.doesNotMatch(request.messages[0].content, /mcp__many__tool_9/, "the catalog in the system prompt does not name it");
    }

    // (b) `enabledTools` at the server entry (the individually released tools of a foreign server, as with Codex).
    const conn2 = connector({
      turns: [
        () => ({ toolCalls: [{ id: "d1", name: "mcp__many__tool_9", input: {} }], stop: "tool_calls" }),
        () => ({ toolCalls: [{ id: "d2", name: "mcp__many__tool_3", input: {} }], stop: "tool_calls" }),
        () => ({ text: "finished" }),
      ],
    });
    const two = await runEngine(conn2, { cwd: root, mcpServers: { many: { command: process.execPath, args: [server], enabledTools: ["tool_3"] } } });
    const [n2, d2] = toolResults(two.events);
    assert.equal(n2.is_error, true, n2.content);
    assert.doesNotMatch(n2.content, /called/);
    assert.match(d2.content, /called: tool_3/);
    assert.deepEqual(conn2.seen[0].tools.map((t) => t.name).filter((n) => n.startsWith("mcp__many__")), ["mcp__many__tool_3"]);
  } finally { rm(root); }
});

// At the step cap (60 tool rounds) the engine wrote only a stderr line that is discarded on exit 0 — the last interim sentence
// became the answer, a subagent reported "completed". Counter-test: exit 0, result without is_error.
// ONLY the subagent (depth >= 1) fails on it. Letting the main run end with exit 1 would send it into run_error/afterRunFailed —
// a graph workflow would end "failed", the goal gate would never judge (held at the main seam in engine-task-core.test.js,
// "step cap …"). It ends regularly and carries the cap as a hint in history and answer.
const interimStatuses = () => connector({ turns: [(a, i) => ({ text: `Interim state ${i}`, toolCalls: [{ id: `g${i}`, name: "Glob", input: { pattern: "*.nomatch" } }], stop: "tool_calls" })] });
test("step cap: a subagent's step cap is a failed turn — exit 1 and a result that names it as an error", async () => {
  const root = tmpRoot();
  try {
    const conn = interimStatuses();
    const { res, events } = await runEngine(conn, { cwd: root, agentDepth: 1 });
    assert.equal(conn.seen.length, 60, "the cap is at 60 rounds");
    assert.equal(res.code, 1, `stderr: ${res.stderr}`);
    const result = events.find((e) => e.type === "result");
    assert.equal(result.is_error, true, "the result names the cap as an error");
    assert.match(result.error.message, /Step cap of the loop engine reached: 60 tool rounds/);
    assert.match(res.stderr, /step cap reached/);
    assert.ok(!events.some((e) => e.type === "assistant" && /Harness hint: Step cap/.test(JSON.stringify(e))), "no hint in the subagent's history — its error is the report");
  } finally { rm(root); }
});

test("step cap: the MAIN run's step cap is no error — exit 0, the hint stands in history and answer", async () => {
  const root = tmpRoot();
  try {
    const conn = interimStatuses();
    const { res, events } = await runEngine(conn, { cwd: root });
    assert.equal(conn.seen.length, 60, "the cap is at 60 rounds");
    assert.equal(res.code, 0, `stderr: ${res.stderr}`);
    const result = events.find((e) => e.type === "result");
    assert.equal(result.is_error, undefined, "no error result: it would be limit evidence (do-run.js limitEvidence)");
    // The answer that completion and goal gate read: the last interim state AND the hint.
    assert.match(res.resultText, /^Interim state 59\n\n\[Harness hint: Step cap of the loop engine reached: 60 tool rounds/);
    assert.equal(result.result, res.resultText);
    // In the history as an answer of its own AFTER the last tool result — live (delta) and persisted (assistant).
    const lastResult = events.findLastIndex((e) => e.type === "user");
    const hint = events.findIndex((e) => e.type === "assistant" && e.message.content[0]?.text?.startsWith("[Harness hint: Step cap"));
    assert.ok(hint > lastResult, "the hint stands behind the last tool result");
    assert.ok(events.some((e) => e.type === "stream_event" && /Harness hint: Step cap/.test(e.event?.delta?.text || "")), "and live as text");
    assert.match(res.stderr, /step cap reached/, "the stderr row stays (a wording for humans in the log)");
  } finally { rm(root); }
});

// `"name":"Bash"` somewhere in the text used to be enough for the hint "Call the tool now through the native function-calling
// mechanism" — even for a quote from a log. Counter-test: with each of the four quotes the engine nudges.
test("quoted JSON is no call as text — no nudge; the slip itself is still recognized", async () => {
  const root = tmpRoot();
  try {
    for (const text of [
      'The line in the log reads: {"type":"tool_use","name":"Bash","input":{"command":"rm -rf build"}} — that was the call that deleted the build folder.',
      'The last line in the log is: {"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"rm -rf build"}}',
      'As a reminder, what the agent wrote:\n> {"name": "Bash", "arguments": {"command": "rm -rf build"}}',
      'The tool definition looks like this: {"name": "Read", "description": "reads a file"}.',
    ]) {
      const conn = connector({ turns: [() => ({ text }), () => ({ text: "followedUp" })] });
      const { res } = await runEngine(conn, { cwd: root });
      assert.equal(conn.seen.length, 1, `nudged on a quote: ${text}`);
      assert.equal(res.resultText, text);
    }
    for (const text of [
      '{"name": "Bash", "arguments": {"command": "ls"}}',
      'I read the file: {"name": "Read", "arguments": {"file_path": "a.txt"}}',
      'I call {"name": "Glob", "arguments": {}} now.',
      '```json\n{"name": "Glob", "arguments": {"pattern": "*.ts"}}\n```',
      '<tool_call>{"name": "Glob", "arguments": {}}</tool_call>',
    ]) {
      const conn = connector({ turns: [() => ({ text }), () => ({ text: "followedUp" })] });
      await runEngine(conn, { cwd: root });
      assert.equal(conn.seen.length, 2, `not nudged on the slip: ${text}`);
      assert.match(JSON.stringify(conn.seen[1].messages), /Harness hint: You output the tool call/);
    }
  } finally { rm(root); }
});

// Sampling (an MCP server asks the model of THIS run) ran without a counter, without a cap and any number of times at once — at
// the user's expense, triggered by a foreign server. Counter-test: five answers, five simultaneous requests.
const SAMPLING_SERVER_SRC = `
let buf = "";
let next = 1;
const open = {};
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } } });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ask_oft", description: "asks the model five times", inputSchema: { type: "object", properties: {} } }] } });
  if (msg.method === "tools/call") {
    let ok = 0, rejected = 0, rest = 5, reason = "";
    for (let k = 0; k < 5; k++) {
      const rid = "s" + (next++);
      open[rid] = (m) => {
        if (m.error) { rejected++; reason = m.error.message; } else ok++;
        if (--rest === 0) send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok=" + ok + " rejected=" + rejected + " reason=" + reason }] } });
      };
      send({ jsonrpc: "2.0", id: rid, method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "SAMPLING-QUESTION" } }], maxTokens: 5 } });
    }
    return;
  }
  if (msg.id !== undefined && open[msg.id]) { const f = open[msg.id]; delete open[msg.id]; return f(msg); }
  if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
}
`;
test("sampling of an MCP server is counted, capped and sequential — the refusal says it is a cap", async () => {
  const root = tmpRoot();
  const server = path.join(root, "sampling.mjs");
  fs.writeFileSync(server, SAMPLING_SERVER_SRC);
  const saved = process.env.CBASE_MCP_SAMPLING_MAX;
  process.env.CBASE_MCP_SAMPLING_MAX = "3";
  try {
    const base = connector({ turns: [() => ({ toolCalls: [{ id: "c1", name: "mcp__s__ask_oft", input: {} }], stop: "tool_calls" }), () => ({ text: "finished" })] });
    let samplings = 0, concurrent = 0, atMost = 0;
    const conn = {
      ...base,
      complete: async (a) => {
        if (!a.tools.length && JSON.stringify(a.messages).includes("SAMPLING-QUESTION")) {
          samplings++;
          atMost = Math.max(atMost, ++concurrent);
          await new Promise((r) => setImmediate(r));
          concurrent--;
          return { text: "Response", thinking: "", toolCalls: [], usage: { input: 1, output: 1, cached: 0 }, stop: "end" };
        }
        return base.complete(a);
      },
    };
    const { res, events } = await runEngine(conn, { cwd: root, mcpServers: { s: { command: process.execPath, args: [server] } } });
    const [result] = toolResults(events);
    assert.match(result.content, /ok=3 rejected=2/, result.content);
    assert.match(result.content, /Sampling cap reached: at most 3 model requests per run/);
    assert.equal(samplings, 3, "no model call above the cap");
    assert.equal(atMost, 1, "a server's requests run one after the other");
    assert.match(res.stderr, /sampling cap reached \(3 per run\)/);
  } finally {
    if (saved === undefined) delete process.env.CBASE_MCP_SAMPLING_MAX; else process.env.CBASE_MCP_SAMPLING_MAX = saved;
    rm(root);
  }
});

// A hook's deadline hit only its shell — a grandchild lived on as an orphan, and if it held stdout the run hung on its hook.
// Counter-test: the grandchild survives (after the fixed deadline of 30 s) — the test then waits forever for its death, the
// gate's deadline turns it red.
// The death is WAITED for, not checked at once: SIGKILL to the group is delivered when kill() returns, the grandchild has died only
// when the core has cleaned it up. The tick stands in a wait loop — a look interval, no deadline.
test("a hook's deadline ends its whole process group — no grandchild survives", async () => {
  const { execFileSync } = await import("node:child_process");
  const alive = (pid) => {
    try { const st = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); return st !== "" && !st.startsWith("Z"); }
    catch { return false; }
  };
  const root = tmpRoot();
  const pidFile = path.join(root, "grandchild.pid");
  const saved = process.env.CBASE_HOOK_DEADLINE_MS;
  process.env.CBASE_HOOK_DEADLINE_MS = "500";
  let pid = 0;
  try {
    const conn = connector({ turns: [() => ({ text: "finished" })] });
    const { res } = await runEngine(conn, {
      cwd: root,
      engine: { hooks: [{ event: "SessionStart", matcher: "*", command: `sleep 3600 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; wait` }] },
    });
    assert.equal(res.code, 0, res.stderr);
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(pid > 0, "the hook did not start its grandchild");
    while (alive(pid)) await new Promise((r) => setTimeout(r, 20)); // the hook's grandchild dies with its deadline — otherwise it hangs here
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    if (saved === undefined) delete process.env.CBASE_HOOK_DEADLINE_MS; else process.env.CBASE_HOOK_DEADLINE_MS = saved;
    rm(root);
  }
});

// The deadline for the model's regular expressions used to apply per TOOL CALL. The calls of one round run in B one after the
// other without returning to the event loop — N Grep calls with a backtracking pattern held B for N × deadline at a stretch (ten
// calls, 50 s without an event loop). Now ONE budget per round: the first call uses it up, every further one of the round fails
// WITHOUT entering the context. The entries into the deadline's vm context are counted (no clock: `runInContext` with `input`
// set). Counter-test: five entries in the first round. The next round has a new budget — an ordinary pattern works there again.
test("ONE regex budget per tool round — after the call that uses it up, none of the round enters the context", async () => {
  const vm = (await import("node:vm")).default;
  const root = tmpRoot();
  const saved = process.env.CBASE_REGEX_DEADLINE_MS;
  process.env.CBASE_REGEX_DEADLINE_MS = "300";
  const original = vm.Script.prototype.runInContext;
  let entrances = 0;
  vm.Script.prototype.runInContext = function (context, ...rest) {
    if (context && context.input) entrances++;
    return original.call(this, context, ...rest);
  };
  try {
    fs.writeFileSync(path.join(root, "malicious.txt"), `${"a".repeat(40)}!\nnormal\n`);
    const conn = connector({ turns: [
      () => ({ toolCalls: Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, name: "Grep", input: { pattern: "^(a+)+$" } })), stop: "tool_calls" }),
      () => ({ toolCalls: [{ id: "n1", name: "Grep", input: { pattern: "normal", output_mode: "files_with_matches" } }], stop: "tool_calls" }),
      () => ({ text: "finished" }),
    ] });
    const { res, events } = await runEngine(conn, { cwd: root });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(entrances, 2, "one entry of the first round (it uses up the budget), one of the second");
    const [g0, g1, g2, g3, g4, n1] = toolResults(events);
    for (const r of [g0, g1, g2, g3, g4]) {
      assert.equal(r.is_error, true, r.content);
      assert.match(r.content, /deadline of 300 ms/);
    }
    assert.match(g1.content, /of this tool round is already exceeded — this expression did not run/);
    assert.match(n1.content, /malicious\.txt/, "the next round has a new budget");
  } finally {
    vm.Script.prototype.runInContext = original;
    if (saved === undefined) delete process.env.CBASE_REGEX_DEADLINE_MS; else process.env.CBASE_REGEX_DEADLINE_MS = saved;
    rm(root);
  }
});

// The date line: emitted in English, but a history stored before the rename carries the German form — it must still count
// as "the history names today", or every old chat would get a second date line (and lose its cached prefix).
// Counter-test: DATE_ROW in providers/engine.js reading only "Today is" turns the German case red.
test("date line: a history naming today in the old German or the new English form gets no second date line", async () => {
  assert.equal(dateLine("2026-01-02"), "[Today is 2026-01-02.]");
  for (const line of [`[Heute ist der ${todayIso()}.]`, dateLine(todayIso())]) {
    const root = tmpRoot();
    try {
      const conn = connector({ turns: [() => ({ text: "ok" })] });
      const transcript = [{ role: "user", content: `${line}\n\nTurn 1` }, { role: "assistant", content: "Done." }];
      const { res } = await runEngine(conn, { cwd: root, input: "Turn 2", transcript });
      assert.equal(res.code, 0);
      const users = conn.seen[0].messages.filter((x) => x.role === "user").map((x) => String(x.content));
      assert.equal(users.at(-1), "Turn 2", `${line}: the history names today, no new date line`);
    } finally { rm(root); }
  }
});
