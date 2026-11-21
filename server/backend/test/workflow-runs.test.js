// Run history: every run stays as its own row (also a second one in the same chat), and the step log
// carries the debug material — prompt, duration, result, verdict with raw output, error. Checked
// against a fake CLI, offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { RIPCORD } from "./ripcord.mjs";
import { waitForQuiet } from "./quiet.mjs";

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for an EVENT, without a deadline: under load a deadline measures the machine. If it hangs, the
// suite deadline is the emergency brake; every 30 s a line on stderr says what is being waited for.
async function waitFor(fn, what = String(fn).replace(/\s+/g, " ").slice(0, 200)) {
  const t0 = Date.now();
  let reported = 0;
  for (;;) {
    const v = await fn();
    if (v) return v;
    const tick = Math.floor((Date.now() - t0) / 30_000);
    if (tick > reported) { reported = tick; process.stderr.write(`[waiting] for ${tick * 30} s: ${what}\n`); }
    await sleep(40);
  }
}
// After a failure: stop open runs instead of waiting for quiet. Never throws.
async function stopOpen(base) {
  try {
    for (const it of (await json(`${base}/api/active-runs`)).items || []) {
      if (it.chatId) await fetch(`${base}/api/chats/${it.chatId}/stop`, { method: "POST" }).catch(() => {});
    }
  } catch { /* server already closed */ }
}

// Fake CLI: answers with the start of the prompt; `oneshot` (without --input-format) answers the
// driver's verdict questions. FIXED to "no" — so the branching is unambiguous in the test.
const fakeClaude = (judge = '{"yes": false, "note": "Tests are red"}') => `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
const argv = process.argv.slice(2);
if (!argv.includes("--input-format")) {
  // Oneshot (runOnce): prompt arrives on stdin, the answer MUST be JSON with .result — and the
  // process must exit afterwards, otherwise runOnce waits for the close event.
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    const result = /condition/i.test(stdin) ? ${JSON.stringify(judge)} : "Title";
    process.stdout.write(JSON.stringify({ result }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    const c = msg.message && msg.message.content;
    const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join("") : "");
    const out = "ECHO " + text.replace(/\\s+/g, " ").slice(0, 200);
    say({ type: "assistant", message: { content: [{ type: "text", text: out }] } });
    say({ type: "result", result: out, session_id: "run-hist" });
  });
}
`;

async function withServer(fn, { judge } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-runhist-"));
  const bin = path.join(root, "fake-claude");
  const prevBin = process.env.CLAUDE_BIN;
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  const prevRestartGrace = process.env.CBASE_RESTART_GRACE_MS;
  let server, base = "", finished = false;
  try {
    // No restart: it is not the subject here.
    process.env.CBASE_RESTART_GRACE_MS = String(24 * 3_600_000);
    fs.writeFileSync(bin, judge ? fakeClaude(judge) : fakeClaude());
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "History", path: wsPath }) });
    await fn({ base, ws });
    finished = true;
  } finally {
    if (base && finished) await waitForQuiet(base);
    else if (base) await stopOpen(base);
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL; else process.env.CBASE_TRIGGER_POLL = prevPoll;
    if (prevRestartGrace === undefined) delete process.env.CBASE_RESTART_GRACE_MS; else process.env.CBASE_RESTART_GRACE_MS = prevRestartGrace;
    // A test must not fail because its temp directory cannot be removed: a child process still
    // writing causes ENOTEMPTY, which says something about cleanup, not about the product. It is
    // still reported — otherwise junk piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
}

