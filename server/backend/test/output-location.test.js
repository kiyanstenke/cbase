// The output location per chat (runs/outputs.js).
//
// A subagent's completion notice names its output file (`outputFile`). It used to live under `scratch/<chat>.agents` - in NO run
// under the readable directories: the agent that received the notice could not read the file (measured on Claude 2.1.280,
// `--permission-mode default`: "Claude requested permissions to read ... but you haven't granted it yet"; read with `--add-dir` -
// measured against the real CLI).
//
// Held here, on a real server with a real MCP server and the real agent core:
//   1. all three ways carry the location: the Claude main run and a Claude subagent with `--add-dir <location>`, a Codex subagent
//      with `--add-dir <location>`, and an engine subagent READS a file there (sandbox cwd + addDirs);
//   2. a subagent's output is created there, the report names the path, and after a restart on the same database it is still
//      there unchanged - and the next run carries the location again.
//
// COUNTER-TESTS (each shown red, then restored): without the `addDirs.push(createOutputLocation(...))` line in runs/do-run.js both
// tests are red (no `--add-dir`, the engine reports "outside the sandbox"); with the old output folder in runs/agents.js test 2
// is red. The engine check alone (the three argv checks removed) reports "Path outside the allowed area" under the first
// sabotage.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fakeClaude, json, withAgentsServer } from "./agent-harness.mjs";

// Every fake deposits its arguments: argv-<role>-<n>.json in the test's folder.
const argvDeposit = (role) => `
  { let n = 1; while (fs.existsSync(path.join(LOCATION, "argv-${role}-" + n + ".json"))) n++;
    fs.writeFileSync(path.join(LOCATION, "argv-${role}-" + n + ".json"), JSON.stringify(argv)); }`;
const argvOf = (root, role, n = 1) => JSON.parse(fs.readFileSync(path.join(root, `argv-${role}-${n}.json`), "utf8"));
const addDirs = (argv) => argv.flatMap((a, i) => (a === "--add-dir" ? [argv[i + 1]] : []));

