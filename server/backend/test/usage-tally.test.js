// Token accounting. Two levels:
//   1. The counting logic against the quirks of the CLI event stream — the traps are there (one API call sends SEVERAL
//      assistant events, message_delta is CUMULATIVE).
//   2. The whole path end to end: a real run against a fake CLI that sends realistic usage counts including a subagent
//      must show up afterwards under /api/usage/consumption — with chat assignment and split by main/subagent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startServer } from "../electron/server/server.js";
import { createUsageTally } from "../electron/server/usage-tally.js";
import { tokenSum, tokenParts } from "../electron/server/providers/connectors/consumption.js";
import { RIPCORD } from "./ripcord.mjs";
import { LOCATION, json as harnessJson, withAgentsServer } from "./agent-harness.mjs";
import { waitForQuiet } from "./quiet.mjs";

const usage = (i, cr = 0, cc = 0, o = 0) => ({
  input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: o,
});

// ── 1. Counting logic ────────────────────────────────────────────────────────

test("an API call with several content blocks counts exactly once", () => {
  // The CLI sends one assistant event per block — all with the same message.id and usage. Naive adding would multiply
  // the input by the number of blocks.
  const t = createUsageTally();
  for (let i = 0; i < 3; i++) t.observe({ type: "assistant", message: { id: "m1", usage: usage(1000, 5000, 200, 300) } });
  assert.equal(t.main.input, 1000);
  assert.equal(t.main.cached, 5200);
  assert.equal(t.main.output, 300);
});

test("message_delta is cumulative — the last state counts, not the sum", () => {
  const t = createUsageTally();
  t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: usage(1000) } } });
  for (const o of [10, 50, 120, 400]) t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: o } } });
  assert.equal(t.main.output, 400, "580 would be the wrong, summed answer");
  assert.equal(t.main.input, 1000);
});

test("consecutive calls add up", () => {
  const t = createUsageTally();
  t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: usage(1000) } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 400 } } });
  t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m2", usage: usage(3000) } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 250 } } });
  assert.equal(t.main.input, 4000);
  assert.equal(t.main.output, 650);
});

test("partial messages AND assistant event for the same call do not count twice", () => {
  const t = createUsageTally();
  t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: usage(2000, 1000) } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 500 } } });
  t.observe({ type: "assistant", message: { id: "m1", usage: usage(2000, 1000, 0, 500) } });
  assert.deepEqual({ ...t.main }, { input: 2000, output: 500, cached: 1000, cacheRead: 1000, cacheWrite: 0 });
});

test("without a partial-message stream the assistant events count alone", () => {
  const t = createUsageTally();
  t.observe({ type: "assistant", message: { id: "m1", usage: usage(1000, 0, 0, 200) } });
  t.observe({ type: "assistant", message: { id: "m2", usage: usage(1500, 0, 0, 350) } });
  assert.equal(t.main.input, 2500);
  assert.equal(t.main.output, 550);
});

test("subagents run on their own account", () => {
  // The context display hides them via parent_tool_use_id — consumption must not.
  const t = createUsageTally();
  t.observe({ type: "assistant", message: { id: "m1", usage: usage(1000, 0, 0, 100) } });
  for (const p of ["tool_a", "tool_b"]) {
    t.observe({ type: "assistant", parent_tool_use_id: p, message: { id: `${p}_m1`, usage: usage(8000, 2000, 0, 900) } });
  }
  assert.deepEqual({ ...t.main }, { input: 1000, output: 100, cached: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual({ ...t.sub }, { input: 16000, output: 1800, cached: 4000, cacheRead: 4000, cacheWrite: 0 });
  assert.equal(t.totals().output, 1900);
});

test("interleaved streams do not displace each other", () => {
  const t = createUsageTally();
  t.observe({ type: "stream_event", event: { type: "message_start", message: { id: "main1", usage: usage(1000) } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 100 } } });
  t.observe({ type: "stream_event", parent_tool_use_id: "sub1", event: { type: "message_start", message: { id: "s1", usage: usage(5000) } } });
  t.observe({ type: "stream_event", parent_tool_use_id: "sub1", event: { type: "message_delta", usage: { output_tokens: 700 } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 260 } } });
  assert.equal(t.main.output, 260, "the subagent must not displace the open main-stream call");
  assert.equal(t.sub.output, 700);
  assert.equal(t.main.input, 1000);
  assert.equal(t.sub.input, 5000);
});

