import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { readJsonl } from "./jsonl.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// After a failure only a few looks at the quiet — the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("/clear keeps the history, persists a boundary and starts without the old session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-clear-"));
  const bin = path.join(root, "fake-claude");
  const argvLog = path.join(root, "argv.jsonl");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  let server;
  let base = "";
  let ok = false;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify({ result: "Test title" })));
} else {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    const answer = "Answer to: " + text;
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }));
    console.log(JSON.stringify({ type: "result", result: answer, session_id: "session-before-clear" }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";

    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data-root"),
      webDir: path.join(root, "web"),
      pickDirectory: null,
      notify: null,
    });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, {
      method: "POST",
      body: JSON.stringify({ name: "Clear-Test", path: wsPath }),
    });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        provider: "claude",
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
      }),
    });
    await json(`${base}/api/chats/${chat.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Clear-Test" }),
    });

    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "First message" }),
    });
    await waitForQuiet(base);
    let current = await json(`${base}/api/chats/${chat.id}`);
    assert.equal(current.claudeSessionId, "session-before-clear");

    const cleared = await json(`${base}/api/chats/${chat.id}/clear`, { method: "POST" });
    assert.equal(cleared.ok, true);
    current = await json(`${base}/api/chats/${chat.id}`);
    assert.equal(current.claudeSessionId, null);
    assert.equal(current.contextTokens, 0);

    let log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.deepEqual(log.map((row) => row.role).filter((role) => ["user", "assistant", "clear"].includes(role)), ["user", "assistant", "clear"]);
    const marker = JSON.parse(log.find((row) => row.role === "clear").text);
    assert.equal(marker.cleared, true);
    assert.equal(marker.at, cleared.at);

    const compacted = await json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    assert.equal(compacted.ok, false, "old history behind /clear must not be compactable");

    await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Second message" }),
    });
    await waitForQuiet(base);
    const invocations = readJsonl(argvLog); // only completed lines (jsonl.mjs) — the fake CLI writes while the test reads
    assert.equal(invocations.length, 2);
    assert.equal(invocations[1].includes("--resume"), false, "the first run after /clear must start fresh");

    log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(log.filter((row) => row.role === "user").length, 2);
    assert.equal(log.filter((row) => row.role === "assistant").length, 2);
    assert.equal(log.filter((row) => row.role === "clear").length, 1);
    ok = true;
  } finally {
    if (base && !ok) await shortWaitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
