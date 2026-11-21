// Consumption of the one-off calls.
//
// Before, EVERY connector returned only text from `runOnce` and the usage was lost everywhere: a retrieval summary or an
// outer-loop run would never have got a row in `usage_events`. Since then every connector reports the consumption through
// `opts.atConsumption({provider, model, input, output, cached})`; the return value stays text, without a callback nothing
// changes, and an error IN the callback does not topple the call. `input` is the full input side INCLUDING cached tokens
// (the same contract as the engine's `complete`), `cached` the cache-read share.
//
// Also `usage_events.source` (allow list '', 'retrieval', 'outer_loop') and `usage_events.agent_id`; the cache is carried
// SEPARATELY (`cache_read`/`cache_write`, `cached` stays the sum), `bookingCounts` passes the parts along, and the OpenRouter
// row appears in the usage groups (`usageGroups`).
//
// COUNTER-TESTS: connectors without the callback call => every "delivers the numbers" check red (the callback never comes);
// `runOnceCodex` without `--json` => the fake CLI writes no stream, Codex red; `addUsageEvent` without the columns => the store
// checks red. Further bindings: with `--json` a Codex error (limit!) appears ONLY as an event on stdout, and runOnceCodex used
// to reject with the stderr rest "Reading additional input from stdin..." and no limit was detected => "Codex CLI: an error in
// the --json stream" red; every retrieval booking was `subscription`, even on a preset (today OpenRouter) => "billing kind from
// the provider kind" red; the subscription row carried the engine contract (input 127, cached 100) instead of the tally form
// (7 / 120) => the same test red.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { runOnceClaude } from "../electron/server/providers/connectors/claude.js";
import { runOnceCodex } from "../electron/server/providers/connectors/codex.js";
import { makeOpenAiChatConnector } from "../electron/server/providers/connectors/openai-chat.js";
import { runOnce } from "../electron/server/providers/index.js";
import { replaceOpenRouter } from "./openrouter-spy.mjs";
import { bookingCounts } from "../electron/server/providers/connectors/consumption.js";
import { bookRetrieval } from "../electron/server/communication/retrieval.js";
import { detectLimitHit } from "../electron/server/limits.js";
import { isLimitError } from "../electron/server/runs/auto-continue.js";
import * as store from "../electron/server/store.js";
import * as dbModule from "../electron/server/store/db.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-oneshot-consumption-"));
store.initStore(DIR);
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { console.warn(`[test] cleanup: ${e.message}`); } });

