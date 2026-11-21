// The real cost per request and the prices per provider at OpenRouter.
//
// ROUTE 1 — billing by report: OpenRouter sends `usage.cost` in every response (USD; when streaming, in the last chunk), with BYOK
// also `cost_details.upstream_inference_cost` (the inference at the own provider; `cost` is then only the fee). The chain:
// connector (`connectors/openai-chat.js`, ONLY for a base URL on openrouter.ai) -> engine (`tallyUsage`, all or nothing per run:
// `connectors/consumption.js:combinedCost`) -> booking of the run (`runs/do-run.js`) or of the subagent (`providers/agent-runtime.js`
// -> `runs/agents.js`) -> `usage_events.cost_usd` -> usage report `GET /api/usage/consumption?provider=openrouter`
// (account/usage-report.js). If an amount is missing, the amounts tick asks for it through the generation ids
// (account/openrouter-inquiry.js) or estimates at the catalog price.
// ROUTE 2 — prices in advance, display only: `GET /api/usage/openrouter-prices` from `GET <base>/models/<id>/endpoints` (`pricing`).
//
// No network: the provider points at https://openrouter.ai/api/v1 (else the connector would not read the cost at all), and the test
// redirects EVERY request there to a fake router on 127.0.0.1 (the server runs in the test's process — `fetch` is the same). A
// request to openrouter.ai outside /api/v1 throws. States are awaited, never a duration.
//
// OpenRouter is BUILT IN (id `openrouter`, base from the contract = https://openrouter.ai/api/v1, `reportsCost` always true): the
// main seams only set the key (PUT /api/openrouter). What the connector does for another base is held by the connector tests
// (same factory). The catalog stays empty in these tests (CBASE_OPENROUTER_OFFLINE=1 in the gate, otherwise the fake router answers
// `/models` with 404) — empty is unknown, every model runs.
//
// COUNTER-TESTS (which sabotage turns which test red):
//   (a) openai-chat.js without the line `if (reportsCost) { ... openRouterCost ... }` in handleChunk => "connector: streaming" red
//       (`usage.cost` missing) and the integration red at the main row (cost_usd null instead of 0.003);
//   (b) the same line without `reportsCost` (every endpoint) => "another gateway" red and the integration red at the gateway row;
//   (c) consumption.js `openRouterCost` without the BYOK branch (only `cost`) => "BYOK" red, integration red;
//   (d) `combinedCost` without `null` for tokens without an amount => "all or nothing" red, integration red at the half-reported run;
//   (e) runs/do-run.js without `costUsd: part.cost` => integration red at the main row; runs/agents.js without `costUsd` => red at the
//       subagent row; providers/agent-runtime.js without `combinedCost` => likewise;
//   (g) openrouter-endpoints.js reads "-1" as a number => "price span" red and the integration (span);
//   (h) providers/engine.js without `part.cost = combinedCost(part, u)` => integration red at the main row (null instead of 0.003);
//   (i) account/openrouter-inquiry.js `generationAmount` with its own old rule (`is_byok !== true` => `total_cost`) =>
//       "generationAmount" red (0.95 instead of null: the docs example without is_byok would be stored twenty times too small).
// Further: server/backend/test/oneshot-consumption.test.js (old DB: columns added, idempotent, only metered carries an amount) and
// golden-harness.mjs (the empty new columns are missing in the fixtures — counter-test there).
//
// Second round (lost rounds, continuations, restarts):
//   F1 agent-runtime.js settle returns `increase: {...rec.usage}` => "core (metered)", "core (subscription)", "main seam 2" (1) red;
//      runs/agents.js bookConsumption reads `info.usage` => "main seam 2" (1) red ("not the sum once more");
//   F2 drive() takes only the last attempt => "core (metered)" red; engine.js without `tallyAbort` in the catch => "engine: ... threw"
//      and "main seam 2" (3) red; completeWithRetry without the mark on the result => "engine: ... repeated attempt" red;
//      openai-chat.js without `costMissing` on a round without an amount or without the mark on the abort => "connector: streaming"
//      and "main seam 2" (2)/(3) red; consumption.js combinedCost without the missing check => "combinedCost", both engine tests,
//      "core (metered)" red;
//   F3 consumption.js without the branch for a missing `is_byok` => "openRouterCost" red;
//   F7 outerloop/run.js without `reported: u.cost` => "main seam 2" (4) red; communication/retrieval.js without `upstream` => (5) red;
//   F8 store/account.js `MIN(id)` instead of `MAX(id)` => "main seam" red (upstream); routes.js without the failure cache => "main seam 2"
//      (6) red; without the overall deadline (6) HANGS until the alarm (the held request is released only after the response) — the
//      deadline is the only way the response comes before the release.
// The performance of F8 (one pass instead of a subquery per group) is held by no test, only the result of the query.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { json, withAgentsServer } from "./agent-harness.mjs";
import { db } from "../electron/server/store/db.js";
import * as store from "../electron/server/store.js";
import { runChatViaEngine } from "../electron/server/providers/engine.js";
import { createAgentRuntime } from "../electron/server/providers/agent-runtime.js";
import { adjustableClock } from "../electron/server/providers/stall-watchdog.js";
import { FRAME_IDENTIFIER_LINE } from "../electron/server/outerloop/input.js";
import { startOuterLoopRun } from "../electron/server/outerloop/run.js";
import { summaryOnDemand } from "../electron/server/communication/retrieval.js";
import { makeOpenAiChatConnector } from "../electron/server/providers/connectors/openai-chat.js";
import { bookingCounts, combinedCost, openRouterCost, tokenIncrease, consumptionPlus } from "../electron/server/providers/connectors/consumption.js";
import { fetchEndpoints, isOpenRouterBase, priceSpan } from "../electron/server/providers/openrouter-endpoints.js";
import { estimatedCost, costFor } from "../electron/server/account/prices.js";
import { catchUpAmounts, generationAmount } from "../electron/server/account/openrouter-inquiry.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const MODEL = "z-ai/glm-4.6";
const near = (a, b, what) => assert.ok(typeof a === "number" && Math.abs(a - b) < 1e-9, `${what}: ${a} statt ${b}`);

