// Guard: the four routes of the "Usage" page (`/api/usage/*`, contract account/usage-contract.js). Measured at the real
// server (in-process, agent-harness.mjs), the rows seeded via store.addUsageEvent:
//   1. The windows `session`/`week` come from the LAST snapshot (Claude `usage_cache_v1`, Codex rollout) — start =
//      resetsAt - window length; without a snapshot or with an expired reset they slide (`windowKnown: false`). And NEVER a
//      lookup: a spy on `execFile` (the keychain search `security` and `claude doctor` — the first steps of account/usage.js
//      fetchUsageLimits) and one on `fetch` (api.anthropic.com) must stay silent. A token in the environment
//      (CLAUDE_CODE_OAUTH_TOKEN) makes sure a lookup would reach the network even without a keychain.
//   2. Equivalent at the catalog price (providers/openrouter-catalog.js, test seam setCatalogSourceForTests) with split,
//      chats at most 25 with `chatsAdditional`, background in the order of the roles, subagent share; a model without a price
//      and unsplit cache make the equivalent incomplete (null or `equivalentComplete: false`, never 0).
//   3. The history is GAPLESS per calendar day in the client's time zone (`offsetMin`).
//   4. OpenRouter: costs with origin (reported · inquired · estimated · unknown — via the beat account/openrouter-inquiry.js
//      against the fake router), no equivalent; the credit live from `/credits` + `/key`, cached for 60 s.
//   5. 400 for a foreign provider, a window the provider does not know, and a history outside the bounds.
//   6. Field order = contract (every response, every row), and the column lists of store/account.js = contract.
//
// Counter-test: account/usage-report.js windowOf: the default `claudeState` additionally calls `fetchUsageLimits()` (the
// way of the old page, which fetched the ring live) => "(1) … never a lookup" red (the spy saw `security
// find-generic-password …`, the call to api.anthropic.com and after its 401 `fake-claude doctor`); (2)-(5) likewise, the
// spy list is file-wide.
//
// Order: (1) runs FIRST — account/usage.js keeps the read snapshot module-wide, and a server without `usage_cache_v1` would
// otherwise see that of an earlier test of the same file (in operation there is one process per data folder).
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import util from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Keep the real rollouts and sessions of this machine (~/.codex, ~/.claude) out of the game — BEFORE loading the server.
const SAVED_HOME = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  CBASE_OPENROUTER_OFFLINE: process.env.CBASE_OPENROUTER_OFFLINE };
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-usage-home-"));
process.env.HOME = HOME;
delete process.env.CODEX_HOME;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CODE_OAUTH_TOKEN = "cbase-test-token-never-in-network";
// No catalog from openrouter.ai: run alone (without the gate's switches) the server would fetch the REAL catalog at
// start, and a lookup still running when (2) set the test source came back as its result — the Codex equivalent would
// then use the real prices. So the file sets it itself, like the gate.
process.env.CBASE_OPENROUTER_OFFLINE = "1";
process.on("exit", () => {
  for (const [k, v] of Object.entries(SAVED_HOME)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
});

// ── The spies ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// execFile: `security` (keychain) and every `… doctor` are NOT executed, only noted (synchronously, at the moment of the
// call — fetchUsageLimits starts the keychain search before it waits for the first time). Everything else passes through.
const retrievals = [];
const realExecFile = cp.execFile;
function spyExecFile(file, args, ...rest) {
  const a = Array.isArray(args) ? args.map(String) : [];
  if (file === "security" || a.includes("doctor")) {
    retrievals.push(`execFile ${file} ${a.join(" ")}`);
    const cb = [args, ...rest].find((x) => typeof x === "function");
    if (cb) process.nextTick(cb, new Error("spy: no lookup"), "", "");
    return { pid: 0, kill() {}, on() { return this; }, once() { return this; } };
  }
  return realExecFile.call(this, file, args, ...rest);
}
spyExecFile[util.promisify.custom] = realExecFile[util.promisify.custom];
cp.execFile = spyExecFile;
syncBuiltinESMExports();
// fetch: every path to Anthropic is noted and answered with 401 (the next step would be `claude doctor` — the spy above
// would catch that too); everything else passes through (the test's own requests, the fake OpenRouter).
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url?.url ?? url);
  if (/anthropic\.com/i.test(u)) {
    retrievals.push(`fetch ${u}`);
    return new Response(JSON.stringify({ error: "spy" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

const store = await import("../electron/server/store.js");
const usage = await import("../electron/server/account/usage-report.js");
const { refreshCatalog, catalogModel, setCatalogSourceForTests } = await import("../electron/server/providers/openrouter-catalog.js");
const { catchUpAmounts } = await import("../electron/server/account/openrouter-inquiry.js");
const V = await import("../electron/server/account/usage-contract.js");
const { HARNESS_CREDIT, json, withAgentsServer } = await import("./agent-harness.mjs");

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const HAIKU = "claude-haiku-4-5-20251001";
const SOL = "gpt-5.6-sol";

const keys = (o) => Object.keys(o || {});
const near = (actual, desired, what) => assert.ok(typeof actual === "number" && Math.abs(actual - desired) < 1e-12, `${what}: ${actual} ≠ ${desired}`);

async function raw(base, filePath) {
  const r = await fetch(`${base}${filePath}`, { headers: { Connection: "close" } });
  return { status: r.status, body: await r.json() };
}
const consumption = (base, provider, window) => json(`${base}/api/usage/consumption?provider=${provider}&window=${window}`);

// A row as the booking paths write it (subscription: tally form, input fresh; cache split as soon as cacheRead is set).
const subscription = (provider, o) => store.addUsageEvent({ provider, model: provider === "codex" ? SOL : HAIKU, billing: "subscription", ...o });

// A Claude snapshot as fetchUsageLimits stores it (usage_cache_v1, both shapes — limits[] wins in claudeWindows).
function seedClaudeStatus({ reset5, reset7, at }) {
  const iso = (t) => new Date(t).toISOString();
  store.setSetting("usage_cache_v1", JSON.stringify({
    fiveHour: { utilization: 3, resetsAt: iso(reset5) }, sevenDay: { utilization: 41, resetsAt: iso(reset7) },
    limits: [
      { kind: "session", group: "session", percent: 3, resets_at: iso(reset5) },
      { kind: "weekly_all", group: "weekly", percent: 41, resets_at: iso(reset7) },
      { kind: "weekly_scoped", group: "weekly", percent: 77, resets_at: iso(reset7), scope: { model: { id: null, display_name: "Fable" }, surface: null } },
    ],
    at,
  }));
}

// A Codex rollout with rate_limits (the CLI's shape: seconds, window length in minutes) in this test's Codex home.
function seedCodexRollout({ resetP, resetS }) {
  const dir = path.join(HOME, ".codex", "sessions", "2026", "10", "15");
  fs.mkdirSync(dir, { recursive: true });
  const row = { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: null,
    rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: resetP }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: resetS }, plan_type: "pro" } } };
  fs.writeFileSync(path.join(dir, "rollout-2026-10-15T00-00-00-0000000a-0000-4000-8000-000000000001.jsonl"), `${JSON.stringify(row)}\n`);
}