// Fake CLIs: depending on the input form Claude answers with ONE json object or a stream-json stream including `usage` and
// `modelUsage`, like the real CLI. Codex writes its JSONL stream ONLY with `--json` (without it the real CLI prints human
// text) and the result into the file behind `-o`.
const CLAUDE_USAGE = { input_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 };
const claudeFake = path.join(DIR, "claude");
fs.writeFileSync(claudeFake, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const stream = argv.includes("--input-format");
const m = argv.indexOf("--model");
const model = m >= 0 ? argv[m + 1] : "claude-haiku-4-5";
let one = "";
process.stdin.on("data", (d) => { one += d; });
process.stdin.on("end", () => {
  const res = { type: "result", subtype: "success", is_error: false, result: one.includes("ERROR") ? "" : "ok",
    usage: ${JSON.stringify(CLAUDE_USAGE)}, modelUsage: { [model]: { inputTokens: 7 } } };
  if (one.includes("ERROR")) { res.is_error = true; res.subtype = "error_during_execution"; res.errors = ["broken"]; }
  if (stream) console.log(JSON.stringify({ type: "system", subtype: "init", tools: [] }));
  console.log(JSON.stringify(res));
});
`, { mode: 0o755 });
const codexFake = path.join(DIR, "codex");
fs.writeFileSync(codexFake, `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const o = argv.indexOf("-o");
// At the limit (prompt "LIMIT") like the real CLI with --json: the errors as events on stdout, only the stdin line on
// stderr, no file behind -o, exit 1.
if (argv.includes("--json") && argv[argv.length - 1].includes("LIMIT")) {
  process.stderr.write("Reading additional input from stdin...\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-limit" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again later." }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }));
  process.exit(1);
}
if (argv.includes("--json")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-consumption" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 9 } }));
} else console.log("[2026-10-04T10:00:00] codex\\nok");
if (o >= 0) fs.writeFileSync(argv[o + 1], "ok");
`, { mode: 0o755 });

function withBins(t) {
  const saved = { claude: process.env.CLAUDE_BIN, codex: process.env.CODEX_BIN };
  process.env.CLAUDE_BIN = claudeFake;
  process.env.CODEX_BIN = codexFake;
  t.after(() => {
    if (saved.claude === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = saved.codex;
  });
}

// A fake endpoint for the HTTP connectors: answers every POST with the body of the kind.
async function endpoint(t, body) {
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

const collator = () => { const list = []; const fn = (v) => { list.push(v); }; fn.list = list; return fn; };

test("Claude CLI: runOnce reports the consumption from the result event, json and stream-json form", async (t) => {
  withBins(t);
  const expected = { provider: "claude", model: "claude-haiku-4-5", input: 127, output: 5, cached: 100, cacheWrite: 20, billing: "" };
  const a = collator();
  assert.equal(await runOnceClaude("Say ok.", { cwd: DIR, model: "claude-haiku-4-5", provider: "claude", atConsumption: a }), "ok");
  assert.deepEqual(a.list, [expected]);
  // Material (image) forces the stream-json form, same consumption.
  const b = collator();
  const png = { mime: "image/png", dataB64: "iVBORw0KGgo=" };
  assert.equal(await runOnceClaude("Look.", { cwd: DIR, model: "claude-haiku-4-5", provider: "claude", images: [png], atConsumption: b }), "ok");
  assert.deepEqual(b.list, [expected]);
  // Without a model in the call: the model from `modelUsage` of the result.
  const c = collator();
  await runOnceClaude("Say ok.", { cwd: DIR, atConsumption: c });
  assert.deepEqual(c.list, [{ ...expected, model: "claude-haiku-4-5" }]);
  // A result marked as an error consumed tokens too: it is reported anyway, and thrown as before.
  const d = collator();
  await assert.rejects(runOnceClaude("ERROR", { cwd: DIR, model: "claude-haiku-4-5", atConsumption: d }), /broken/);
  assert.equal(d.list.length, 1);
});

test("Codex CLI: runOnce reads turn.completed (stream with --json); cached is a subset of input", async (t) => {
  withBins(t);
  const a = collator();
  assert.equal(await runOnceCodex("Say ok.", { cwd: DIR, model: "gpt-5.6-sol", provider: "codex", atConsumption: a }), "ok");
  assert.equal(a.list.length, 1);
  assert.deepEqual({ ...a.list[0], model: undefined }, { provider: "codex", model: undefined, input: 300, output: 9, cached: 200, cacheWrite: 0, billing: "" });
  assert.ok(a.list[0].model, "the model is there");
  // Without a callback: the same answer.
  assert.equal(await runOnceCodex("Say ok.", { cwd: DIR, model: "gpt-5.6-sol" }), "ok");
});

test("Codex CLI: an error in the --json stream (turn.failed at the limit) is at the front of the rejection, so limit detection applies", async (t) => {
  withBins(t);
  let error = null;
  await assert.rejects(runOnceCodex("LIMIT please", { cwd: DIR, model: "gpt-5.6-sol" }), (e) => { error = e; return true; });
  assert.match(error.message, /^You've hit your usage limit/, error.message);
  assert.equal(detectLimitHit({ stderr: error.message }).hit, true, error.message);
  assert.equal(isLimitError(error), true, "auto-continue parks instead of forking");
});

test("openai-chat: runOnce reports the usage of the response", async (t) => {
  // Only the openai-chat wire remains (OpenRouter runs over it).
  const oa = await endpoint(t, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } } });
  const cases = [
    [makeOpenAiChatConnector({ id: "fake-oa", baseUrl: oa, apiKey: "x", models: [{ id: "m1" }] }), { provider: "fake-oa", model: "m1", input: 50, output: 4, cached: 30, cacheWrite: 0, billing: "" }],
  ];
  for (const [k, expected] of cases) {
    const s = collator();
    assert.equal(await k.runOnce("Say ok.", { model: expected.model, atConsumption: s }), "ok", k.id);
    assert.deepEqual(s.list, [expected], k.id);
    // Without a callback nothing changes.
    assert.equal(await k.runOnce("Say ok.", { model: expected.model }), "ok", k.id);
    // A callback that throws (synchronously or as a promise) does not topple the call.
    assert.equal(await k.runOnce("Say ok.", { model: expected.model, atConsumption: () => { throw new Error("booking broken"); } }), "ok", k.id);
    assert.equal(await k.runOnce("Say ok.", { model: expected.model, atConsumption: async () => { throw new Error("booking broken"); } }), "ok", k.id);
  }
});

test("runOnce (registry) passes the callback on; a throwing callback does not topple the call", async (t) => {
  withBins(t);
  const s = collator();
  assert.equal(await runOnce("Say ok.", { model: "claude::claude-haiku-4-5", cwd: DIR, atConsumption: s }), "ok");
  assert.deepEqual(s.list, [{ provider: "claude", model: "claude-haiku-4-5", input: 127, output: 5, cached: 100, cacheWrite: 20, billing: "subscription" }]);
  assert.equal(await runOnce("Say ok.", { model: "claude::claude-haiku-4-5", cwd: DIR, atConsumption: () => { throw new Error("x"); } }), "ok");
  assert.equal(await runOnce("Say ok.", { model: "codex::gpt-5.6-sol", cwd: DIR, atConsumption: () => { throw new Error("x"); } }), "ok");
  assert.equal(await runOnce("Say ok.", { model: "claude::claude-haiku-4-5", cwd: DIR }), "ok");
});

test("Billing kind from the provider kind: a retrieval over OpenRouter is metered, on the CLI a subscription row in tally form", async (t) => {
  withBins(t);
  const oa = await endpoint(t, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } } });
  // The HTTP connector: the built-in OpenRouter, replaced here by a spy from the same factory. Its base is not openrouter.ai,
  // so it reports no amount and the row carries none.
  t.after(replaceOpenRouter({ baseUrl: oa, apiKey: "x", models: [{ id: "m1" }] }));
  const row = () => ({ ...dbModule.db.prepare("SELECT provider, billing, input, output, cached, cache_read AS read, cache_write AS write, chat_id AS chatId, source FROM usage_events ORDER BY id DESC LIMIT 1").get() });
  // OpenRouter (completion connector): metered, engine contract unchanged, and the row appears in the usage (fresh 50 - 30).
  assert.equal(await runOnce("Say ok.", { model: "openrouter::m1", atConsumption: (v) => bookRetrieval("reader-preset", v) }), "ok");
  assert.deepEqual(row(), { provider: "openrouter", billing: "metered", input: 50, output: 4, cached: 30, read: 30, write: 0, chatId: "reader-preset", source: "retrieval" });
  assert.ok(store.usageGroups("openrouter").some((r) => r.chatId === "reader-preset" && r.role === "retrieval" && r.input === 20 && r.cacheRead === 30),
    "appears in the usage (/api/usage/consumption?provider=openrouter)");
  // CLI with its own loop: subscription, in tally form: input only fresh (7), cached = read + write (100 + 20).
  assert.equal(await runOnce("Say ok.", { model: "claude::claude-haiku-4-5", cwd: DIR, atConsumption: (v) => bookRetrieval("reader-cli", v) }), "ok");
  assert.deepEqual(row(), { provider: "claude", billing: "subscription", input: 7, output: 5, cached: 120, read: 100, write: 20, chatId: "reader-cli", source: "retrieval" });
  // Codex oneshot: input 300 contains cached 200 => fresh 100, like the Codex chat (`input - cached`).
  assert.equal(await runOnce("Say ok.", { model: "codex::gpt-5.6-sol", cwd: DIR, atConsumption: (v) => bookRetrieval("reader-codex", v) }), "ok");
  assert.deepEqual(row(), { provider: "codex", billing: "subscription", input: 100, output: 9, cached: 200, read: 200, write: 0, chatId: "reader-codex", source: "retrieval" });
  // The conversion itself: without a kind (old report) like subscription; never negative.
  assert.deepEqual(bookingCounts({ input: 5, output: 1, cached: 9, cacheWrite: 0 }), { billing: "subscription", input: 0, output: 1, cached: 9, cacheRead: 9, cacheWrite: 0 });
  assert.deepEqual(bookingCounts({ billing: "metered", input: 5, output: 1, cached: 3, cacheWrite: 1 }), { billing: "metered", input: 5, output: 1, cacheRead: 3, cacheWrite: 1 });
});

const last = () => dbModule.db.prepare("SELECT source, agent_id AS agentId FROM usage_events ORDER BY id DESC LIMIT 1").get();

test("addUsageEvent writes source (allow list) and agent_id; unknown becomes ''", () => {
  store.addUsageEvent({ provider: "claude", model: "m", input: 1, output: 1, source: "retrieval", agentId: "agent-1" });
  assert.deepEqual({ ...last() }, { source: "retrieval", agentId: "agent-1" });
  store.addUsageEvent({ provider: "claude", source: "outer_loop", agentId: 42 });
  assert.deepEqual({ ...last() }, { source: "outer_loop", agentId: "42" });
  store.addUsageEvent({ provider: "claude", source: "invented" });
  assert.deepEqual({ ...last() }, { source: "", agentId: "" });
  store.addUsageEvent({ provider: "claude" });
  assert.deepEqual({ ...last() }, { source: "", agentId: "" });
});

test("usage_events of an existing DB gets source, agent_id, cost_usd and upstream_provider added (old rows: '' or NULL)", () => {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-usage-old-"));
  try {
    const d = new DatabaseSync(path.join(old, "automater.db"));
    d.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)`);
    d.prepare("INSERT INTO usage_events (provider, at) VALUES ('alt', 1)").run();
    d.close();
    store.initStore(old);
    const columns = new Set(dbModule.db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name));
    // Also the reported cost (`cost_usd`, NULL = not reported) and the provider behind the router (store/account.js).
    // A second initStore on the same DB is a no-op (PRAGMA reconcile).
    for (const s of ["source", "agent_id", "cost_usd", "upstream_provider"]) assert.ok(columns.has(s), s);
    assert.deepEqual({ ...dbModule.db.prepare("SELECT source, agent_id, cost_usd, upstream_provider FROM usage_events WHERE provider = 'alt'").get() },
      { source: "", agent_id: "", cost_usd: null, upstream_provider: "" });
    store.initStore(old);
    assert.equal(dbModule.db.prepare("PRAGMA table_info(usage_events)").all().filter((c) => c.name === "cost_usd").length, 1, "idempotent");
    // Only metered carries an amount; a subscription never, and nonsense becomes NULL, never 0.
    store.addUsageEvent({ provider: "new-m", input: 1, output: 1, billing: "metered", costUsd: 0.25, upstream: "Z.AI" });
    store.addUsageEvent({ provider: "new-s", input: 1, output: 1, billing: "subscription", costUsd: 0.25 });
    store.addUsageEvent({ provider: "new-x", input: 1, output: 1, billing: "metered", costUsd: "much" });
    assert.deepEqual(dbModule.db.prepare("SELECT provider, cost_usd AS k, upstream_provider AS u FROM usage_events WHERE provider LIKE 'new-%' ORDER BY id").all().map((r) => ({ ...r })),
      [{ provider: "new-m", k: 0.25, u: "Z.AI" }, { provider: "new-s", k: null, u: "" }, { provider: "new-x", k: null, u: "" }]);
  } finally {
    store.initStore(DIR);
    fs.rmSync(old, { recursive: true, force: true });
  }
});