test("incomplete events do not disturb the counter", () => {
  const t = createUsageTally();
  for (const e of [null, undefined, {}, { type: "system" }, { type: "assistant" }, { type: "assistant", message: {} },
    { type: "stream_event" }, { type: "stream_event", event: { type: "message_delta" } },
    { type: "stream_event", event: { type: "message_start", message: {} } },
    { type: "assistant", message: { id: "x", usage: { input_tokens: "nonsense", output_tokens: null } } }]) {
    t.observe(e);
  }
  assert.deepEqual({ ...t.main }, { input: 0, output: 0, cached: 0, cacheRead: 0, cacheWrite: 0 });
  // A call without message.id cannot be deduplicated -> its input is not booked at all, better under-counted than
  // multiplied.
  t.observe({ type: "assistant", message: { usage: usage(500, 0, 0, 50) } });
  assert.equal(t.main.input, 0);
});

test("Codex: the turn (`consumption`) counts, the context pair of the last call does not", () => {
  // The shape connectors/codex.js sends at turn end. With only the unmarked pair, the output of the LAST call would be
  // counted (4 tokens, the empty answer after StructuredOutput) and the input not at all.
  const t = createUsageTally();
  t.observe({ type: "stream_event", event: { type: "message_start", onlyContext: true, message: { usage: usage(30_000, 120_000) } } });
  t.observe({ type: "stream_event", event: { type: "message_delta", onlyContext: true, usage: { output_tokens: 4 } } });
  t.observe({ type: "stream_event", event: { type: "consumption", usage: usage(44_101, 210_944, 0, 2_246) } });
  assert.deepEqual({ ...t.main }, { input: 44_101, output: 2_246, cached: 210_944, cacheRead: 210_944, cacheWrite: 0 });
  // A subagent turn lands in its own bucket.
  t.observe({ type: "stream_event", parent_tool_use_id: "toolu_x", event: { type: "consumption", usage: usage(10, 0, 0, 5) } });
  assert.equal(t.sub.input, 10);
  assert.equal(t.sub.output, 5);
  assert.equal(t.totals().output, 2_251);
});

test("cache read and cache write are separate, `cached` stays their sum", () => {
  const t = createUsageTally();
  t.observe({ type: "assistant", message: { id: "m1", usage: usage(10, 6_000, 19_288, 3_431) } });
  t.observe({ type: "assistant", message: { id: "m2", usage: usage(2, 25_000, 1_000, 100) } });
  assert.deepEqual({ ...t.main }, { input: 12, output: 3_531, cached: 51_288, cacheRead: 31_000, cacheWrite: 20_288 });
  assert.equal(t.totals().cacheWrite, 20_288);
});

test("parts and sum: everything except cache read, in both shapes", () => {
  // Tally shape (subscription): a Claude verifier that wrote 19,288 cache tokens while only 3,441 were shown.
  const subscription = tokenParts({ input: 10, output: 3_431, cached: 121_928, cacheRead: 102_640, cacheWrite: 19_288 }, "subscription");
  assert.deepEqual(subscription, { input: 10, cacheWrite: 19_288, cacheRead: 102_640, output: 3_431 });
  assert.equal(tokenSum(subscription), 22_729);
  // Engine contract (metered): `input` FULL, `cached` read — the read drops out of the sum.
  const metered = tokenParts({ input: 50_000, output: 700, cached: 40_000 }, "metered");
  assert.deepEqual(metered, { input: 10_000, cacheWrite: 0, cacheRead: 40_000, output: 700 });
  assert.equal(tokenSum(metered), 10_700);
  // An older state (only `cached`) and one that was counted on afterwards: what is assigned to no part counts as read.
  assert.deepEqual(tokenParts({ input: 5, output: 1, cached: 900 }), { input: 5, cacheWrite: 0, cacheRead: 900, output: 1 });
  assert.deepEqual(tokenParts({ input: 5, output: 1, cached: 1_050, cacheRead: 30, cacheWrite: 20 }),
    { input: 5, cacheWrite: 20, cacheRead: 1_030, output: 1 });
});