function checkConsumptionForm(b) {
  assert.deepEqual(keys(b), [...V.CONSUMPTION_FIELDS], "Response");
  assert.deepEqual(keys(b.sums), [...V.SUMS_FIELDS], "sums");
  if (b.sums.partsUsd !== null) assert.deepEqual(keys(b.sums.partsUsd), [...V.PARTS_FIELDS], "partsUsd");
  if (b.sums.costOrigin !== null) assert.deepEqual(keys(b.sums.costOrigin), [...V.ORIGIN_TALLY_FIELDS], "costOrigin");
  for (const m of b.models) assert.deepEqual(keys(m), [...V.MODEL_FIELDS], "models[]");
  for (const c of b.chats) assert.deepEqual(keys(c), [...V.CHAT_FIELDS], "chats[]");
  for (const h of b.background) assert.deepEqual(keys(h), [...V.BACKGROUND_FIELDS], "background[]");
}

test("(1) windows from the last snapshot (Claude and Codex), sliding without it — and never a lookup", async () => {
  await withAgentsServer(async ({ base }) => {
    // a) No snapshot: both subscription windows slide over their length, `30d` always slides (and so is known).
    for (const provider of ["claude", "codex"]) {
      for (const [window, length, known] of [["session", 5 * H, false], ["week", 7 * DAY, false], ["30d", 30 * DAY, true]]) {
        const b = await consumption(base, provider, window);
        checkConsumptionForm(b);
        assert.equal(b.windowKnown, known, `${provider}/${window} without snapshot`);
        assert.equal(b.until - b.from, length, `${provider}/${window}: length`);
        assert.equal(b.sums.runs, 0);
        assert.equal(b.sums.equivalentUsd, 0, "nothing consumed is a statement (0, complete)");
        assert.equal(b.sums.equivalentComplete, true);
        assert.equal(b.sums.costUsd, null, "a subscription has no costs");
        assert.equal(b.subagentsShare, null, "no share without output");
      }
    }
    const empty = await json(`${base}/api/usage/claude-limits`);
    assert.deepEqual(empty, { measuredAt: null, window: [] });

    // b) A snapshot whose reset is past: the window is over — sliding, not known.
    const now = Date.now();
    seedClaudeStatus({ reset5: now - MIN, reset7: now - MIN, at: now - 6 * H });
    const old = await consumption(base, "claude", "session");
    assert.equal(old.windowKnown, false, "expired reset");
    assert.equal(old.until - old.from, 5 * H);

    // c) A valid snapshot: start = reset − length; rows before it do not count.
    const reset5 = Math.floor((now + 2 * H) / 1000) * 1000;
    const reset7 = Math.floor((now + 3 * DAY) / 1000) * 1000;
    const measured = now - 5 * MIN;
    seedClaudeStatus({ reset5, reset7, at: measured });
    subscription("claude", { input: 1, output: 10, at: reset5 - 5 * H + MIN });        // in the session
    subscription("claude", { input: 1, output: 20, at: reset5 - 5 * H - MIN });        // before it, in the week
    subscription("claude", { input: 1, output: 40, at: reset7 - 7 * DAY - MIN });      // before the week, in 30 days
    subscription("claude", { input: 1, output: 80, at: now - 31 * DAY });            // before everything
    const s = await consumption(base, "claude", "session");
    assert.equal(s.windowKnown, true);
    assert.equal(s.from, reset5 - 5 * H, "session starts at reset − 5 h");
    assert.deepEqual([s.sums.runs, s.sums.output], [1, 10]);
    const w = await consumption(base, "claude", "week");
    assert.equal(w.windowKnown, true);
    assert.equal(w.from, reset7 - 7 * DAY, "week starts at reset − 7 days");
    assert.deepEqual([w.sums.runs, w.sums.output], [2, 30]);
    const d = await consumption(base, "claude", "30d");
    assert.deepEqual([d.sums.runs, d.sums.output], [3, 70]);

    // All windows of the snapshot (not only the blocking one), with area and measuring time.
    const lim = await json(`${base}/api/usage/claude-limits`);
    assert.deepEqual(keys(lim), [...V.CLAUDE_LIMITS_FIELDS]);
    for (const f of lim.window) assert.deepEqual(keys(f), [...V.LIMIT_WINDOW_FIELDS]);
    assert.equal(lim.measuredAt, measured);
    assert.deepEqual(lim.window, [
      { id: "session", group: "session", area: "", percent: 3, resetsAt: reset5 },
      { id: "weekly_all", group: "weekly", area: "", percent: 41, resetsAt: reset7 },
      { id: "weekly_scoped", group: "weekly", area: "Fable", percent: 77, resetsAt: reset7 },
    ]);

    // d) Codex: the windows from the latest rollout, length from `window_minutes`.
    const resetP = Math.floor((now + H) / 1000);
    const resetS = Math.floor((now + 2 * DAY) / 1000);
    seedCodexRollout({ resetP, resetS });
    subscription("codex", { input: 1, output: 3, at: resetP * 1000 - 300 * MIN + MIN });
    subscription("codex", { input: 1, output: 5, at: resetP * 1000 - 300 * MIN - MIN });
    const cs = await consumption(base, "codex", "session");
    assert.equal(cs.windowKnown, true, JSON.stringify(cs));
    assert.equal(cs.from, resetP * 1000 - 300 * MIN, "primary: Reset − window_minutes");
    assert.deepEqual([cs.sums.runs, cs.sums.output], [1, 3]);
    const cw = await consumption(base, "codex", "week");
    assert.equal(cw.from, resetS * 1000 - 10080 * MIN, "secondary: Reset − window_minutes");
    assert.deepEqual([cw.sums.runs, cw.sums.output], [2, 8]);

    // e) Never a lookup: no keychain, no `claude doctor`, no network to Anthropic.
    assert.deepEqual(retrievals, [], "the usage report fetched instead of reading the snapshot");
  });
});

