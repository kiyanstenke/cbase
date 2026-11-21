import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runChatClaude } from "../electron/server/providers/connectors/claude.js";
import { runChatCodex } from "../electron/server/providers/connectors/codex.js";
import { runChatViaEngine } from "../electron/server/providers/engine.js";

const baseSpec = (cwd) => ({
  cwd,
  input: "first message",
  systemPrompt: "",
  addDirs: [],
  permissionMode: "bypassPermissions",
  mcpConfigPath: path.join(cwd, "mcp.json"),
  mcpServers: {},
  allowedTools: [],
  permissionPromptTool: false,
  model: "",
  effort: "",
  sessionId: "",
  forkPending: false,
});

test("Claude takes an injected message in the same running process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-claude-inject-"));
  const bin = path.join(root, "fake-claude");
  const previous = process.env.CLAUDE_BIN;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const readline = require("node:readline");
let turn = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "user") return;
  turn++;
  const text = turn === 1 ? "answer one" : "answer two";
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
  console.log(JSON.stringify({ type: "result", result: text, session_id: "claude-session" }));
});
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;

    let handle;
    let turns = 0;
    const result = await runChatClaude({
      spec: baseSpec(root),
      onSpawn: (h) => { handle = h; },
      onEvent: (evt) => {
        if (evt.type !== "result") return;
        turns++;
        if (turns === 1) assert.equal(handle.cbaseInject("queued message"), true);
        else handle.cbaseEndInput();
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.resultText, "answer two");
    assert.equal(turns, 2);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
    // A test must not fail because its temp dir will not go away (a child still writing causes ENOTEMPTY - a
    // statement about cleanup, not the product); but it is not swallowed silently either, or junk piles up in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("Codex takes an injected message via thread resume in the same logical run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-codex-inject-"));
  const bin = path.join(root, "fake-codex");
  const state = path.join(root, "turn");
  const previous = process.env.CODEX_BIN;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const state = ${JSON.stringify(state)};
const turn = fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) + 1 : 1;
fs.writeFileSync(state, String(turn));
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }));
console.log(JSON.stringify({ type: "item.completed", item: {
  id: "answer-" + turn, type: "agent_message", text: turn === 1 ? "answer one" : "answer two"
} }));
console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
`);
    fs.chmodSync(bin, 0o755);
    process.env.CODEX_BIN = bin;

    let handle;
    let turns = 0;
    const result = await runChatCodex({
      spec: baseSpec(root),
      onSpawn: (h) => { handle = h; },
      onEvent: (evt) => {
        if (evt.type !== "result") return;
        turns++;
        if (turns === 1) assert.equal(handle.cbaseInject("queued message"), true);
        else handle.cbaseEndInput();
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.resultText, "answer two");
    assert.equal(turns, 2);
    assert.equal(fs.readFileSync(state, "utf8"), "2");
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    // A test must not fail because its temp dir will not go away (a child still writing causes ENOTEMPTY - a
    // statement about cleanup, not the product); but it is not swallowed silently either, or junk piles up in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});

test("Third-party engine takes an injected message with history preserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-engine-inject-"));
  try {
    const seen = [];
    const connector = {
      id: "test-provider",
      label: "Test",
      models: [{ id: "test-model", label: "Test", context: 128_000 }],
      caps: { ownsAgentLoop: false, vision: false, subagents: false },
      resolveModel: () => "test-model",
      complete: async ({ messages }) => {
        seen.push(messages.map((m) => m.role));
        return {
          text: seen.length === 1 ? "answer one" : "answer two",
          thinking: "",
          toolCalls: [],
          usage: { input: 10, output: 2, cached: 0 },
          stop: "end",
        };
      },
    };

    let handle;
    let turns = 0;
    const result = await runChatViaEngine(connector, {
      spec: { ...baseSpec(root), engine: {}, transcript: [] },
      onSpawn: (h) => { handle = h; },
      onEvent: (evt) => {
        if (evt.type !== "result") return;
        turns++;
        if (turns === 1) assert.equal(handle.cbaseInject("queued message"), true);
        else handle.cbaseEndInput();
      },
    });

    assert.equal(result.code, 0);
    assert.equal(result.resultText, "answer two");
    assert.equal(turns, 2);
    assert.deepEqual(seen[1], ["system", "user", "assistant", "user"]);
  } finally {
    // A test must not fail because its temp dir will not go away (a child still writing causes ENOTEMPTY - a
    // statement about cleanup, not the product); but it is not swallowed silently either, or junk piles up in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) - test unaffected.`); }
  }
});