// ── 2. The whole path ────────────────────────────────────────────────────────

// Fake CLI that reproduces a turn with realistic consumption numbers: two API calls in the main stream (one with two
// content blocks so the dedup is checked) and a subagent that consumes a multiple.
const fakeClaude = `#!/usr/bin/env node
const readline = require("node:readline");
const say = (o) => console.log(JSON.stringify(o));
${RIPCORD}
const argv = process.argv.slice(2);
const u = (i, cr, o) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: 0, output_tokens: o });
if (!argv.includes("--input-format")) {
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ result: '{"yes": true, "note": "ok"}' }));
    clearTimeout(guard);
    process.exit(0);
  });
} else {
  process.stdin.on("end", () => process.exit(0));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "user") return;
    // Call 1: two content blocks, the same message.id -> may count only once.
    say({ type: "assistant", message: { id: "m1", usage: u(1000, 4000, 300), content: [{ type: "text", text: "Looking into it." }] } });
    say({ type: "assistant", message: { id: "m1", usage: u(1000, 4000, 300), content: [{ type: "tool_use", id: "tu1", name: "Agent", input: { description: "Subtask" } }] } });
    // Subagent: own bucket, deliberately costs a multiple here.
    say({ type: "assistant", parent_tool_use_id: "tu1", message: { id: "s1", usage: u(20000, 10000, 2500), content: [{ type: "text", text: "Partial result" }] } });
    // Call 2 in the main stream.
    say({ type: "assistant", message: { id: "m2", usage: u(2500, 6000, 700), content: [{ type: "text", text: "Done." }] } });
    say({ type: "result", result: "Done.", session_id: "usage-e2e" });
    clearTimeout(guard);
  });
}
`;

async function json(url, init) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, ...init });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for an event — WITHOUT a deadline (the emergency brake is the suite deadline); every 30 s a line goes to stderr
// with the condition.
async function waitFor(fn, what = "", every = 40) {
  const begin = Date.now();
  let reported = begin;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - reported >= 30_000) {
      reported = Date.now();
      console.error(`[waiting] for ${Math.round((reported - begin) / 1000)} s: ${what || String(fn).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    await sleep(every);
  }
}

// After the last checked answer the run still writes its consumption rows and removes itself from `active_runs` —
// do-run.js does that in a `setImmediate` AFTER the "afterExit" hooks, so demonstrably later than the point where the
// test is done. If the data directory is deleted before, SQLite reports "attempt to write a readonly database"; node:test
// attributes that late activity to the test that just ended and fails the whole FILE. So let it finish first
// (waitForQuiet, quiet.mjs — no deadline), then clean up.

test("a subscription run lands in the accounting with chat assignment and split by kind", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-usage-"));
  const bin = path.join(root, "fake-claude");
  const prevBin = process.env.CLAUDE_BIN;
  const prevPoll = process.env.CBASE_TRIGGER_POLL;
  let server, base = "";
  let finished = false;   // the body ran through without a throw (see finally)
  try {
    fs.writeFileSync(bin, fakeClaude);
    fs.chmodSync(bin, 0o755);
    process.env.CLAUDE_BIN = bin;
    process.env.CBASE_TRIGGER_POLL = "0";
    const wsPath = path.join(root, "workspace");
    fs.mkdirSync(wsPath);
    server = await startServer({ port: 0, dataRoot: path.join(root, "data-root"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    base = `http://127.0.0.1:${server.address().port}`;
    const ws = await json(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "Consumption", path: wsPath }) });
    const chat = await json(`${base}/api/chats`, {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id, provider: "claude", model: "claude-haiku-4-5-20251001", permissionMode: "bypassPermissions" }),
    });

    await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Do something" }) });
    // Via the usage report (/api/usage/consumption). Waits for BOTH rows of the chat (main and subagent, `runs`).
    const report = await waitFor(async () => {
      const r = await json(`${base}/api/usage/consumption?provider=claude&window=30d`);
      return r.chats.find((c) => c.chatId === chat.id && c.runs >= 2) ? r : null;
    }, "consumption rows of main and subagent");

    assert.ok(report, "the run left no consumption data");
    // Assignment to the chat — without it an expensive run cannot be traced back. Main stream: call 1 (once, despite two
    // blocks) + call 2; subagent: the one call, complete. The cache SEPARATE: all of it is read (the fake CLI writes none).
    const mine = report.chats.find((c) => c.chatId === chat.id);
    assert.deepEqual({ input: mine.input, output: mine.output, cacheRead: mine.cacheRead, cacheWrite: mine.cacheWrite, runs: mine.runs },
      { input: 1000 + 2500 + 20000, output: 300 + 700 + 2500, cacheRead: 4000 + 6000 + 10000, cacheWrite: 0, runs: 2 });
    // Main and subagent separate: the subagent carries 2,500 of the 3,500 output tokens (the title oneshot reports no consumption).
    assert.ok(Math.abs(report.subagentsShare - 2500 / 3500) < 1e-9, `subagent share: ${report.subagentsShare}`);
    assert.deepEqual(report.models.map((m) => m.model), ["claude-haiku-4-5-20251001"]);

    // Subscription consumption must not distort OpenRouter's costs.
    const cost = await json(`${base}/api/usage/consumption?provider=openrouter&window=30d`);
    assert.equal(cost.sums.runs, 0, "subscription runs do not belong in the cost calculation");
    assert.equal(cost.sums.costUsd, 0);
    finished = true;
  } finally {
    // Wait for quiet only if the body passed — after a failure a hanging run would otherwise have no deadline.
    if (base && finished) await waitForQuiet(base);
    if (server) await new Promise((r) => server.close(r));
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevPoll === undefined) delete process.env.CBASE_TRIGGER_POLL; else process.env.CBASE_TRIGGER_POLL = prevPoll;
    // A test must not fail because its temp directory does not go away: a child process still writing causes
    // ENOTEMPTY, which says something about cleanup, not about the product. It is still reported — otherwise
    // garbage piles up unnoticed in /tmp.
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
    catch (e) { console.warn(`Cleanup of ${root} failed (${e.code || e.message}) — test unaffected.`); }
  }
});