// The measured shape of the endpoints (public API, z-ai/glm-4.6): `pricing.prompt`/`completion` in USD per token as a string. Plus
// a disturbed endpoint (does not count towards the span) and one with "-1" (unknown, like openrouter/auto in the catalog).
const ENDPOINTS = [
  { provider_name: "Venice", context_length: 198000, status: 0, pricing: { prompt: "0.00000043", completion: "0.00000175" } },
  { provider_name: "DeepInfra", context_length: 202752, status: 0, pricing: { prompt: "0.0000005", completion: "0.000002" } },
  { provider_name: "Novita", context_length: 204800, status: 0, pricing: { prompt: "0.00000055", completion: "0.0000022" } },
  { provider_name: "Z.AI", context_length: 202752, status: 0, pricing: { prompt: "0.0000006", completion: "0.0000022" } },
  { provider_name: "Disturbed", context_length: 202752, status: -5, pricing: { prompt: "0.0000001", completion: "0.0000001" } },
  { provider_name: "Router", context_length: 202752, status: 0, pricing: { prompt: "-1", completion: "-1" } },
];

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream" } });
const responseJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function withFetch(fn, body) {
  const orig = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = orig; }
}
// A round in the shape of OpenRouter: head with `provider`, text, finish, usage chunk without choices.
const round = (usage, { provider = "DeepInfra", text = "ok" } = {}) => [
  { id: "gen-1", provider, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
  { id: "gen-1", provider, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: "gen-1", provider, model: MODEL, choices: [], usage },
];

// ── Route 1: the rules ────────────────────────────────────────────────────────────────────────────────────────────────

test("openRouterCost: cost is the amount; BYOK = fee + upstream; what is missing or broken means unknown", () => {
  assert.equal(openRouterCost({ prompt_tokens: 10, completion_tokens: 2, cost: 0.0123 }), 0.0123);
  assert.equal(openRouterCost({ cost: 0 }), 0, "0 is a price (`:free`), not a missing value");
  assert.equal(openRouterCost({ cost: "0.5" }), 0.5, "a number as a string");
  // The docs example: cost 0.95 = 5 % of upstream_inference_cost 19 — both are paid.
  assert.equal(openRouterCost({ cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: 19 } }), 19.95);
  assert.equal(openRouterCost({ cost: 0.95, is_byok: true }), null, "BYOK without an upstream amount: the fee alone would be 20 times too small");
  assert.equal(openRouterCost({ cost: 0.95, is_byok: true, cost_details: { upstream_inference_cost: null } }), null);
  assert.equal(openRouterCost({ cost: 0.3, is_byok: false, cost_details: { upstream_inference_cost: 0.3 } }), 0.3, "explicitly no BYOK: never add (double)");
  // `is_byok` is optional (API reference), and the BYOK example of the docs does not have it: without the field and with an upstream
  // amount it cannot be decided whether `cost` is everything or only the fee => unknown.
  assert.equal(openRouterCost({ cost: 0.95, cost_details: { upstream_inference_cost: 19 } }), null, "the docs example without is_byok");
  assert.equal(openRouterCost({ cost: 0.95, is_byok: "yes", cost_details: { upstream_inference_cost: 19 } }), null, "a non-boolean is no statement");
  assert.equal(openRouterCost({ cost: 0.3, cost_details: { upstream_inference_cost: 0 } }), 0.3, "upstream 0: nothing to decide");
  assert.equal(openRouterCost({ cost: 0.3, cost_details: { upstream_inference_cost: null } }), 0.3, "upstream null (docs: \"0 or null\" without BYOK)");
  assert.equal(openRouterCost({ cost: 0.3 }), 0.3);
  for (const u of [{}, { cost: null }, { cost: -1 }, { cost: "" }, { cost: "abc" }, { cost: true }, null, undefined]) {
    assert.equal(openRouterCost(u), null, JSON.stringify(u));
  }
});

// The amounts tick asks `/generation` and reads `total_cost`/`upstream_inference_cost`/`is_byok` there — the same rule as in the
// stream, computed by the SAME function (an own copy once took `total_cost` without `is_byok`, even next to an upstream amount > 0 —
// with BYOK only the fee, stored as retrieved). Per case: generationAmount == openRouterCost.
test("generationAmount (inquiry): same BYOK rule as openRouterCost — without is_byok next to an upstream amount unknown", () => {
  const cases = [
    [{ total_cost: 0.0123 }, 0.0123],
    [{ total_cost: 0 }, 0],
    [{ total_cost: 0.95, is_byok: true, upstream_inference_cost: 19 }, 19.95],
    [{ total_cost: 0.95, is_byok: true }, null],
    [{ total_cost: 0.3, is_byok: false, upstream_inference_cost: 0.3 }, 0.3],
    [{ total_cost: 0.95, upstream_inference_cost: 19 }, null],
    [{ total_cost: 0.95, is_byok: "yes", upstream_inference_cost: 19 }, null],
    [{ total_cost: 0.3, upstream_inference_cost: 0 }, 0.3],
    [{ total_cost: 0.3, upstream_inference_cost: null }, 0.3],
    [{ total_cost: -1 }, null],
    [{}, null],
    [null, null],
  ];
  for (const [d, desired] of cases) {
    assert.equal(generationAmount(d), desired, JSON.stringify(d));
    const stream = d ? openRouterCost({ cost: d.total_cost, is_byok: d.is_byok, cost_details: { upstream_inference_cost: d.upstream_inference_cost } }) : openRouterCost(d);
    assert.equal(generationAmount(d), stream, `inquiry and stream equal: ${JSON.stringify(d)}`);
  }
});

test("isOpenRouterBase: openrouter.ai and its subdomains — no name that merely ends like it, no nonsense", () => {
  for (const u of ["https://openrouter.ai/api/v1", "https://OpenRouter.ai/api/v1/", "https://eu.openrouter.ai/api/v1", "http://openrouter.ai./api/v1"]) {
    assert.equal(isOpenRouterBase(u), true, u);
  }
  for (const u of ["https://notopenrouter.ai/api/v1", "https://openrouter.ai.evil.test/v1", "http://127.0.0.1:9/v1", "https://api.studio.nebius.ai/v1", "", "not a url", null]) {
    assert.equal(isOpenRouterBase(u), false, String(u));
  }
});

