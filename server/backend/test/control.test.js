// "Steer": the running turn is aborted, and ALL queued messages go out at once — each as its own row in the history,
// together exactly ONE run.
//
// The check is the turn order in the log, because only it shows both halves: that the running turn wrote no answer any more, AND
// that the two messages did not become two runs (an assistant row would then stand between them).
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
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}

// Wait for an event — without a deadline (no clock a test turns red on; if it hangs, the suite ends the run). `what` names the
// condition; every 30 s it appears on stderr so that a hang stays readable.
async function waitForTruthy(check, what) {
  const start = Date.now();
  let reported = 0;
  for (;;) {
    const last = await check();
    if (last) return last;
    const s = Math.floor((Date.now() - start) / 30_000);
    if (s > reported) { reported = s; console.error(`[waiting] for ${s * 30} s: ${what}`); }
    await new Promise((r) => setTimeout(r, 30));
  }
}

// Clean up: after a body that ran through, wait for QUIET (quiet.mjs — also title one-shot, queue, compaction; `busy` said only
// "a turn is running" of that). After a failure stop the runs and wait only a few glances: the body's error stays the reported one,
// and a remainder that does not come to rest does not become a hang.
async function cleanUp(base, bodyOk) {
  if (bodyOk) { await waitForQuiet(base); return; }
  try {
    const r = await json(`${base}/api/active-runs`);
    for (const it of r?.items || []) if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
  } catch { /* server may already be closed */ }
  for (let i = 0; i < 200; i++) {
    const st = await json(`${base}/api/runs/active`).catch(() => null);
    if (!st || st.quiet) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.warn("run still running during cleanup (after a failure)");
}

test("Steering aborts the run and sends the whole queue as ONE run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-control-"));
  const bin = path.join(root, "fake-claude");
  // The gate of the FIRST turn: it answers only when this file exists — and only the cleanup writes it. So it is aborted for sure,
  // not finished by chance beforehand (a clock against the load would be the alternative).
  const firstMay = path.join(root, "first-may-responses");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let bodyOk = false;
  try {
    // The second turn answers at once.
    // Slow or fast is decided by the PROMPT, not a turn counter: after the abort the second run starts a NEW process whose counter
    // would be at one again — the steered message would then have waited too.
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (msg.type !== "user") return;
  const slow = line.includes("Running now");
  const text = slow ? "Answer to the first" : "Answer after steering";
  const respond = () => {
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    console.log(JSON.stringify({ type: "result", result: text, session_id: "control-session" }));
  };
  if (!slow) return respond();
  const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(firstMay)})) { clearInterval(t); respond(); } }, 25);
});
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;

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
      body: JSON.stringify({ name: "Steer test", path: wsPath }),
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

    const first = await json(`${base}/api/chats/${chat.id}/message`, {
      method: "POST", body: JSON.stringify({ text: "Running now" }),
    });
    assert.equal(first.queued, false);

    let queue = [];
    for (const text of ["Pushed one", "Pushed two"]) {
      const r = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      assert.equal(r.queued, true, `"${text}" should have been queued`);
      queue = r.queue;
    }

    // The queue comes with the send response (and via SSE) — `GET /api/chats/:id` does NOT carry it. Each entry says whether it is
    // steerable: only user messages are.
    assert.equal(queue.length, 2);
    assert.ok(queue.every((q) => q.controllable === true), "both entries are user messages");
    assert.deepEqual(queue.map((q) => q.text), ["Pushed one", "Pushed two"]);

    const controlled = await json(`${base}/api/chats/${chat.id}/control`, { method: "POST" });
    assert.equal(controlled.sent, 2, "both messages go out together");
    assert.deepEqual(controlled.queue, [], "the queue is empty afterwards");

    const log = await waitForTruthy(
      async () => {
        const l = await json(`${base}/api/chats/${chat.id}/log`);
        return l.some((m) => m.role === "assistant" && m.text === "Answer after steering") ? l : null;
      },
      "answer to the steered messages",
    );

    assert.deepEqual(
      log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]),
      [
        ["user", "Running now"],
        // NO assistant row here: the turn was aborted before it could answer.
        ["user", "Pushed one"],
        ["user", "Pushed two"],
        // And only ONE answer: the two messages ran together as one turn.
        ["assistant", "Answer after steering"],
      ],
    );

    // Without a queue "steer" is moot — and must not abort a run.
    const res = await fetch(`${base}/api/chats/${chat.id}/control`, { method: "POST" });
    assert.equal(res.status, 409);
    await res.json().catch(() => ({}));
    bodyOk = true;
  } finally {
    // The gate of the first turn: if it was still running (failure), it answers now and ends.
    try { fs.writeFileSync(firstMay, "1"); } catch { /* folder already gone */ }
    if (base) await cleanUp(base, bodyOk);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// Steering DURING THE COMPACTION: no turn runs there (`running` is empty), so the clause "abort the running turn" would fall
// through — and a run would start ALONGSIDE the compaction, with the old session and the full history, exactly what is being paid
// for. Afterwards `compactChatContext` would write `claudeSessionId: null` into it in the middle of the turn. Correct is: 409, the
// messages stay queued — the compaction's finally starts them itself, and then they see the summary.
test("Steering during the compaction: 409, no run — the queue runs by itself afterwards", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-control-compact-"));
  const bin = path.join(root, "fake-claude");
  const startMarker = path.join(root, "compacted-running");
  const further = path.join(root, "further");
  const promptLog = path.join(root, "prompts.jsonl");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let compactP = null;
  let bodyOk = false;
  try {
    // The summary holds until the test creates the file "continue": the compaction's time window is thereby deterministic and no sleep
    // command. The one-shot of the AUTO TITLE runs through the same branch and must not wait too — it answers at once; they are told
    // apart by the prompt, not a counter (the title comes earlier or later depending on the run).
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) {
  let buf = "";
  process.stdin.on("data", (d) => { buf += d; });
  process.stdin.on("end", () => {
    if (!buf.includes("compacting the chat history")) {
      fs.writeSync(1, JSON.stringify({ result: "Title" }) + "\\n");
      process.exit(0);
    }
    fs.writeFileSync(${JSON.stringify(startMarker)}, "1");
    const t = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(further)})) return;
      clearInterval(t);
      // writeSync instead of console.log: Node writes to a PIPE asynchronously, a process.exit afterwards would lose the line.
      fs.writeSync(1, JSON.stringify({ result: "SUMMARY" }) + "\\n");
      process.exit(0);
    }, 25);
  });
} else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const prompt = String(msg.message?.content?.[0]?.text || "");
    fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + "\\n");
    const text = prompt.includes("Pushed one") && prompt.includes("Pushed two")
      ? "Answer to both"
      : prompt.includes("Pushed one") ? "Answer one"
      : prompt.includes("Pushed two") ? "Answer two"
      : "Answer to the first question";
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    console.log(JSON.stringify({ type: "result", result: text, session_id: "compact-session" }));
  });
}
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;

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
      body: JSON.stringify({ name: "Steer compaction", path: wsPath }),
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

    // First a completed exchange: below two rows the compaction refuses.
    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "First question" }) });
    // QUIET, not just "no turn": the title one-shot of this unnamed chat runs through the same fake.
    await waitForQuiet(base);

    // Without await: the route answers only when the summary exists.
    let compactError = null;
    compactP = json(`${base}/api/chats/${chat.id}/compact`, { method: "POST" })
      .catch((e) => { compactError = e; return null; });
    await waitForTruthy(async () => fs.existsSync(startMarker), "the compaction has started");

    let queue = [];
    for (const text of ["Pushed one", "Pushed two"]) {
      const r = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
      assert.equal(r.queued, true, `"${text}" should have been queued`);
      assert.equal(r.compacting, true, "queued because of the compaction, not because of a run");
      queue = r.queue;
    }
    assert.deepEqual(queue.map((q) => q.text), ["Pushed one", "Pushed two"]);

    const res = await fetch(`${base}/api/chats/${chat.id}/control`, { method: "POST" });
    assert.equal(res.status, 409);
    const body = await res.json().catch(() => ({}));
    assert.equal(body.reason, "compacted", "the reason differs from \"no queued message\"");

    // And without effect: no run, and the queue stands untouched.
    const active = await json(`${base}/api/runs/active`);
    assert.equal(active.runs | 0, 0, "no run may have been started during the compaction");
    const betweenLog = await json(`${base}/api/chats/${chat.id}/log`);
    assert.ok(
      !betweenLog.some((m) => m.role === "user" && m.text === "Pushed one"),
      "the queued message is not yet in the history",
    );

    fs.writeFileSync(further, "1");
    const out = await compactP;
    assert.equal(compactError, null, `Compaction failed: ${compactError?.message || ""}`);
    assert.equal(out.ok, true);

    const log = await waitForTruthy(
      async () => {
        const l = await json(`${base}/api/chats/${chat.id}/log`);
        return l.some((m) => m.role === "assistant" && m.text === "Answer to both") ? l : null;
      },
      "the queued messages run by themselves after the compaction",
    );
    assert.deepEqual(
      log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]),
      [
        ["user", "First question"],
        ["assistant", "Answer to the first question"],
        // ONE run for both. Bundling happens at EVERY handover point (head bundle), not only when steering; this test covers the
        // second of them: the drain in the compaction's finally.
        ["user", "Pushed one"],
        ["user", "Pushed two"],
        ["assistant", "Answer to both"],
      ],
    );

    // Do not check `contextSummary`: the summary is injected ONCE at the next prompt and emptied in the process — so it stands only in the prompt and at the marker.
    const marker = log.filter((m) => m.role === "meta").map((m) => { try { return JSON.parse(m.text); } catch { return {}; } }).find((m) => m.compacted);
    assert.ok(marker, "the compaction wrote its marker into the history");
    assert.equal(marker.chars, "SUMMARY".length);
    const prompts = readJsonl(promptLog); // Only completed rows (jsonl.mjs) — the fake CLI writes while the test reads.
    // TWO prompts, not three: the first question and ONE bundled turn for both pushed messages. That is the number the bundling hangs on here.
    assert.equal(prompts.length, 2, `the queue ran as ONE turn — prompts: ${JSON.stringify(prompts)}`);
    assert.match(
      prompts[1],
      /SUMMARY[\s\S]*Pushed one[\s\S]*Pushed two/,
      "the turn afterwards sees the fresh summary AND both messages — exactly why it is not steered",
    );
    bodyOk = true;
  } finally {
    // The fake CLI waits for this file: without it, it would keep hanging after a failure.
    try { fs.writeFileSync(further, "1"); } catch { /* folder already gone */ }
    if (compactP) await compactP.catch(() => {});
    if (base) await cleanUp(base, bodyOk);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// `waitForRunEnd` returns SILENTLY after its deadline (8 s). If the stopped run does not end that fast — a grandchild keeps stderr
// open, like an MCP child that outlives the CLI — steering would start the collecting run anyway: a second doRun next to the old
// one, the stop's abort marker killed it at spawn, and the messages already taken were gone. Now steering asks again after the
// wait: 409 "running", the messages stay queued and run after the old run ends. The grandchild hangs on a gate, not a clock; the
// 8 s are the server's deadline, not the test's.
test("Steering when the stopped run does not end in time: 409, the message stays queued and runs afterwards", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-control-tough-"));
  const bin = path.join(root, "fake-claude");
  const firstMay = path.join(root, "first-may-responses");
  const grandchildFree = path.join(root, "grandchild-free");
  const turnLog = path.join(root, "turns.jsonl");
  const previousBin = process.env.CLAUDE_BIN;
  let server;
  let base = "";
  let bodyOk = false;
  try {
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const GRANDCHILD_FREE = ${JSON.stringify(grandchildFree)};
const FIRST_MAY = ${JSON.stringify(firstMay)};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.exitCode = 1; return; }
  if (msg.type !== "user") return;
  const tough = line.includes("TOUGH");
  fs.appendFileSync(${JSON.stringify(turnLog)}, JSON.stringify({ pid: process.pid, tough }) + "\\n");
  const text = tough ? "Answer to the tough one" : "Answer after steering";
  const respond = () => {
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
    console.log(JSON.stringify({ type: "result", result: text, session_id: "control-session" }));
  };
  if (!tough) return respond();
  const grandchild = "const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(" + JSON.stringify(GRANDCHILD_FREE) + ")) process.exit(0); }, 25);";
  spawn(process.execPath, ["-e", grandchild], { stdio: ["ignore", "ignore", "inherit"], detached: true }).unref();
  const t = setInterval(() => { if (fs.existsSync(FIRST_MAY)) { clearInterval(t); respond(); } }, 25);
});
`);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Steer tough", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });
    const first = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "TOUGH working" }) });
    assert.equal(first.queued, false);
    await waitForTruthy(() => readJsonl(turnLog).some((t) => t.tough), "the tough turn is running, its grandchild holds stderr");
    const second = await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Pushed" }) });
    assert.equal(second.queued, true);

    const res = await fetch(`${base}/api/chats/${chat.id}/control`, { method: "POST" });
    const response = await res.json().catch(() => ({}));
    assert.equal(res.status, 409, `the old run was still in running after the wait — steered anyway: ${JSON.stringify(response)}`);
    assert.equal(response.reason, "running");

    fs.writeFileSync(grandchildFree, "1");
    const log = await waitForTruthy(async () => {
      const l = await json(`${base}/api/chats/${chat.id}/log`);
      return l.some((m) => m.role === "assistant" && m.text === "Answer after steering") ? l : null;
    }, "the queued message runs after the old run ends");
    assert.deepEqual(
      log.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.text]),
      [["user", "TOUGH working"], ["user", "Pushed"], ["assistant", "Answer after steering"]],
    );
    const pids = new Set(readJsonl(turnLog).map((t) => t.pid));
    assert.equal(pids.size, 2, "a process of its own for the message, after the old one");
    bodyOk = true;
  } finally {
    for (const t of [firstMay, grandchildFree]) { try { fs.writeFileSync(t, "1"); } catch { /* folder already gone */ } }
    if (base) await cleanUp(base, bodyOk);
    if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});