// Workflow with instruction steps (placeholder in the text, so the prompt is recognizable).
async function makeFlow(base, ws, name, graph) {
  const flow = await json(`${base}/api/workspaces/${ws.id}/workflows`, { method: "POST", body: JSON.stringify({ name }) });
  // `doneAll: false`: "check all work steps" is on by default; these tests count steps and turns
  // without a closing gate.
  await json(`${base}/api/workspaces/${ws.id}/workflows/${flow.id}`, { method: "PUT", body: JSON.stringify({ graph, run: { doneAll: false } }) });
  return flow;
}
async function newChat(base, ws) {
  const chat = await json(`${base}/api/chats`, {
    method: "POST",
    body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
  });
  await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: `Test-${Math.random().toString(36).slice(2, 6)}` }) });
  return chat;
}
const linear = (steps) => ({
  nodes: [
    { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
    ...steps.map((t, i) => ({ id: `n${i}`, type: "instruction", title: `Step ${i + 1}`, text: t, x: 200 * (i + 1), y: 0 })),
  ],
  edges: [{ from: "s0", to: "n0" }, ...steps.slice(1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}` }))],
});

test("Two runs in the same chat BOTH appear in the history — with prompt, duration and result", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Two-Steps", linear(["Read file A", "Summarize"]));
    const chat = await newChat(base, ws);

    // First run
    const r1 = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "First attempt" }) });
    // Total runtime in the LIVE strip: while the run is open there is no end — the clients then
    // count against their own clock. Without startedAt they could show nothing at all.
    assert.ok(r1.run.startedAt > 0, "the run strip needs startedAt for the total runtime");
    assert.equal(r1.run.endedAt, 0, "a freshly started run has no end yet");
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${r1.run.id}`)).run.status === "done");
    await waitForQuiet(base);
    // Second run in the SAME chat
    const r2 = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id, input: "Second attempt" }) });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${r2.run.id}`)).run.status === "done");
    await waitForQuiet(base);

    const { runs } = await json(`${base}/api/workflow-runs?workspaceId=${ws.id}`);
    assert.equal(runs.length, 2, `History should have 2 runs, has ${runs.length}`);
    assert.notEqual(runs[0].id, runs[1].id);
    assert.deepEqual(runs.map((r) => r.status), ["done", "done"]);
    assert.ok(runs[0].startedAt >= runs[1].startedAt, "newest first");
    assert.ok(runs.every((r) => r.durationMs > 0), "duration missing");
    assert.ok(runs.every((r) => r.chatId === chat.id && !r.chatGone));
    // A finished run carries its end — that is where the total runtime stops counting.
    const finished = await json(`${base}/api/chats/${chat.id}/workflow`);
    assert.ok(finished.run.endedAt >= finished.run.startedAt, "a finished run needs endedAt");

    // Step timeline of the first run
    const detail = await json(`${base}/api/workflow-runs/${r1.run.id}`);
    assert.deepEqual(detail.steps.map((s) => s.kind), ["start", "step", "step", "end"]);
    assert.equal(detail.chat.id, chat.id);
    const [, first, second] = detail.steps;
    assert.match(first.detail.prompt, /Read file A/);
    assert.match(first.detail.prompt, /cbase workflow “Two-Steps”/);
    assert.match(first.detail.output, /^ECHO/);
    assert.equal(first.detail.ok, true);
    assert.ok(first.durationMs > 0, "step duration missing");
    assert.equal(first.step, 1);
    assert.equal(second.step, 2);
    assert.match(second.detail.prompt, /Summarize/);
    // The user's input stands at the start step.
    assert.match(detail.steps[0].detail.input, /First attempt/);
    assert.equal(detail.steps.at(-1).detail.status, "done");
  });
});

test("A failed condition verdict leaves the prompt AND the raw output of the model", async () => {
  // The fake CLI answers the verdict question with prose instead of JSON → the run must fail
  // visibly, and the raw output must stand in the log (it used to be swallowed).
  await withServer(async ({ base, ws }) => {
    const graph = {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "c1", type: "condition", title: "Are the tests green?", text: "The tests are green.", x: 200, y: 0 },
        { id: "n1", type: "instruction", title: "Yes path", text: "Merge", x: 400, y: -60 },
        { id: "n2", type: "instruction", title: "No path", text: "Repair", x: 400, y: 60 },
      ],
      edges: [{ from: "s0", to: "c1" }, { from: "c1", to: "n1", branch: "true" }, { from: "c1", to: "n2", branch: "false" }],
    };
    const flow = await makeFlow(base, ws, "With-Condition", graph);
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id }) });
    const done = await waitFor(async () => {
      const d = await json(`${base}/api/workflow-runs/${r.run.id}`);
      return ["failed", "done", "cancelled"].includes(d.run.status) ? d : null;
    });
    assert.equal(done.run.status, "failed");
    const decision = done.steps.find((s) => s.kind === "decision");
    assert.ok(decision, `No decision step: ${done.steps.map((s) => s.kind).join(",")}`);
    assert.equal(decision.detail.failed, true);
    assert.match(decision.detail.prompt, /The tests are green\./);
    assert.equal(decision.detail.tries.length, 2, "both attempts belong in the log");
    assert.match(decision.detail.tries.join(" "), /no idea/);
  }, { judge: "I have no idea, I cannot say that." });
});

test("A successful verdict logs yes/no with its reason", async () => {
  await withServer(async ({ base, ws }) => {
    const graph = {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "c1", type: "condition", title: "Green?", text: "The tests are green.", x: 200, y: 0 },
        { id: "n2", type: "instruction", title: "Repair", text: "Repair the tests", x: 400, y: 60 },
        { id: "e1", type: "end", title: "End", x: 600, y: 0 },
      ],
      edges: [
        { from: "s0", to: "c1" }, { from: "c1", to: "e1", branch: "true" },
        { from: "c1", to: "n2", branch: "false" }, { from: "n2", to: "e1" },
      ],
    };
    const flow = await makeFlow(base, ws, "Verdict-OK", graph);
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id }) });
    const done = await waitFor(async () => {
      const d = await json(`${base}/api/workflow-runs/${r.run.id}`);
      return d.run.status === "done" ? d : null;
    });
    const decision = done.steps.find((s) => s.kind === "decision");
    assert.equal(decision.detail.yes, false);
    assert.equal(decision.detail.note, "Tests are red");
    assert.ok(decision.durationMs >= 0);
    // The No branch was taken: exactly one instruction step.
    assert.deepEqual(done.steps.map((s) => s.kind), ["start", "decision", "step", "end"]);
    assert.match(done.steps.find((s) => s.kind === "step").detail.prompt, /Repair the tests/);
  });
});

test("The deleted chat does NOT take the history with it — it only remembers that the chat is gone", async () => {
  await withServer(async ({ base, ws }) => {
    const flow = await makeFlow(base, ws, "Single", linear(["Do something"]));
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id }) });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${r.run.id}`)).run.status === "done");
    await waitForQuiet(base);

    await json(`${base}/api/chats/${chat.id}`, { method: "DELETE" });
    const detail = await json(`${base}/api/workflow-runs/${r.run.id}`);
    assert.equal(detail.run.chatGone, true);
    assert.equal(detail.chat, null);
    assert.ok(detail.steps.length >= 3, "step log must remain");
    // And it is still in the list (with the hint about the missing chat).
    const { runs } = await json(`${base}/api/workflow-runs?workspaceId=${ws.id}`);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].chatGone, true);
  });
});