test("combinedCost: all or nothing — a round with tokens without an amount makes the sum unknown forever", () => {
  const sum = (rounds) => {
    const acc = { input: 0, output: 0, cost: null };
    for (const r of rounds) { acc.cost = combinedCost(acc, r); acc.input += r.input || 0; acc.output += r.output || 0; }
    return acc.cost;
  };
  near(sum([{ input: 10, output: 2, cost: 0.1 }, { input: 5, output: 1, cost: 0.2 }]), 0.3, "two reported rounds");
  near(sum([{ input: 10, output: 2, cost: 0.1 }, { input: 0, output: 0 }, { input: 5, output: 1, cost: 0.2 }]), 0.3, "a round without tokens does not count");
  assert.equal(sum([{ input: 10, output: 2, cost: 0.1 }, { input: 5, output: 1 }]), null, "half reported is not reported");
  assert.equal(sum([{ input: 5, output: 1 }, { input: 10, output: 2, cost: 0.1 }]), null, "even if the missing round is the first");
  assert.equal(sum([]), null, "nothing is not 0");
  assert.equal(sum([{ input: 0, output: 0 }]), null);
  // A round that broke off AFTER the response head or ended without a usage chunk carries `costMissing`: it cost, amount unknown —
  // even without tokens.
  assert.equal(sum([{ input: 10, output: 2, cost: 0.1 }, { input: 0, output: 0, costMissing: true }, { input: 5, output: 1, cost: 0.2 }]), null);
  assert.equal(sum([{ input: 0, output: 0, costMissing: true }]), null);
  // consumptionPlus: the mark sticks, even if its part has no tokens — a later reported round does not make the sum known again.
  const v = consumptionPlus(consumptionPlus(null, { input: 0, output: 0, costMissing: true }), { input: 5, output: 1, cached: 2, cost: 0.2, upstream: "Novita" });
  assert.deepEqual(v, { input: 5, output: 1, cached: 2, cost: null, upstream: "Novita", costMissing: true });
  const w = consumptionPlus(consumptionPlus(null, { input: 5, output: 1, cost: 0.2, upstream: "A" }), { input: 3, output: 1, cost: 0.1 });
  assert.deepEqual({ ...w, cost: Math.round(w.cost * 1e9) / 1e9 }, { input: 8, output: 2, cached: 0, cost: 0.3, upstream: "A" });
  assert.deepEqual(tokenIncrease({ input: 5, output: 2, cached: 1 }, { input: 9, output: 2, cached: 0 }), { input: 4, output: 0, cached: 0, cacheRead: 0, cacheWrite: 0 }, "never negative");
  // The booking numbers of a oneshot report: cost and generation id only in a metered row; the cache is separate.
  assert.deepEqual(bookingCounts({ billing: "metered", input: 5, output: 1, cached: 0, cost: 0.02, generationId: "gen-9" }),
    { billing: "metered", input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, generationId: "gen-9" });
  assert.deepEqual(bookingCounts({ billing: "subscription", input: 5, output: 1, cached: 0, cost: 0.02, generationId: "gen-9" }),
    { billing: "subscription", input: 5, output: 1, cached: 0, cacheRead: 0, cacheWrite: 0 });
});