const fakeCodexWithArgv = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const LOCATION = "__CBASE_AGENT_HARNESS_LOCATION__";
try { fs.writeFileSync(path.join(LOCATION, "pids", String(process.pid)), "codex"); } catch {}
const argv = process.argv.slice(2);
${argvDeposit("codex")}
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: "codex-thread" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "answer-1", type: "agent_message", text: "Codex-Befund 42" } });
say({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } });
`;

// Main agent: one subagent each at Claude, Codex and the engine, one after another.
const threeWays = fakeClaude({
  sub: `${argvDeposit("sub")}
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Claude-Befund 42" }] } });
    finished();
    say({ type: "result", result: "Claude-Befund 42", session_id: "sub-session" });`,
  main: `${argvDeposit("main")}
  const reports = {};
  for (const [id, model] of [["toolu_claude", ""], ["toolu_codex", "codex::gpt-5.1-codex"], ["toolu_engine", "openrouter::m1"]]) {
    const input = { description: "Finding " + id, prompt: "Report the finding.", run_in_background: false, ...(model ? { model } : {}) };
    say({ type: "assistant", message: { id: "main-" + id, content: [{ type: "tool_use", id, name: "mcp__cbase__cbase_agent", input }] } });
    let r = "";
    try { r = textOf(await mcpCall("cbase_agent", input)); } catch (e) { r = "ERROR " + e.message; }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: r }] } });
    reports[id] = r;
  }
  say({ type: "assistant", message: { id: "main-end", content: [{ type: "text", text: "done " + turn }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
});

const report = (log, id) => {
  const row = log.filter((m) => m.role === "tool_result").map((m) => JSON.parse(m.text)).find((r) => r.id === id);
  assert.ok(row, `no result for ${id}: ${JSON.stringify(log.map((l) => l.role))}`);
  return JSON.parse(row.result);
};

test("Claude, Codex and the loop engine: every run of the chat can read the output location", async () => {
  let probe = "";
  await withAgentsServer(async ({ base, chat, dataRoot, root, engine, waitForLog }) => {
    const location = path.join(dataRoot, "data", "outputs", chat.id);
    probe = path.join(location, "probe.txt");
    fs.mkdirSync(location, { recursive: true });
    fs.writeFileSync(probe, "probe-at-location");

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Fetch findings" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    // Claude: main run and subagent carry the location as --add-dir.
    assert.ok(addDirs(argvOf(root, "main")).includes(location), `main run without --add-dir ${location}: ${addDirs(argvOf(root, "main"))}`);
    assert.ok(addDirs(argvOf(root, "sub")).includes(location), "Claude subagent without the output location");
    // Codex: likewise (the sandbox also reads without it at 0.153.1 - measured - the --add-dir holds it regardless).
    assert.equal(report(log, "toolu_codex").status, "completed");
    assert.ok(addDirs(argvOf(root, "codex")).includes(location), "Codex subagent without the output location");
    // Engine: it really READ the file - its tool result is in the next request.
    assert.equal(report(log, "toolu_engine").status, "completed");
    const toolMessages = engine.requests.flatMap((a) => (a.messages || []).filter((m) => m.role === "tool")).map((m) => String(m.content));
    assert.ok(toolMessages.length >= 1, "the engine never executed the tool");
    assert.ok(toolMessages.some((t) => t.includes("probe-at-location")), `the engine could not read the location: ${toolMessages.join(" | ").slice(0, 400)}`);
  }, { claude: threeWays, codex: fakeCodexWithArgv, engine: { tool: () => ({ name: "Read", input: { file_path: probe } }) } });
});

test("A subagent's output sits at the location, the report names it, and a restart leaves it unchanged", async () => {
  await withAgentsServer(async ({ base, chat, dataRoot, root, waitForLog, restart }) => {
    const location = path.join(dataRoot, "data", "outputs", chat.id);
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Fetch finding" }) });
    const log = await waitForLog(chat.id, (l) => l.some((m) => m.role === "meta"));

    const b = report(log, "toolu_claude");
    assert.equal(b.status, "completed");
    assert.equal(path.dirname(b.outputFile), path.join(location, "agents"), `the report names ${b.outputFile}`);
    const prior = fs.readFileSync(b.outputFile);
    assert.match(prior.toString("utf8"), /Claude-Befund 42/);
    assert.ok(!fs.existsSync(path.join(dataRoot, "data", "scratch", `${chat.id}.agents`)), "the old scratch folder is no longer created");

    await restart();
    assert.deepEqual(fs.readFileSync(b.outputFile), prior, "the output file did not survive the restart unchanged");

    // The next run after the restart carries the location again - the file stays readable for the chat.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Once more" }) });
    await waitForLog(chat.id, (l) => l.filter((m) => m.role === "meta").length >= 2);
    assert.ok(addDirs(argvOf(root, "main", 2)).includes(location), "the run after the restart does not carry the output location");
    assert.deepEqual(fs.readFileSync(b.outputFile), prior);
  }, { claude: fakeClaude({
    sub: `
    say({ type: "assistant", message: { id: "sub-1", content: [{ type: "text", text: "Claude-Befund 42" }] } });
    finished();
    say({ type: "result", result: "Claude-Befund 42", session_id: "sub-session" });`,
    main: `${argvDeposit("main")}
  if (!text.includes("Once more")) { // the run after the restart starts no second subagent
    const input = { description: "Finding", prompt: "Report the finding.", run_in_background: false };
    say({ type: "assistant", message: { id: "main-1", content: [{ type: "tool_use", id: "toolu_claude", name: "mcp__cbase__cbase_agent", input }] } });
    let r = "";
    try { r = textOf(await mcpCall("cbase_agent", input)); } catch (e) { r = "ERROR " + e.message; }
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_claude", content: r }] } });
  }
  say({ type: "assistant", message: { id: "main-end-" + turn, content: [{ type: "text", text: "done " + turn }] } });
  finished();
  say({ type: "result", result: "finished", session_id: "main-session" });`,
  }) });
});