test("A finished run can be deleted, a running one cannot", async () => {
  await withServer(async ({ base, ws }) => {
    // Waiting run (question) → deleting must be refused.
    const graph = {
      nodes: [
        { id: "s0", type: "start", title: "Start", x: 0, y: 0 },
        { id: "a1", type: "ask", title: "Question", text: "Continue?", x: 200, y: 0 },
        { id: "e1", type: "end", title: "End", x: 400, y: 0 },
      ],
      edges: [{ from: "s0", to: "a1" }, { from: "a1", to: "e1" }],
    };
    const flow = await makeFlow(base, ws, "With-Question", graph);
    const chat = await newChat(base, ws);
    const r = await json(`${base}/api/chats/${chat.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: flow.id }) });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${r.run.id}`)).run.status === "waiting");
    await assert.rejects(() => json(`${base}/api/workflow-runs/${r.run.id}`, { method: "DELETE" }), /409/);
    // Cancel, then delete.
    await json(`${base}/api/chats/${chat.id}/workflow/cancel`, { method: "POST", body: "{}" });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${r.run.id}`)).run.status === "cancelled");
    assert.deepEqual(await json(`${base}/api/workflow-runs/${r.run.id}`, { method: "DELETE" }), { ok: true });
    await assert.rejects(() => json(`${base}/api/workflow-runs/${r.run.id}`), /404/);
    assert.equal((await json(`${base}/api/workflow-runs?workspaceId=${ws.id}`)).runs.length, 0);
  });
});

test("List filter: by workflow, chat and status", async () => {
  await withServer(async ({ base, ws }) => {
    const a = await makeFlow(base, ws, "Flow-A", linear(["A"]));
    const b = await makeFlow(base, ws, "Flow-B", linear(["B"]));
    const c1 = await newChat(base, ws);
    const c2 = await newChat(base, ws);
    const ra = await json(`${base}/api/chats/${c1.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: a.id }) });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${ra.run.id}`)).run.status === "done");
    await waitForQuiet(base);
    const rb = await json(`${base}/api/chats/${c2.id}/workflow`, { method: "POST", body: JSON.stringify({ workflowId: b.id }) });
    await waitFor(async () => (await json(`${base}/api/workflow-runs/${rb.run.id}`)).run.status === "done");
    await waitForQuiet(base);

    assert.equal((await json(`${base}/api/workflow-runs?workspaceId=${ws.id}`)).runs.length, 2);
    assert.deepEqual((await json(`${base}/api/workflow-runs?workflowId=${a.id}`)).runs.map((r) => r.name), ["Flow-A"]);
    assert.deepEqual((await json(`${base}/api/workflow-runs?chatId=${c2.id}`)).runs.map((r) => r.name), ["Flow-B"]);
    assert.equal((await json(`${base}/api/workflow-runs?workspaceId=${ws.id}&status=open`)).runs.length, 0);
    assert.equal((await json(`${base}/api/workflow-runs?workspaceId=${ws.id}&status=done`)).runs.length, 2);
  });
});