test("(2) equivalent at the catalog price with split, chats at most 25 with chatsAdditional, background, subagent share; incomplete without a price", async () => {
  await withAgentsServer(async ({ base, chat }) => {
    setCatalogSourceForTests(() => [
      { id: "anthropic/claude-haiku-4.5", name: "Haiku 4.5",
        pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001", input_cache_write: "0.00000125" } },
      { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", pricing: { prompt: "0.00000125", completion: "0.00001", input_cache_read: "0.000000125" } },
    ]);
    try {
      assert.equal(await refreshCatalog(), true, "catalog loaded");
      assert.ok(catalogModel("anthropic/claude-haiku-4.5"));
      // Prices per token: input 1e-6, output 5e-6, read 1e-7, write = 2 × input (1-h TTL of the CLI, account/equivalent.js).
      const gw = (i, o, l, s) => i * 1e-6 + o * 5e-6 + l * 1e-7 + s * 2e-6;
      subscription("claude", { chatId: chat.id, input: 100, output: 1000, cacheRead: 10_000, cacheWrite: 2000, cached: 12_000 });
      subscription("claude", { chatId: chat.id, kind: "sub", agentId: "a1", input: 50, output: 500 });
      for (let n = 1; n <= 26; n++) subscription("claude", { chatId: `deleted-${n}`, input: 0, output: n });
      subscription("claude", { chatId: chat.id, source: "retrieval", agentId: "channel_status", input: 5, output: 5 });
      subscription("claude", { chatId: chat.id, source: "once", agentId: "title", input: 10, output: 20 });

      const b = await consumption(base, "claude", "30d");
      checkConsumptionForm(b);
      const output = 1000 + 500 + (26 * 27) / 2 + 5 + 20;
      assert.deepEqual([b.sums.input, b.sums.output, b.sums.cacheRead, b.sums.cacheWrite, b.sums.cacheUnsplit, b.sums.runs],
        [165, output, 10_000, 2000, 0, 30]);
      near(b.sums.partsUsd.input, 165e-6, "part input");
      near(b.sums.partsUsd.output, output * 5e-6, "part output");
      near(b.sums.partsUsd.cacheRead, 10_000 * 1e-7, "part read");
      near(b.sums.partsUsd.cacheWrite, 2000 * 2e-6, "part write (2 × input)");
      near(b.sums.equivalentUsd, gw(165, output, 10_000, 2000), "equivalent");
      assert.equal(b.sums.equivalentComplete, true);
      assert.deepEqual([b.sums.costUsd, b.sums.costOrigin], [null, null], "a subscription has no costs");
      assert.deepEqual(b.models.map((m) => [m.model, m.priceKnown, m.runs]), [[HAIKU, true, 30]]);
      // Chats: the real one first (largest equivalent, main turn + subagent), then the deleted ones by equivalent; 27 chats => 25 + 2.
      assert.equal(b.chats.length, usage.CHATS_MAX);
      assert.equal(b.chatsAdditional, 2, "never truncate silently");
      assert.deepEqual([b.chats[0].chatId, b.chats[0].title, b.chats[0].deleted, b.chats[0].runs], [chat.id, "Agent-E2E", false, 2]);
      near(b.chats[0].equivalentUsd, gw(100, 1000, 10_000, 2000) + gw(50, 500, 0, 0), "equivalent of the chat");
      assert.deepEqual([b.chats[1].chatId, b.chats[1].title, b.chats[1].deleted], ["deleted-26", "", true]);
      assert.equal(b.chats.at(-1).chatId, "deleted-3");
      // Background in the order of the contract's roles (title before retrieval), NOT among the chats.
      assert.deepEqual(b.background.map((h) => [h.role, h.input, h.output, h.runs]), [["title", 10, 20, 1], ["retrieval", 5, 5, 1]]);
      near(b.background[0].equivalentUsd, gw(10, 20, 0, 0), "equivalent of the role title");
      near(b.subagentsShare, 500 / output, "subagent share of the output");

      // Codex: writing costs 0 (OpenAI does not charge it), reading at the read price.
      subscription("codex", { chatId: chat.id, input: 1000, output: 100, cacheRead: 4000, cacheWrite: 0, cached: 4000 });
      const c = await consumption(base, "codex", "30d");
      checkConsumptionForm(c);
      near(c.sums.equivalentUsd, 1000 * 1.25e-6 + 100 * 1e-5 + 4000 * 1.25e-7, "Codex equivalent");
      assert.equal(c.sums.partsUsd.cacheWrite, 0);
      assert.deepEqual(c.models.map((m) => [m.model, m.priceKnown]), [[SOL, true]]);

      // A model without a price and cache without split (rows from before the separation): incomplete — never as 0 or as read.
      subscription("claude", { model: "claude-unknown", chatId: chat.id, input: 7, output: 7 });
      subscription("claude", { chatId: chat.id, input: 0, output: 0, cached: 3000 });
      const u = await consumption(base, "claude", "30d");
      checkConsumptionForm(u);
      assert.equal(u.sums.cacheUnsplit, 3000);
      assert.equal(u.sums.equivalentComplete, false);
      near(u.sums.equivalentUsd, gw(165, output, 10_000, 2000), "the known part stays");
      const without = u.models.find((m) => m.model === "claude-unknown");
      assert.deepEqual([without.priceKnown, without.equivalentUsd], [false, null], "without a price: unknown, never 0");
      assert.equal(u.models.at(-1).model, "claude-unknown", "a row without an amount comes after every one with");
    } finally {
      setCatalogSourceForTests(null);
    }
    assert.deepEqual(retrievals, []);
  });
});

test("(3) history gapless per calendar day in the client's time zone (offsetMin), bounds 400", async () => {
  await withAgentsServer(async ({ base }) => {
    const now = Date.now();
    const o = 600; // +10 h
    const offset = o * MIN;
    const today = Math.floor((now + offset) / DAY);
    // 01:00 on the previous day at the client = 15:00 UTC two days before: bundled by UTC the row would lie one day too early.
    const previousDay = (today - 1) * DAY - offset + H;
    subscription("claude", { input: 2, output: 30, at: previousDay });
    subscription("claude", { input: 3, output: 40, at: now - MIN });
    subscription("claude", { input: 4, output: 50, at: now - 10 * DAY });
    const dayOf = (seq) => new Date(seq * DAY).toISOString().slice(0, 10);

    const v = await json(`${base}/api/usage/history?provider=claude&days=7&offsetMin=${o}`);
    assert.deepEqual(keys(v), [...V.HISTORY_FIELDS]);
    assert.deepEqual([v.provider, v.days, v.offsetMin], ["claude", 7, o]);
    for (const p of v.points) assert.deepEqual(keys(p), [...V.POINT_FIELDS]);
    assert.deepEqual(v.points.map((p) => p.day), Array.from({ length: 7 }, (_, i) => dayOf(today - 6 + i)), "gapless, oldest first, today last");
    assert.deepEqual(v.points.map((p) => p.output), [0, 0, 0, 0, 0, 30, 40], "the previous day at the client, not the UTC day");
    // A day without a row is 0 (nothing consumed); a day with rows without a catalog price is unknown (null), never 0.
    assert.deepEqual(v.points.map((p) => p.equivalentUsd), [0, 0, 0, 0, 0, null, null]);
    assert.ok(v.points.every((p) => p.costUsd === null), "a subscription has no costs");

    // The same row without offset: on its UTC day.
    const utc = await json(`${base}/api/usage/history?provider=claude&days=7&offsetMin=0`);
    const todayUtc = Math.floor(now / DAY);
    const atUtcDay = utc.points.find((p) => p.day === dayOf(Math.floor(previousDay / DAY)));
    assert.ok(atUtcDay && atUtcDay.output >= 30, JSON.stringify(utc.points));
    assert.equal(utc.points.at(-1).day, dayOf(todayUtc));
    // Without parameters: 30 days, UTC.
    const preset = await json(`${base}/api/usage/history?provider=claude`);
    assert.deepEqual([preset.days, preset.offsetMin, preset.points.length], [30, 0, 30]);
    assert.equal(preset.points.reduce((s, p) => s + p.output, 0), 120, "all three rows in 30 days");

    for (const q of ["days=0", "days=91", "days=1.5", "offsetMin=841", "offsetMin=-841", "offsetMin=abc"]) {
      const r = await raw(base, `/api/usage/history?provider=claude&${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(r.body.error, q);
    }
    const foreign = await raw(base, "/api/usage/history?provider=nebius");
    assert.equal(foreign.status, 400);
    assert.deepEqual(retrievals, []);
  });
});

test("(4) OpenRouter: costs with origin (reported · inquired · estimated · unknown), no equivalent; credit live and remembered for 60 s", async () => {
  await withAgentsServer(async ({ base, engine }) => {
    const now = Date.now();
    const or = (o) => store.addUsageEvent({ provider: "openrouter", model: "m1", billing: "metered", ...o });
    // metered: `input` FULL (cache included), `cached` = read + write.
    or({ input: 1000, output: 100, costUsd: 0.01, at: now - 10 * MIN });                                      // reported
    or({ input: 500, output: 50, generationId: "gen-a gen-b", at: now - 2 * H });                               // => inquired
    or({ input: 2000, output: 300, cacheRead: 500, cacheWrite: 0, cached: 500, at: now - 2 * H });         // => estimated
    or({ input: 1000, output: 0, generationId: "gen-old", at: now - 25 * H });                                  // => estimated (given up)
    or({ input: 10, output: 10, at: now - 10 * MIN });                                                          // too young: unknown
    or({ model: "unknown/model", input: 10, output: 10, at: now - 2 * H });                                  // without a price: unknown

    const r = await catchUpAmounts();
    assert.deepEqual([r.inquired, r.estimated, r.retrievals], [1, 2, 2], JSON.stringify(r));
    const asked = engine.query.filter((a) => a.includes("/generation"));
    assert.deepEqual(asked.sort(), ["/v1/generation?id=gen-a", "/v1/generation?id=gen-b"], "only the ids of the last 24 h");

    const b = await consumption(base, "openrouter", "30d");
    checkConsumptionForm(b);
    assert.deepEqual(b.sums.costOrigin, { reported: 1, inquired: 1, estimated: 2, unknown: 2 });
    // m1: input 1e-6, output 2e-6, read 1e-7 (HARNESS_CATALOG); the fake router reports 0.00042 $ per generation.
    const estimated = (1500 * 1e-6 + 300 * 2e-6 + 500 * 1e-7) + 1000 * 1e-6;
    near(b.sums.costUsd, 0.01 + 2 * 0.00042 + estimated, "costs");
    assert.deepEqual([b.sums.equivalentUsd, b.sums.partsUsd, b.sums.equivalentComplete], [null, null, false], "OpenRouter has no equivalent");
    assert.deepEqual(b.models.map((m) => [m.model, m.priceKnown, m.equivalentUsd]), [["m1", true, null], ["unknown/model", false, null]]);
    assert.equal(b.models[1].costUsd, null, "without an amount: unknown, never 0");
    assert.equal(b.subagentsShare, 0, "output, but no subagent");
    const total = await consumption(base, "openrouter", "total");
    assert.deepEqual([total.from, total.windowKnown, total.sums.runs], [null, true, 6]);
    // A second beat touches nothing any more (set amounts stay, the two unknown ones stay unknown).
    const r2 = await catchUpAmounts();
    assert.deepEqual([r2.inquired, r2.estimated], [0, 0]);

    // The credit: live from /credits and /key, then 60 s from the cache.
    usage.forgetCredit();
    const g = await json(`${base}/api/usage/openrouter-credit`);
    assert.deepEqual(keys(g), [...V.CREDIT_FIELDS]);
    assert.deepEqual([g.known, g.totalUsd, g.consumedUsd, g.restUsd, g.keyLimitUsd, g.keyRestUsd],
      [true, HARNESS_CREDIT.total, HARNESS_CREDIT.consumed, HARNESS_CREDIT.total - HARNESS_CREDIT.consumed, null, null]);
    const g2 = await json(`${base}/api/usage/openrouter-credit`);
    assert.equal(g2.at, g.at, "cached");
    assert.equal(engine.query.filter((a) => a.startsWith("/v1/credits")).length, 1, "asked once");
    // Without a key: unknown — all numbers null, never 0.
    await json(`${base}/api/openrouter`, { method: "DELETE" });
    const without = await json(`${base}/api/usage/openrouter-credit`);
    assert.deepEqual(without, { known: false, totalUsd: null, consumedUsd: null, restUsd: null, keyLimitUsd: null, keyRestUsd: null, at: null });
    assert.deepEqual(retrievals, []);
  }, { engine: true });
});

test("(5) 400 for a foreign provider and for a window the provider does not know", async () => {
  await withAgentsServer(async ({ base }) => {
    for (const [q, reason] of [
      ["provider=nebius&window=30d", "foreign provider"], ["provider=&window=30d", "no provider"],
      ["provider=claude&window=total", "subscription knows no \"total\""], ["provider=codex&window=day", "unknown window"],
      ["provider=openrouter&window=session", "OpenRouter knows no session"], ["provider=openrouter&window=week", "OpenRouter knows no week"],
      ["provider=claude", "no window"],
    ]) {
      const r = await raw(base, `/api/usage/consumption?${q}`);
      assert.equal(r.status, 400, reason);
      assert.ok(typeof r.body.error === "string" && r.body.error, reason);
    }
    // Every allowed pair answers 200.
    for (const a of V.PROVIDER) {
      for (const f of a === V.OPENROUTER_ID ? V.OPENROUTER_WINDOW : V.SUBSCRIPTION_WINDOW) {
        assert.equal((await raw(base, `/api/usage/consumption?provider=${a}&window=${f}`)).status, 200, `${a}/${f}`);
      }
    }
    assert.deepEqual(retrievals, []);
  });
});

test("(6) the column lists of store/account.js are in the contract (sources of the roles, origin of the amounts)", () => {
  const source = fs.readFileSync(path.join(HERE, "../electron/server/store/account.js"), "utf8");
  const set = (name) => {
    const t = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
    assert.ok(t, `${name} not found`);
    return [...t[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };
  assert.deepEqual(set("COST_ORIGIN_COLUMN").sort(), [...V.COST_ORIGIN].sort());
  // The sources of a row: '' (a run), 'once' (role in agent_id) and the two roles that are a source themselves.
  const sources = set("USAGE_SOURCES");
  assert.deepEqual(sources.sort(), ["", "once", "outer_loop", "retrieval"]);
  for (const q of sources.filter((x) => x && x !== "once")) assert.ok(V.ONCE_ROLES.includes(q), `source ${q} is not a role of the contract`);
});
