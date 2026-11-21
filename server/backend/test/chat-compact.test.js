import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { readJsonl } from "./jsonl.mjs";
import { waitForQuiet } from "./quiet.mjs";

// Compacting locks the chat: while the server summarises, there is no session a turn could run against (it is discarded at
// the end). A message from this phase must therefore WAIT and then start as its own, fresh run — not be answered at once.

async function json(url, init) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// Wait for a marker of the fake CLI — without a deadline (no clock a test goes red on; if it hangs, the suite ends the run).
// `what` names the marker; every 30 s it goes to stderr so a hang stays readable.
async function waitForFile(filePath, what) {
  const start = Date.now();
  let reported = 0;
  while (!fs.existsSync(filePath)) {
    const s = Math.floor((Date.now() - start) / 30_000);
    if (s > reported) { reported = s; console.error(`[waiting] ${s * 30} s so far: ${what} (${filePath})`); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// After a failure only a few looks at the quiet — the body's error stays the reported one, no hang.
async function shortWaitForQuiet(base) {
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("during compacting a message is queued instead of answered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-compact-"));
  const bin = path.join(root, "fake-claude");
  const argvLog = path.join(root, "argv.jsonl");
  const promptLog = path.join(root, "prompts.jsonl");
  // Two markers steer the compaction WINDOW: with the first the fake reports that it has the transcript (from here the chat is in
  // `compacting`), then it waits for the second before it outputs the summary. So the test decides itself when the window
  // closes — a fixed clock against the runtime of the test's own HTTP calls would be flaky.
  const compactionRunning = path.join(root, "compaction-running");
  const approval = path.join(root, "approval-summary");
  // One line per summary the fake BEGINS: from it the test sees a second compaction that does not bounce.
  const compactions = path.join(root, "compactions.jsonl");
  const previousBin = process.env.CLAUDE_BIN;
  const previousPoll = process.env.CBASE_TRIGGER_POLL;
  let server;
  let base = "";
  let ok = false;
  try {
    // The compaction WINDOW belongs to the test, not to the clock. With fixed waits under load the test's own HTTP calls could take
    // longer than the rest, the compaction would be done, the queued run would start, and the second /compact would get "run
    // active" (409) instead of {ok:false} — a test that measured something other than it claimed.
    // Now: the fake reports that it has the transcript and waits for the test's release.
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  let input = "";
  process.stdin.on("data", (d) => { input += d; });
  process.stdin.on("end", () => {
    if (input.includes("=== HISTORY ===")) {
      fs.appendFileSync(${JSON.stringify(compactions)}, JSON.stringify(process.pid) + "\\n");
      fs.writeFileSync(${JSON.stringify(compactionRunning)}, "1");
      // Wait until the test closes the window — without a clock of its own: the test's cleanup writes the release even after a
      // failure.
      const tick = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(approval)})) return;
        clearInterval(tick);
        console.log(JSON.stringify({ result: "SUMMARY: It was about the test." }));
      }, 25);
    } else {
      console.log(JSON.stringify({ result: "Test title" }));
    }
  });
} else {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const text = String(msg.message?.content?.[0]?.text || "");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(text) + "\\n");
    const answer = "Answer to: " + text;
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }));
    console.log(JSON.stringify({ type: "result", result: answer, session_id: "session-1" }));
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
      body: JSON.stringify({ name: "Compact-Test", path: wsPath }),
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

    // Some history, otherwise the server refuses to compact.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "First message" }) });
    // The QUIET, not just "no turn": the title oneshot of this unnamed chat is done too.
    await waitForQuiet(base);
    assert.equal(readJsonl(argvLog).length, 1);

    // Start compacting but do NOT wait for it — exactly this window is the subject. It stays open until the test releases it
    // below; it waits for the fake's marker, not for a clock.
    const compactDone = json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" });
    await waitForFile(compactionRunning, "the compaction has received the transcript");

    const delivered = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "Second message" }),
    });
    assert.equal(delivered.queued, true, "the message must be queued");
    assert.equal(delivered.compacting, true, "the reason for waiting belongs in the answer");
    assert.equal(delivered.injected, false, "there is no process to inject into");
    assert.equal(
      readJsonl(argvLog).length,
      1,
      "no second run may be started during compacting",
    );

    // A second compaction meanwhile bounces instead of producing two summaries. The window is demonstrably open here:
    // `delivered.compacting` above came from the server, and the release below is not written yet. The other failure — a second
    // compaction that does NOT bounce but starts and itself waits for the release (exactly what it would do without the `compacting`
    // branch in compactChatContext) — shows as a SECOND summary in the fake: it waits for the answer OR for that, not for a clock.
    let duplicate = null;
    let duplicateError = null;
    const duplicateP = json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" })
      .then((b) => { duplicate = b; }, (e) => { duplicateError = e; });
    for (;;) {
      if (duplicate || duplicateError) break;
      if (readJsonl(compactions).length > 1) throw new Error("the second /compact did not bounce — a second summary began");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await duplicateP;
    if (duplicateError) throw duplicateError;
    assert.equal(duplicate.ok, false, "a second compaction in the open window must bounce");
    assert.match(String(duplicate.note || ""), /komprimiert|compact/i, "and say why");
    assert.equal(
      readJsonl(argvLog).length,
      1,
      "the bounced compaction started no run either",
    );

    // Only now close the window.
    fs.writeFileSync(approval, "1");
    const compacted = await compactDone;
    assert.equal(compacted.ok, true);

    // Now — and only now — the queued message starts.
    await waitForQuiet(base);
    const invocations = readJsonl(argvLog); // only completed lines (jsonl.mjs) — the fake CLI writes while the test reads
    assert.equal(invocations.length, 2, "after compacting exactly one run starts");
    assert.equal(invocations[1].includes("--resume"), false, "the run after compacting starts without the old session");

    const log = await json(`${base}/api/chats/${chat.id}/log`);
    assert.equal(log.filter((row) => row.role === "user").length, 2);
    assert.equal(log.filter((row) => row.role === "assistant").length, 2);
    // The summary stands as a boundary in the log, and the second message comes AFTER it.
    const marker = log.findIndex((row) => row.role === "meta" && (() => { try { return JSON.parse(row.text).compacted; } catch { return false; } })());
    assert.ok(marker >= 0, "the compaction boundary is missing in the log");
    const second = log.findIndex((row) => row.role === "user" && row.text === "Second message");
    assert.ok(second > marker, "the queued message belongs after the boundary");

    // The follow-up run got the fresh summary prepended as context — exactly what is waited for. (Afterwards contextSummary
    // is empty again: it applies once.)
    const prompts = readJsonl(promptLog);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /SUMMARY/);
    assert.match(prompts[1], /Second message/);
    ok = true;
  } finally {
    // The fake CLI waits for this file: without it a summary would hang on even after a failure.
    try { fs.writeFileSync(approval, "1"); } catch { /* folder already gone */ }
    if (base && !ok) await shortWaitForQuiet(base);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    if (previousPoll === undefined) delete process.env.CBASE_TRIGGER_POLL;
    else process.env.CBASE_TRIGGER_POLL = previousPoll;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
