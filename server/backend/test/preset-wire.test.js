// The wire of the presets: do xhigh and max arrive?
//
// There is only ONE HTTP wire: openai-chat, over which the BUILT-IN OpenRouter runs (connectors/openrouter.js, models from the
// catalog providers/openrouter-catalog.js). The generic openai-chat with its clamp to low/medium/high (`GENERISCHE_LEVELS`) and
// the other wires (openai-responses, anthropic-msgs) are gone. Two promises remain:
//   - OpenRouter sends all five levels as such, xhigh and max too, and the catalog for /api/providers names them;
//   - a model entry with `efforts` takes precedence (preset-levels.js `explicitLevels`) - the clamp downwards says so in a
//     warning line; `efforts: []` means "carries no level" (empty is not unknown).
// Counter-tests (old mapping, clamp removed): shown red once per guard, then restored.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { makeOpenAiChatConnector } from "../electron/server/providers/connectors/openai-chat.js";
import { makeOpenRouterConnector } from "../electron/server/providers/connectors/openrouter.js";
import { catalogReady, setCatalogSourceForTests } from "../electron/server/providers/openrouter-catalog.js";
import { EFFORT_LEVELS } from "../electron/server/workflows.js";

// Capture the body of a complete() call without faking a response: fetch remembers the call
// and throws (same build as connector-wire.test.js - one .test.js never imports another).
async function bodyText(conn, args) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(init); throw new Error("intercepted - the body is available"); };
  try { await conn.complete({ messages: [{ role: "user", content: "hi" }], ...args }).catch(() => {}); }
  finally { globalThis.fetch = orig; }
  assert.equal(calls.length, 1, "complete() made no call");
  return JSON.parse(calls[0].body);
}
// Body AND console lines of a call - the clamp must say what it does and may otherwise stay silent.
async function withRows(conn, args) {
  const rows = [];
  const original = console.warn;
  console.warn = (...a) => rows.push(a.map(String).join(" "));
  try { return { body: await bodyText(conn, args), rows }; } finally { console.warn = original; }
}
// A connector of the wire with its own model entries (the same factory as the built-in OpenRouter, name "openrouter").
const conn = (models) => makeOpenAiChatConnector({
  id: "openrouter", label: "OpenRouter", wire: "openrouter", baseUrl: "https://example.test/v1", apiKey: "sk-test", models,
});
const OLD_ROW = /does not know this mapping|is not in the budget table/;

test("OpenRouter (built in, models from the catalog) sends xhigh and max as such - without a clamp line", async (t) => {
  // The catalog from the test source (the shape of the public API) - the real connector reads its models from there.
  setCatalogSourceForTests(() => [{ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", supported_parameters: ["tools", "reasoning"],
    context_length: 1_048_576, top_provider: { context_length: 1_048_576 } }]);
  t.after(() => setCatalogSourceForTests(null));
  await catalogReady();
  const or = makeOpenRouterConnector({ access: () => ({ apiKey: "sk-test", extraBody: {} }) });
  for (const level of ["xhigh", "max"]) {
    const { body, rows } = await withRows(or, { model: "z-ai/glm-5.3-flash", effort: level });
    assert.equal(body.reasoning_effort, level, `openrouter: ${level} must arrive as "${level}" (OpenRouter maps it itself)`);
    assert.deepEqual(rows, [], `openrouter: ${level} is supported - no line`);
  }
  // The levels below stay what they were.
  for (const level of ["low", "medium", "high"]) assert.equal((await bodyText(or, { model: "z-ai/glm-5.3-flash", effort: level })).reasoning_effort, level);
  // And the catalog that /api/providers passes on names all five - the picker shows what arrives.
  assert.deepEqual(or.models.map((m) => [m.id, m.efforts]), [["z-ai/glm-5.3-flash", [...EFFORT_LEVELS]]]);
  assert.deepEqual(or.efforts("z-ai/glm-5.3-flash"), [...EFFORT_LEVELS]);
});

test("Without an entry every model carries all five - the generic clamp to high is gone", async () => {
  // The GENERIC openai-chat used to clamp to low/medium/high without an entry (gpt-oss answered xhigh/max with 400). With the free
  // providers the reason is gone; a remainder of it (`GENERISCHE_GRADE`) would be an intermediate layer without a user.
  const source = fs.readFileSync(fileURLToPath(new URL("../electron/server/providers/connectors/openai-chat.js", import.meta.url)), "utf8");
  assert.ok(!/GENERISCHE_LEVELS|effortFull/.test(source), "the generic clamp is back in the wire");
  const or = conn([{ id: "openai/gpt-oss-120b", label: "gpt-oss" }]);
  for (const level of EFFORT_LEVELS) {
    const { body, rows } = await withRows(or, { model: "openai/gpt-oss-120b", effort: level });
    assert.equal(body.reasoning_effort, level);
    assert.deepEqual(rows, []);
  }
  assert.deepEqual(or.efforts(""), [...EFFORT_LEVELS], "without a model the default model counts");
});

test("A model entry with `efforts` takes precedence over the default - the clamp downwards says so", async () => {
  // gpt-oss-120b carries no xhigh/max (measured: HTTP 400) - an entry says so explicitly.
  const or = conn([{ id: "openai/gpt-oss-120b", label: "gpt-oss", efforts: ["low", "medium", "high"] }, { id: "z-ai/glm-5.3-flash", label: "GLM" }]);
  for (const level of ["xhigh", "max"]) {
    const { body, rows } = await withRows(or, { model: "openai/gpt-oss-120b", effort: level });
    assert.equal(body.reasoning_effort, "high", `${level} => high: the highest supported level that is not above the wish`);
    assert.equal(rows.length, 1, `the clamp for ${level} writes its line`);
    assert.match(rows[0], new RegExp(`\\[openrouter\\] Effort "${level}" clamped: openai/gpt-oss-120b supports low, medium, high on this wire`));
    assert.doesNotMatch(rows[0], OLD_ROW, "the old line \"does not know this mapping\" is gone");
  }
  assert.deepEqual(or.efforts("openai/gpt-oss-120b"), ["low", "medium", "high"]);
  assert.deepEqual(or.efforts("z-ai/glm-5.3-flash"), [...EFFORT_LEVELS], "the neighbour without an entry keeps the default");
  // The catalog for /api/providers carries the same levels as the clamp.
  assert.deepEqual(or.models.map((m) => m.efforts), [["low", "medium", "high"], [...EFFORT_LEVELS]]);
  // Empty is not unknown: `efforts: []` means "carries no level" - no field, one line.
  const without = conn([{ id: "plain", label: "without", efforts: [] }]);
  const empty = await withRows(without, { model: "plain", effort: "high" });
  assert.equal(empty.body.reasoning_effort, undefined, "a model without levels gets no reasoning_effort");
  assert.equal(empty.rows.length, 1);
  assert.match(empty.rows[0], /supports no effort level/);
  // Whatever is no level of the wire drops out of the entry (order of the ranking, not of the configuration).
  const crooked = conn([{ id: "x", label: "x", efforts: ["MAX", "ultra", "low"] }]);
  assert.deepEqual(crooked.efforts("x"), ["low", "max"]);
});