// A Codex MAIN CHAT over the whole path: connector -> do-run (output of the run, budget) -> counter -> usage_events. Like
// the real CLI the fake reports only `turn.completed` (cumulative over the thread — here a fresh thread, so the turn).
// Without a rollout the context is the same number; what is checked here is that NOTHING counts twice (context pair +
// `consumption`) and the input is booked. Counter-test (old state): subscription row input 0 (message_start without id),
// output 2,246 only accidentally right because context = turn — the separation of last call and turn is checked by
// codex-usage.test.js at the connector.
const fakeCodexTurn = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
try { fs.writeFileSync(path.join(${JSON.stringify(LOCATION)}, "pids", String(process.pid)), "codex"); } catch {}
const say = (o) => console.log(JSON.stringify(o));
say({ type: "thread.started", thread_id: "codex-consumption-mainchat" });
say({ type: "turn.started" });
say({ type: "item.completed", item: { id: "a", type: "agent_message", text: "Finished" } });
say({ type: "turn.completed", usage: { input_tokens: 255045, cached_input_tokens: 210944, output_tokens: 2246 } });
`;

test("Codex chat: the turn is booked and counted — once, with input", async () => {
  await withAgentsServer(async ({ base, ws, waitForQuiet: quiet }) => {
    const chat = await harnessJson(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: "codex", model: "gpt-5.6-sol", permissionMode: "bypassPermissions" }) });
    await harnessJson(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Go" }) });
    await quiet();
    const metas = (await harnessJson(`${base}/api/chats/${chat.id}/log`)).filter((m) => m.role === "meta").map((m) => JSON.parse(m.text));
    assert.equal(metas.at(-1)?.outTok, 2246, `output of the run: ${JSON.stringify(metas)}`);
    // Via the usage report: Codex writes no cache — everything cached is read.
    const usage = await harnessJson(`${base}/api/usage/consumption?provider=codex&window=30d`);
    const row = usage.chats.find((c) => c.chatId === chat.id);
    assert.ok(row, `subscription row missing: ${JSON.stringify(usage)}`);
    assert.deepEqual({ input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output, runs: row.runs },
      { input: 44101, cacheRead: 210944, cacheWrite: 0, output: 2246, runs: 1 });
  }, { codex: fakeCodexTurn });
});