test("connector: streaming at OpenRouter carries usage.cost from the last chunk, BYOK as a sum, without cost no field", async () => {
  const conn = makeOpenAiChatConnector({ id: "or-unit", baseUrl: OPENROUTER, apiKey: "sk", models: [{ id: MODEL }] });
  assert.equal(conn.reportsCost, true);
  const question = () => conn.complete({ messages: [{ role: "user", content: "hi" }], model: MODEL });
  const r = await withFetch(async () => sse(round({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200 }, cost: 0.0042 })), question);
  // Every OpenRouter response carries its generation id (`id` of the chunks) — the tick uses it to ask for a missing amount.
  assert.deepEqual(r.usage, { input: 1000, output: 50, cached: 200, cost: 0.0042, generationId: "gen-1" });
  assert.equal(r.provider, "DeepInfra");
  const byok = await withFetch(async () => sse(round({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.05, is_byok: true, cost_details: { upstream_inference_cost: 1 } })), question);
  assert.equal(byok.usage.cost, 1.05);
  const without = await withFetch(async () => sse(round({ prompt_tokens: 1000, completion_tokens: 50 })), question);
  assert.deepEqual(without.usage, { input: 1000, output: 50, cached: 0, costMissing: true, generationId: "gen-1" }, "no amount reported => no amount, but the mark and the id");
  // Without a usage chunk: 0 tokens, and the round still cost.
  const withoutChunk = await withFetch(async () => sse(round({}).slice(0, 2)), question);
  assert.deepEqual(withoutChunk.usage, { input: 0, output: 0, cached: 0, costMissing: true, generationId: "gen-1" });
  // The stream breaks AFTER the response head => the error carries the mark; an HTTP error before it does not (nothing accepted).
  // The head arrives (first call), then the stream breaks (second) — `error` in the same `start` would discard the queued head.
  const tears = () => { let n = 0; return new Response(new ReadableStream({
    pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(round({})[0])}\n\n`)); else c.error(new Error("terminated")); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }); };
  const f = await withFetch(async () => tears(), question).then(() => null, (e) => e);
  assert.ok(f instanceof Error && /terminated/.test(f.message), String(f));
  assert.equal(f.costMissing, true, "broken off after the head: it cost, amount unknown");
  assert.equal(f.generationId, "gen-1", "... and the id under which the tick asks for it");
  const h = await withFetch(async () => responseJson({ error: "broken" }, 500), question).then(() => null, (e) => e);
  assert.ok(h instanceof Error && /HTTP 500/.test(h.message), String(h));
  assert.equal(h.costMissing, undefined, "rejected before the head: no mark");
  // Another gateway: no mark — it never reports cost, without an amount is the normal case there (the tokens make it unknown).
  const gw = makeOpenAiChatConnector({ id: "gw-unit2", baseUrl: "https://gateway.example.test/v1", apiKey: "sk", models: [{ id: MODEL }] });
  const g = await withFetch(async () => sse(round({}).slice(0, 2)), () => gw.complete({ messages: [{ role: "user", content: "hi" }], model: MODEL }));
  assert.deepEqual(g.usage, { input: 0, output: 0, cached: 0 });
  const gf = await withFetch(async () => tears(), () => gw.complete({ messages: [{ role: "user", content: "hi" }], model: MODEL })).then(() => null, (e) => e);
  assert.equal(gf?.costMissing, undefined);
});

test("connector: another gateway that happens to send `cost` is not read — unit unknown", async () => {
  const conn = makeOpenAiChatConnector({ id: "gw-unit", baseUrl: "https://gateway.example.test/v1", apiKey: "sk", models: [{ id: MODEL }] });
  assert.equal(conn.reportsCost, false);
  const r = await withFetch(async () => sse(round({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.5 })),
    () => conn.complete({ messages: [{ role: "user", content: "hi" }], model: MODEL }));
  assert.equal(r.usage.cost, undefined);
  // The oneshot likewise — and at OpenRouter it reports amount and provider.
  const notStream = (usage) => async () => responseJson({ provider: "Novita", model: MODEL, choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
  const reported = [];
  await withFetch(notStream({ prompt_tokens: 9, completion_tokens: 1, cost: 0.5 }), () => conn.runOnce("x", { model: MODEL, atConsumption: (v) => reported.push(v) }));
  const or = makeOpenAiChatConnector({ id: "or-unit", baseUrl: OPENROUTER, apiKey: "sk", models: [{ id: MODEL }] });
  await withFetch(notStream({ prompt_tokens: 9, completion_tokens: 1, cost: 0.5 }), () => or.runOnce("x", { model: MODEL, atConsumption: (v) => reported.push(v) }));
  await withFetch(notStream({ prompt_tokens: 9, completion_tokens: 1 }), () => or.runOnce("x", { model: MODEL, atConsumption: (v) => reported.push(v) }));
  assert.deepEqual(reported.map((v) => [v.provider, v.cost, v.upstream]), [["gw-unit", undefined, "Novita"], ["or-unit", 0.5, "Novita"], ["or-unit", undefined, "Novita"]]);
});

test("origin and estimate (account/prices.js): reported comes first, else the catalog price; without price and in a subscription null", () => {
  // No price table and no currency: an amount is US dollars (OpenRouter reports dollars, the catalog names dollars).
  const prices = { prompt: 1e-6, completion: 2e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 };
  assert.equal(costFor({ model: "m", input: 1e6, output: 0, reported: 0.25, prices }), 0.25, "reported comes first");
  near(costFor({ model: "m", input: 1e6, output: 5e5, reported: null, prices }), 2, "estimated: $1 + $1");
  assert.equal(costFor({ model: "m", input: 1e6, output: 0, reported: 0.25, billing: "subscription", prices }), null, "a subscription has no cost per token");
  assert.equal(costFor({ model: "m", input: 1e6, output: 0, reported: null, prices: null }), null, "without a price unknown, never 0");
  assert.equal(costFor({ model: "m", input: 1e6, output: 0, reported: "broken", prices: null }), null);
  // The parts of a row (the amounts tick): fresh, output, cache read and write each at ITS price; if a cache price is missing, the
  // input price applies.
  near(estimatedCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, prices), 1 + 2 + 0.1 + 1.25, "all four parts");
  near(estimatedCost({ input: 0, output: 0, cacheRead: 1e6, cacheWrite: 1e6 }, { prompt: 1e-6, completion: 2e-6 }), 2, "without cache prices: input price");
  assert.equal(estimatedCost({ input: 1, output: 1 }, { prompt: 1e-6, completion: null }), null, "without an output price unknown");
});

// ── Route 2: prices per provider ──────────────────────────────────────────────────────────────────────────────────────

test("price span from the endpoints: per 1M, only active ones with a price, \"-1\" is unknown; per provider its price", async () => {
  const endpoints = await withFetch(async () => responseJson({ data: { id: MODEL, endpoints: ENDPOINTS } }),
    () => fetchEndpoints("https://or-price.test/api/v1", "", MODEL));
  assert.deepEqual(endpoints.find((e) => e.name === "Venice"), { name: "Venice", context: 198000, status: 0, priceIn: 0.43, priceOut: 1.75 });
  assert.deepEqual(endpoints.find((e) => e.name === "Router"), { name: "Router", context: 202752, status: 0, priceIn: null, priceOut: null });
  assert.deepEqual(priceSpan(endpoints), { inMin: 0.43, inMax: 0.6, outMin: 1.75, outMax: 2.2, endpoints: 4 }, "Disturbed and Router do not count");
  assert.deepEqual(priceSpan(endpoints, "deepinfra"), { inMin: 0.5, inMax: 0.5, outMin: 2, outMax: 2, endpoints: 1 }, "case does not matter");
  assert.deepEqual(priceSpan(endpoints, "Disturbed"), { inMin: 0.1, inMax: 0.1, outMin: 0.1, outMax: 0.1, endpoints: 1 }, "only disturbed ones => their price");
  assert.equal(priceSpan(endpoints, "Unbekannt"), null);
  assert.equal(priceSpan(endpoints, "Router"), null, "without a price unknown, not 0");
  assert.equal(priceSpan([]), null);
});

// ── The main seam: real server, real engine, real core ────────────────────────────────────────────────────────────────

const isSub = (b) => /subagent of cbase/i.test(JSON.stringify(b.messages?.[0]?.content ?? ""));

async function fakeRouter() {
  // Scripts per role: a round = { provider, text | toolCalls, usage }. An empty list answers "EMPTY" and is counted.
  // `ol`: an outer-loop run (recognized by the frame). Endpoints: a model with "missing" in its name answers 500 on the FIRST call,
  // then normally; one with "hangs" holds the response until the test calls `resolve()`. Flags of a round: `withoutUsage` (no usage
  // chunk), `abort` (head and one delta, then the connection breaks).
  const z = { main: [], sub: [], ol: [], empty: 0, endpointRetrievals: 0, endpointsPer: {}, hold: [] };
  const frame = JSON.stringify(FRAME_IDENTIFIER_LINE).slice(1, -1);
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const u = decodeURIComponent(req.url);
    const ep = req.method === "GET" ? u.match(/^\/v1\/models\/(.+)\/endpoints$/) : null;
    if (ep) {
      const id = ep[1];
      z.endpointRetrievals++;
      z.endpointsPer[id] = (z.endpointsPer[id] || 0) + 1;
      const respond = () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: { id, endpoints: ENDPOINTS } })); };
      if (id.includes("missing") && z.endpointsPer[id] === 1) { res.writeHead(500, { "Content-Type": "application/json" }); res.end("{}"); return; }
      if (id.includes("hangs")) { z.hold.push(respond); return; }
      respond();
      return;
    }
    // The inquiry of an amount (account/openrouter-inquiry.js): 0.0007 USD per generation, counted.
    if (req.method === "GET" && u.startsWith("/v1/generation?")) {
      z.generations = [...(z.generations || []), new URL(req.url, "http://router").searchParams.get("id")];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { total_cost: 0.0007, is_byok: false } }));
      return;
    }
    if (req.method === "GET" && u.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    if (req.method !== "POST" || !u.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    let b = {};
    try { b = JSON.parse(raw); } catch { /* empty */ }
    const role = JSON.stringify(b.messages ?? []).includes(frame) ? "ol" : isSub(b) ? "sub" : "main";
    const r = z[role].shift() || (z.empty++, (z.emptyLog = z.emptyLog || []).push({ role, stream: b.stream, last: JSON.stringify((b.messages || []).slice(-2)).slice(0, 600) }), { provider: "Empty", text: "EMPTY", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    if (b.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provider: r.provider, choices: [{ index: 0, message: { role: "assistant", content: r.text || "ok" }, finish_reason: "stop" }], usage: r.usage }));
      return;
    }
    const header = { id: `gen-${Math.random().toString(36).slice(2)}`, provider: r.provider, model: b.model, object: "chat.completion.chunk" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const row = (o) => res.write(`data: ${JSON.stringify({ ...header, ...o })}\n\n`);
    // Abort AFTER the head: head and a delta are at the client before the connection drops (write callback, then close).
    if (r.abort) {
      res.write(`data: ${JSON.stringify({ ...header, choices: [{ index: 0, delta: { role: "assistant", content: r.text }, finish_reason: null }] })}\n\n`, () => setImmediate(() => res.destroy()));
      return;
    }
    if (r.toolCalls) {
      row({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: r.toolCalls.map((t, i) => ({ index: i, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) } })) }, finish_reason: null }] });
    } else {
      row({ choices: [{ index: 0, delta: { role: "assistant", content: r.text }, finish_reason: null }] });
    }
    row({ choices: [{ index: 0, delta: {}, finish_reason: r.toolCalls ? "tool_calls" : "stop" }] });
    if (!r.withoutUsage) row({ choices: [], usage: r.usage });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}/v1`,
    z,
    resolve: () => { for (const f of z.hold.splice(0)) f(); },
    close: () => new Promise((r) => { for (const f of z.hold.splice(0)) f(); srv.closeAllConnections?.(); srv.close(() => r()); }),
  };
}

// Every request to https://openrouter.ai/api/v1 goes to the fake router; another path on openrouter.ai throws — no network.
function redirectToRouter(routerUrl) {
  const orig = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = typeof url === "string" ? url : (url instanceof URL ? url.href : url?.url);
    if (typeof u === "string" && /^https?:\/\/([^/]+\.)?openrouter\.ai/i.test(u)) {
      if (!u.startsWith(OPENROUTER)) return Promise.reject(new Error(`no network in the test: ${u}`));
      return orig(routerUrl + u.slice(OPENROUTER.length), init);
    }
    return orig(url, init);
  };
  return () => { globalThis.fetch = orig; };
}

// Only the RUNS of the chat (`source = ''`): every one-off call (title, goal ...) books on the chat too (`source = 'once'`).
const rows = (chatId) => db.prepare("SELECT kind, provider, model, input, output, cost_usd AS cost, upstream_provider AS upstream FROM usage_events WHERE chat_id = ? AND source = '' ORDER BY id").all(chatId).map((r) => ({ ...r }));
const usage = (pt, ct, extra = {}) => ({ prompt_tokens: pt, completion_tokens: ct, ...extra });

test("main seam: reported cost per run and subagent in usage_events, half reported => NULL until the inquiry; usage and prices", async () => {
  const router = await fakeRouter();
  const back = redirectToRouter(router.url);
  try {
    await withAgentsServer(async ({ base, ws, waitForTruthy, waitForIdle }) => {
      await json(`${base}/api/openrouter`, { method: "PUT", body: JSON.stringify({ apiKey: "sk-or-test", onlyWithoutSaving: false, noDataUsage: false }) });
      const chatWith = async (provider, title) => {
        const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider, model: MODEL, permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
        return c;
      };
      const turn = async (chat, text, expectedRows) => {
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
        await waitForIdle();
        return waitForTruthy(() => { const z = rows(chat.id); return z.length >= expectedRows ? z : null; }, `${expectedRows} Buchungen`);
      };
      const chat = await chatWith("openrouter", "Costs");

      // Turn 1: main run in two rounds (cbase_agent, then answer), a subagent at the same provider in between.
      router.z.main.push(
        { provider: "DeepInfra", toolCalls: [{ id: "call_task", name: "mcp__cbase__cbase_agent", arguments: { description: "Look into it", prompt: "Look into it and report.", run_in_background: false } }], usage: usage(1000, 20, { cost: 0.001 }) },
        { provider: "Z.AI", text: "finished", usage: usage(1200, 30, { cost: 0.002 }) },
      );
      router.z.sub.push({ provider: "Novita", text: "SUB-REPORT", usage: usage(300, 40, { cost: 0.0004 }) });
      let z = await turn(chat, "Please with subagent", 2);
      const main1 = z.find((r) => r.kind === "main");
      const sub1 = z.find((r) => r.kind === "sub");
      assert.deepEqual({ ...main1, cost: undefined }, { kind: "main", provider: "openrouter", model: MODEL, input: 2200, output: 50, cost: undefined, upstream: "Z.AI" });
      near(main1.cost, 0.003, "main run: the sum of both rounds");
      assert.equal(sub1.provider, "openrouter");
      near(sub1.cost, 0.0004, "Subagent: sein eigener Betrag, eigene Zeile");
      assert.equal(sub1.upstream, "Novita");

      // Turn 2: BYOK — fee + upstream.
      router.z.main.push({ provider: "Z.AI", text: "byok", usage: usage(1000, 100, { cost: 0.05, is_byok: true, cost_details: { upstream_inference_cost: 1 } }) });
      z = await turn(chat, "With own key", 3);
      near(z[2].cost, 1.05, "BYOK: both are paid");

      // Turn 3: half reported (the second round without `cost`) => the whole run without a report.
      router.z.main.push(
        { provider: "Z.AI", toolCalls: [{ id: "call_glob", name: "Glob", arguments: { pattern: "*.doesnotexist" } }], usage: usage(500, 10, { cost: 0.004 }) },
        { provider: "DeepInfra", text: "half", usage: usage(600, 20) },
      );
      z = await turn(chat, "Halb gemeldet", 4);
      assert.deepEqual(z[3], { kind: "main", provider: "openrouter", model: MODEL, input: 1100, output: 30, cost: null, upstream: "DeepInfra" });

      assert.equal(router.z.empty, 0, "every model request had its round in the script");

      // The usage: reported is the sum of the amounts, the half-reported run is UNKNOWN (never 0) — until the amounts tick asks for it
      // through its generation ids.
      const usageValue = () => json(`${base}/api/usage/consumption?provider=openrouter&window=30d`);
      const chatRow = (x) => x.chats.find((c) => c.chatId === chat.id);
      let n = await usageValue();
      near(chatRow(n).costUsd, 0.003 + 0.0004 + 1.05, "gemeldet: Haupt + Sub + BYOK");
      assert.deepEqual(n.sums.costOrigin, { reported: 3, inquired: 0, estimated: 0, unknown: 1 });
      const half = db.prepare("SELECT id, generation_id AS gen FROM usage_events WHERE chat_id = ? AND source = '' ORDER BY id").all(chat.id)[3];
      assert.equal(String(half.gen).split(" ").length, 2, `both responses of the half-reported run carry their id: ${half.gen}`);
      // The tick (without the offline lock — every request goes to the fake router): 0.0007 USD per id => `inquired`.
      const offline = process.env.CBASE_OPENROUTER_OFFLINE;
      delete process.env.CBASE_OPENROUTER_OFFLINE;
      let run;
      try { run = await catchUpAmounts(); } finally { if (offline !== undefined) process.env.CBASE_OPENROUTER_OFFLINE = offline; }
      assert.deepEqual({ inquired: run.inquired, retrievals: run.retrievals }, { inquired: 1, retrievals: 2 });
      assert.deepEqual([...router.z.generations].sort(), String(half.gen).split(" ").sort());
      n = await usageValue();
      assert.deepEqual(n.sums.costOrigin, { reported: 3, inquired: 1, estimated: 0, unknown: 0 });
      near(chatRow(n).costUsd, 1.0534 + 0.0014, "plus the inquired run");
      assert.equal((await catchUpAmounts()).retrievals, 0, "an amount that is set is never asked again");

      // Route 2: the prices per provider — only for the provider that reports cost; "last" = provider of the newest row.
      const prices = await json(`${base}/api/usage/openrouter-prices`);
      assert.deepEqual(prices.models.map((x) => [x.provider, x.model, x.known, x.upstream]), [["openrouter", MODEL, true, "DeepInfra"]]);
      assert.deepEqual(prices.models[0].span, { inMin: 0.43, inMax: 0.6, outMin: 1.75, outMax: 2.2, endpoints: 4 });
      assert.deepEqual(prices.models[0].last, { inMin: 0.5, inMax: 0.5, outMin: 2, outMax: 2, endpoints: 1 });
    });
  } finally {
    back();
    await router.close();
  }
});

// ── lost rounds, continuations, restarts ─────────────────────────────────────────────────────────────────────────────────

// The loop engine alone, with a connector whose rounds the test dictates (a round = return value of `complete` or an error).
function costConnector(rounds) {
  let n = 0;
  return {
    id: "or-engine", label: "or-engine", models: [{ id: "m1", label: "M1", context: 200_000 }],
    caps: { ownsAgentLoop: false, nativeToolCalling: true, streaming: false, subagents: false, vision: false },
    cleanEnv: () => ({}), resolveModel: (m) => m || "m1", runOnce: async () => "",
    complete: async () => {
      const r = rounds[Math.min(n++, rounds.length - 1)];
      if (r instanceof Error) throw r;
      return { text: "", thinking: "", toolCalls: [], stop: "end", ...r };
    },
  };
}
// A run of the engine up to its `result` (the holder only keeps the event loop open, as in engine-harness.test.js).
async function engineRun(conn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-or-engine-"));
  let handle;
  const holders = setInterval(() => {}, 1 << 30);
  try {
    return await runChatViaEngine(conn, {
      spec: { cwd: root, input: "los", systemPrompt: "", addDirs: [], permissionMode: "bypassPermissions", mcpServers: {}, model: "", effort: "", engine: {}, transcript: [] },
      onSpawn: (h) => { handle = h; },
      onEvent: (e) => { if (e.type === "result") handle.cbaseEndInput(); },
    });
  } finally {
    clearInterval(holders);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const afterHeader = (msg) => Object.assign(new Error(msg), { costMissing: true });
const glob = { toolCalls: [{ id: "c1", name: "Glob", input: { pattern: "*.doesnotexist" } }], stop: "tool_calls" };

test("engine: a round whose complete threw AFTER the response head makes the run's cost unknown — the tokens stay", async () => {
  const paid = { ...glob, usage: { input: 10, output: 2, cached: 0, cost: 0.01 } };
  const res = await engineRun(costConnector([paid, afterHeader("terminated")]));
  assert.deepEqual({ i: res.usage.input, o: res.usage.output, k: res.usage.cost, f: res.usage.costMissing }, { i: 10, o: 2, k: null, f: true });
  assert.deepEqual(res.usage.parts.map((p) => [p.kind, p.input, p.cost]), [["main", 10, null]], "also the part that do-run.js books");
  // Counterpart: an error BEFORE the head (no mark) — the one paid round is the whole amount.
  const beforeHeader = await engineRun(costConnector([paid, new Error("terminated")]));
  assert.equal(beforeHeader.usage.cost, 0.01);
});

test("engine: a repeated attempt that failed after the head passes its mark on to the result", async () => {
  const res = await engineRun(costConnector([afterHeader("HTTP 503 overloaded"), { text: "ok", usage: { input: 10, output: 2, cached: 0, cost: 0.01 } }]));
  assert.deepEqual({ i: res.usage.input, k: res.usage.cost, f: res.usage.costMissing }, { i: 10, k: null, f: true });
  const without = await engineRun(costConnector([new Error("HTTP 503 overloaded"), { text: "ok", usage: { input: 10, output: 2, cached: 0, cost: 0.01 } }]));
  assert.equal(without.usage.cost, 0.01, "rejected before the head: nothing paid");
});

// The core of a subagent (providers/agent-runtime.js) with a fake runChat: one move per process from `turns` — `usage` (ends at
// once) or `hangs` (until the signal, then `atAbort` as the consumption of the killed attempt, as the loop engine delivers it).
function costCore(turns, reports, { events = null } = {}) {
  const z = { processes: 0 };
  const rt = createAgentRuntime({
    chatId: "c-or-core", cwd: process.cwd(), parentProvider: "or",
    resolveRef: () => ({ connector: {}, providerId: "or", model: "m" }),
    buildSpec: (o) => ({ input: o.input }),
    runChat: ({ onEvent, onSpawn }) => new Promise((resolve) => {
      const turn = turns.shift();
      z.processes++;
      onSpawn({ kill: () => resolve({ code: 143, sessionId: "s", usage: turn.atAbort }) });
      onEvent({ type: "system", subtype: "init", session_id: "s" });
      for (const e of (events ? events(z.processes) : [])) onEvent(e);
      if (turn.hangs) return;
      onEvent({ type: "result", result: "ok" });
      resolve({ code: 0, sessionId: "s", resultText: "ok", ...(turn.usage ? { usage: turn.usage } : {}) });
    }),
    stallClock: adjustableClock({ real: false }),
    onFinish: (rec, info) => reports.push(info),
  });
  return { rt, z };
}
const nextTick = () => new Promise((r) => setImmediate(r));
const round6 = (x) => (typeof x === "number" ? Math.round(x * 1e9) / 1e9 : x);
const counts = (u) => ({ input: u.input, output: u.output, cost: round6(u.cost ?? null), ...(u.costMissing ? { missing: true } : {}) });

test("core (metered): a continuation books only its increase; a restart loses no attempt; a broken-off one makes ITS amount unknown", async () => {
  const turns = [];
  const reports = [];
  const { rt, z } = costCore(turns, reports);
  const until = async (n) => { while (reports.length < n) await nextTick(); };
  try {
    turns.push({ usage: { input: 300, output: 40, cached: 0, cost: 0.0004, upstream: "Novita" } });
    const a = await rt.start({ prompt: "Look into it", description: "Reviewer", run_in_background: true });
    await until(1);
    // Turn 2, continued: the first attempt hangs and is restarted — it had paid rounds behind it.
    turns.push({ hangs: true, atAbort: { input: 100, output: 5, cached: 0, cost: 0.0001, upstream: "Venice" } },
      { usage: { input: 200, output: 10, cached: 0, cost: 0.0002, upstream: "Z.AI" } });
    await rt.send({ agentId: a.agentId, message: "Something else" });
    while (z.processes < 2) await nextTick();
    assert.equal(rt.restart(a.agentId).ok, true);
    await until(2);
    // Turn 3: the killed attempt broke off in the middle of a round — tokens unknown, amount unknown.
    turns.push({ hangs: true, atAbort: { input: 0, output: 0, cached: 0, cost: null, costMissing: true } },
      { usage: { input: 50, output: 5, cached: 0, cost: 0.00005 } });
    await rt.send({ agentId: a.agentId, message: "And something more" });
    while (z.processes < 4) await nextTick();
    assert.equal(rt.restart(a.agentId).ok, true);
    await until(3);
    assert.deepEqual(reports.map((b) => counts(b.increase)), [
      { input: 300, output: 40, cost: 0.0004 },
      { input: 300, output: 15, cost: 0.0003 },
      { input: 50, output: 5, cost: null, missing: true },
    ], "per booking only what was added — both attempts of the restart");
    assert.equal(reports[1].increase.upstream, "Z.AI", "the provider of the last round");
    assert.deepEqual(counts(reports[2].usage), { input: 650, output: 60, cost: null, missing: true }, "the sum over all turns");
    assert.ok(reports.every((b) => b.billing === "metered"));
  } finally { rt.close(); }
});

test("core (subscription): a continuation books only the increase of the counter", async () => {
  const turns = [{}, {}];
  const reports = [];
  // One answer per process with consumption in the stream (the native CLI delivers no `usage` in the result — the stream is counted).
  const events = (n) => [{ type: "assistant", message: { id: `m${n}`, usage: { input_tokens: n === 1 ? 30 : 20, output_tokens: n === 1 ? 7 : 3 }, content: [{ type: "text", text: "ok" }] } }];
  const { rt } = costCore(turns, reports, { events });
  try {
    const a = await rt.start({ prompt: "Look into it", description: "Subscription", run_in_background: true });
    while (reports.length < 1) await nextTick();
    await rt.send({ agentId: a.agentId, message: "Weiter" });
    while (reports.length < 2) await nextTick();
    assert.deepEqual(reports.map((b) => [b.billing, b.increase.input, b.increase.output]), [["subscription", 30, 7], ["subscription", 20, 3]]);
    assert.deepEqual([reports[1].usage.input, reports[1].usage.output], [50, 10], "the sum stays the sum");
  } finally { rt.close(); }
});

// The agent of an outer-loop run on the test chat (as in outerloop-run.test.js): row "active" from 0.
function olAgent(ws, chat, fields) {
  const a = store.createOuterLoopAgent({ workspaceId: ws.id, name: "Reviewer", trigger: [{ kind: "quiet", minutes: 5 }], ...fields });
  store.setOuterLoopActive(a.id, chat.id, true, 0);
  return a;
}
const conversation = (chatId, n) => {
  // Times AFTER the chat was created: the summary on demand reads from the chat start.
  const now = Date.now();
  store.addMessage(chatId, "user", `Please rebuild the checkout (${n}).`, now + 2 * n);
  store.addMessage(chatId, "assistant", `The checkout is rebuilt (${n}).`, now + 2 * n + 1);
};

// The provider is the built-in OpenRouter; every main seam starts its own server with its own store.
const OR2 = "openrouter";

test("main seam 2: continuation books the increase, lost rounds make the amount unknown; outer loop, summary, price cap", async () => {
  const router = await fakeRouter();
  const back = redirectToRouter(router.url);
  const deadlinePrior = process.env.CBASE_OR_PRICES_DEADLINE_MS;
  try {
    await withAgentsServer(async ({ base, ws, waitForTruthy, waitForIdle }) => {
      await json(`${base}/api/openrouter`, { method: "PUT", body: JSON.stringify({ apiKey: "sk-or-test", onlyWithoutSaving: false, noDataUsage: false }) });
      const chatWith = async (title) => {
        const c = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: OR2, model: MODEL, permissionMode: "bypassPermissions" }) });
        await json(`${base}/api/chats/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
        return c;
      };
      const rowsKind = (chatId, kind) => rows(chatId).filter((r) => r.kind === kind);
      const chat = await chatWith("Fortsetzung");

      // (1) A subagent, then continued by the human: two rows whose sum is the sum of the two turns.
      router.z.main.push(
        { provider: "DeepInfra", toolCalls: [{ id: "call_task", name: "mcp__cbase__cbase_agent", arguments: { description: "Look into it", prompt: "Look into it and report.", run_in_background: false } }], usage: usage(1000, 20, { cost: 0.001 }) },
        { provider: "Z.AI", text: "finished", usage: usage(1200, 30, { cost: 0.002 }) },
      );
      router.z.sub.push({ provider: "Novita", text: "SUB-ONE", usage: usage(300, 40, { cost: 0.0004 }) });
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Please with subagent" }) });
      await waitForIdle();
      await waitForTruthy(() => rowsKind(chat.id, "sub").length === 1 && rowsKind(chat.id, "main").length === 1, "turn 1 booked");
      const [agent] = store.subagentsOf(chat.id);
      assert.ok(agent?.agentId, "the subagent is in the store");
      router.z.sub.push({ provider: "Venice", text: "SUB-TWO", usage: usage(200, 10, { cost: 0.0002 }) });
      router.z.main.push({ provider: "Z.AI", text: "noted", usage: usage(100, 5, { cost: 0.0001 }) }); // the turn of the completion report
      const sent = await json(`${base}/api/chats/${chat.id}/agent/send`, { method: "POST", body: JSON.stringify({ to: agent.agentId, message: "Something else", from: "human" }) });
      assert.ok(sent.ok, JSON.stringify(sent));
      await waitForTruthy(() => rowsKind(chat.id, "sub").length === 2 && rowsKind(chat.id, "main").length === 2, "continuation and completion report booked");
      await waitForIdle();
      const subs = rowsKind(chat.id, "sub");
      assert.deepEqual(subs.map((r) => [r.input, r.output, round6(r.cost), r.upstream]), [[300, 40, 0.0004, "Novita"], [200, 10, 0.0002, "Venice"]],
        "one row per turn with ITS consumption — not the sum once more");

      // (2) A round without a usage chunk: the run has a paid part without an amount => unknown.
      router.z.main.push({ provider: "Z.AI", ...{ toolCalls: [{ id: "call_g1", name: "Glob", arguments: { pattern: "*.doesnotexist" } }] }, usage: usage(500, 10, { cost: 0.003 }) },
        { provider: "DeepInfra", text: "without usage", withoutUsage: true, usage: usage(0, 0) });
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Without usage" }) });
      await waitForIdle();
      let z = await waitForTruthy(() => { const m = rowsKind(chat.id, "main"); return m.length >= 3 ? m : null; }, "turn without usage booked");
      assert.deepEqual([z[2].input, z[2].output, z[2].cost], [500, 10, null], "the reported round alone is not the amount of the run");

      // (3) The stream breaks after the head: the same — the run fails, it is booked anyway, without an amount. Afterwards do-run.js
      // tries the turn once without resume (`resume_failed_retrying`, existing behavior) — a run of its own, reported.
      router.z.main.push({ provider: "Z.AI", toolCalls: [{ id: "call_g2", name: "Glob", arguments: { pattern: "*.doesnotexist" } }], usage: usage(600, 12, { cost: 0.004 }) },
        { provider: "DeepInfra", text: "breaks off", abort: true, usage: usage(0, 0) },
        { provider: "DeepInfra", text: "neu versucht", usage: usage(50, 5, { cost: 0.0005 }) });
      await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text: "Abort" }) });
      await waitForIdle();
      z = await waitForTruthy(() => { const m = rowsKind(chat.id, "main"); return m.length >= 5 ? m : null; }, "broken-off turn and its retry booked");
      assert.deepEqual([z[3].input, z[3].output, z[3].cost], [600, 12, null], "the broken-off run: tokens known, amount not");
      assert.deepEqual([z[4].input, z[4].output, round6(z[4].cost)], [50, 5, 0.0005], "the retry: fully reported");
      assert.equal(router.z.empty, 0, `every model request had its round in the script: ${JSON.stringify(router.z.emptyLog)}`);
      assert.equal(router.z.main.length, 0);

      // (4) Outer loop: the reported cost goes into the run row (before any price); without a report and without a catalog price (the
      // catalog is empty in these tests): unknown.
      const observed = await chatWith("Observed");
      conversation(observed.id, 1);
      const ol = olAgent(ws, observed, { id: "e0000000-0000-4000-8000-0000000000c1", provider: OR2, model: MODEL });
      const olRun = async (round) => {
        router.z.ol.push(round);
        const r = await startOuterLoopRun({ agent: ol, chat: store.getChat(observed.id), trigger: "interval" });
        assert.equal(r.started, true, JSON.stringify(r));
        await waitForTruthy(() => ["finished", "error", "aborted"].includes(store.outerLoopRun(r.runId)?.state), "outer-loop run finished");
        return store.outerLoopRun(r.runId);
      };
      let l = await olRun({ provider: "Venice", text: "OR-Finding", usage: usage(400, 20, { cost: 0.0021 }) });
      assert.equal(l.state, "finished", JSON.stringify(l));
      assert.equal(l.cost, 0.0021, "reported");
      conversation(observed.id, 2);
      l = await olRun({ provider: "Venice", text: "OR-Finding without Amount", usage: usage(400, 20) });
      assert.equal(l.state, "finished", JSON.stringify(l));
      assert.equal(l.cost, null, "without a report and without a catalog price: unknown, never 0");

      // (5) Summary on demand through OpenRouter: amount and provider in the reader's booking.
      store.setSetting("agent_model_channel_status", JSON.stringify({ provider: OR2, model: MODEL }));
      router.z.main.push({ provider: "Novita", text: "Summary: the checkout.", usage: usage(150, 12, { cost: 0.0007 }) });
      const summarizer = await summaryOnDemand(store.getChat(chat.id), store.getChat(observed.id));
      assert.match(String(summarizer.summary || ""), /checkout/, JSON.stringify(summarizer));
      const retrieval = { ...db.prepare("SELECT chat_id AS chatId, billing, input, output, cost_usd AS cost, upstream_provider AS upstream, agent_id AS agentId FROM usage_events WHERE source = 'retrieval' ORDER BY id DESC LIMIT 1").get() };
      assert.deepEqual(retrieval, { chatId: chat.id, billing: "metered", input: 150, output: 12, cost: 0.0007, upstream: "Novita", agentId: "channel_status" });

      // (6) Prices per provider: a failure holds for 5 min (no new request), and the route does not wait longer than its deadline.
      store.addUsageEvent({ provider: OR2, model: "z-ai/glm-missing", input: 10, output: 1, billing: "metered" });
      let prices = await json(`${base}/api/usage/openrouter-prices`);
      const from = (p, model) => p.models.find((x) => x.model === model);
      assert.equal(from(prices, "z-ai/glm-missing").known, false);
      assert.equal(router.z.endpointsPer["z-ai/glm-missing"], 1);
      prices = await json(`${base}/api/usage/openrouter-prices`);
      assert.equal(from(prices, "z-ai/glm-missing").known, false, "the failure still holds");
      assert.equal(router.z.endpointsPer["z-ai/glm-missing"], 1, "without a new request");
      assert.equal(from(prices, MODEL).known, true);
      store.addUsageEvent({ provider: OR2, model: "z-ai/glm-hangs", input: 10, output: 1, billing: "metered" });
      process.env.CBASE_OR_PRICES_DEADLINE_MS = "1500";
      prices = await json(`${base}/api/usage/openrouter-prices`);
      assert.equal(router.z.hold.length, 1, "the response came while OpenRouter was still holding");
      assert.equal(from(prices, "z-ai/glm-hangs").known, false, "not in time => unknown");
      assert.equal(from(prices, MODEL).known, true, "the others are there anyway");
      router.resolve();
      await waitForTruthy(async () => from(await json(`${base}/api/usage/openrouter-prices`), "z-ai/glm-hangs")?.known === true, "the late request fills the cache"
);
      assert.equal(router.z.endpointsPer["z-ai/glm-hangs"], 1);
    });
  } finally {
    if (deadlinePrior === undefined) delete process.env.CBASE_OR_PRICES_DEADLINE_MS; else process.env.CBASE_OR_PRICES_DEADLINE_MS = deadlinePrior;
    back();
    await router.close();
  }
});
