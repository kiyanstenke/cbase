// The model catalog of the built-in OpenRouter (providers/openrouter-catalog.js).
//
// The catalog loads itself (`GET <base>/models`, file `<data>/openrouter-catalog.json`, 6 h), and the context window is the median
// of the active endpoints, fetched at the first USE of a model (`catalogUse`). Rules:
//   - at odds (top_provider != context_length) => the median of the ACTIVE endpoints (status not negative; an even count => the
//     lower of the two middle ones), never above context_length; an alias ("~...") asks its target `alias_target.slug`;
//   - fetch fails or none active => min(top_provider, context_length), even BEFORE the first use (`context_length` is the maximum
//     over all providers);
//   - agreed or one of the two numbers missing => the available number, NO fetch.
// Also what carries the catalog itself: only models with tools are selectable, `vision` from the input modalities, prices USD per
// token ("0" is a price, anything unreadable is null: unknown, never 0), an error leaves the last state standing, an empty
// response is no catalog, an empty catalog is UNKNOWN (`catalogKnows` -> null), a state from another base does not count, and
// `CBASE_OPENROUTER_OFFLINE=1` blocks the network to the real base (the gate sets it, otherwise every test process would fetch the
// catalog).
//
// The fake endpoint is a local HTTP server with `/v1/models` and `/v1/models/<id>/endpoints`, attached through the test seam
// `CBASE_OPENROUTER_BASE`: the same path as in operation (`networkSource`, `fetchEndpoints`), not the test source. The tests wait
// for the promises of the fetches (`refreshCatalog`, `catalogUse`), never for a duration.
//
// COUNTER-TEST: in normalize() use the fallback number of the earlier state (`contextCatalog: top || max`, top_provider before
// everything else, even ABOVE context_length) => test 1 red ("top_provider above the maximum does not count": 256000 instead of
// 128000) and test 3 red at "before the first use" ("e/top-larger" 256000 instead of 128000).
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OPENROUTER_BASE } from "../electron/server/account/usage-contract.js";
import {
  refreshCatalog, catalogReady, catalogUse, catalogKnows, catalogList, catalogModel, normalize, openRouterBase,
  openRouterNetworkAllowed, setCatalogSourceForTests, startCatalog, stopCatalog,
} from "../electron/server/providers/openrouter-catalog.js";

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`cleanup of ${dir} failed (${e.code || e.message}); the test is unaffected.`); }
}
// Set environment variables for a test and restore them afterwards.
function withEnvironment(t, values) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("normalize: tools, images, prices (null is unknown, \"0\" a price), fallback number min(top_provider, context_length), alias", () => {
  const m = normalize({
    id: " z-ai/glm-5.3-flash ", name: "GLM 5.3 Flash", supported_parameters: ["tools", "reasoning"],
    architecture: { input_modalities: ["text", "image"] }, context_length: 1310720, top_provider: { context_length: 1048576 },
    pricing: { prompt: "0.0000001", completion: 0.0000004, input_cache_read: "", input_cache_write: "-1" },
  });
  assert.deepEqual(m, {
    id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", tools: true, vision: true, contextCatalog: 1048576, contextMax: 1310720,
    atOdds: true, alias: "", prices: { prompt: 0.0000001, completion: 0.0000004, cacheRead: null, cacheWrite: null },
  });
  const free = normalize({ id: "x/free:free", supported_parameters: ["temperature"], context_length: 8192, pricing: { prompt: "0", completion: "0" } });
  assert.equal(free.tools, false, "not selectable without \"tools\" in supported_parameters");
  assert.equal(free.vision, false);
  assert.equal(free.name, "x/free:free", "without a name the id");
  assert.deepEqual(free.prices, { prompt: 0, completion: 0, cacheRead: null, cacheWrite: null }, "\"0\" is a price, a missing one is unknown");
  // The fallback number: the smaller of the two, if one is missing the other; at odds only if both are present and different.
  const context = (x) => { const n = normalize({ id: "k", ...x }); return [n.contextCatalog, n.contextMax, n.atOdds]; };
  assert.deepEqual(context({ context_length: 128000, top_provider: { context_length: 256000 } }), [128000, 128000, true], "top_provider above the maximum does not count");
  assert.deepEqual(context({ context_length: 200000, top_provider: { context_length: 200000 } }), [200000, 200000, false]);
  assert.deepEqual(context({ context_length: 200000, top_provider: { context_length: null } }), [200000, 200000, false]);
  assert.deepEqual(context({ top_provider: { context_length: 64000 } }), [64000, 0, false]);
  assert.deepEqual(context({}), [0, 0, false]);
  assert.equal(normalize({ id: "~a/b-latest", alias_target: { slug: "a/b-2026" } }).alias, "a/b-2026");
  for (const broken of [null, "x", {}, { id: "" }, { id: "  " }, { id: 7 }]) assert.equal(normalize(broken), null);
});

// A fake OpenRouter: /v1/models returns `catalog` (or the status `modelStatus`), /v1/models/<id>/endpoints the list from
// `endpoints[id]` (null = 500, missing = 404). It counts every fetch.
async function fakeEndpoint(t) {
  const state = { catalog: [], modelStatus: 200, endpoints: {}, modelRetrievals: 0, endpointRetrievals: [] };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    if (u === "/v1/models") {
      state.modelRetrievals++;
      if (state.modelStatus !== 200) { res.writeHead(state.modelStatus); res.end("broken"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: state.catalog })); return;
    }
    const e = u.match(/^\/v1\/models\/(.+)\/endpoints$/);
    if (e) {
      state.endpointRetrievals.push({ id: e[1], auth: req.headers.authorization || "" });
      const list = state.endpoints[e[1]];
      if (list === null) { res.writeHead(500); res.end("broken"); return; }
      if (list) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: { id: e[1], endpoints: list } })); return; }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  return { state, base: `http://127.0.0.1:${server.address().port}/v1` };
}

const WITH_TOOL = (id, x = {}) => ({ id, name: id, supported_parameters: ["tools"], ...x });

test("The catalog through the test seam: only models with tools, file, an error and an empty response leave the last state standing, the start reads the file without a fetch, a state from another base does not count, empty is unknown", async (t) => {
  const { state, base } = await fakeEndpoint(t);
  withEnvironment(t, { CBASE_OPENROUTER_BASE: base, CBASE_OPENROUTER_OFFLINE: "1" });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-or-catalog-"));
  const file = path.join(root, "data", "openrouter-catalog.json");
  t.after(() => { stopCatalog(); setCatalogSourceForTests(null); cleanUp(root); });
  setCatalogSourceForTests(null);
  assert.equal(openRouterBase(), base);
  assert.equal(openRouterNetworkAllowed(), true, "an overridden base stays reachable, even with OFFLINE");

  state.catalog = [
    WITH_TOOL("a/including", { architecture: { input_modalities: ["text", "image"] }, context_length: 100000, pricing: { prompt: "0.000001", completion: "0.000002" } }),
    { id: "b/without", name: "Without", supported_parameters: ["temperature"], context_length: 8000 },
    WITH_TOOL("c/text", { context_length: 50000 }),
  ];
  startCatalog({ file });
  assert.equal(catalogKnows("a/including"), null, "before the first load attempt the catalog is empty: unknown, not \"does not exist\"");
  await catalogReady();
  assert.equal(state.modelRetrievals, 1);
  assert.deepEqual(catalogList().map((m) => [m.id, m.vision, m.context]), [["a/including", true, 100000], ["c/text", false, 50000]]);
  assert.deepEqual(catalogModel("a/including").prices, { prompt: 0.000001, completion: 0.000002, cacheRead: null, cacheWrite: null });
  assert.equal(catalogModel("b/without")?.tools, false, "a model without tools is in the catalog but not in the list");
  assert.equal(catalogKnows("a/including"), true);
  assert.equal(catalogKnows("b/without"), false);
  assert.equal(catalogKnows("exists/es-not"), false);
  assert.equal(catalogModel("exists/es-not"), null);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.base, base, "the file carries its base");
  assert.deepEqual(saved.models.map((m) => m.id), ["a/including", "b/without", "c/text"]);

  // An error (HTTP 500) and an EMPTY response change nothing: the last state still applies.
  state.modelStatus = 500;
  assert.equal(await refreshCatalog(), false);
  state.modelStatus = 200;
  state.catalog = [];
  assert.equal(await refreshCatalog(), false, "an empty list is no catalog");
  assert.deepEqual(catalogList().map((m) => m.id), ["a/including", "c/text"]);
  assert.equal(state.modelRetrievals, 3);

  // A new start reads the file IMMEDIATELY (before any fetch), and because it is younger than 6 h it does not fetch again.
  state.modelStatus = 500;
  startCatalog({ file });
  assert.deepEqual(catalogList().map((m) => m.id), ["a/including", "c/text"], "from the file, synchronously in the start");
  await catalogReady();
  assert.equal(state.modelRetrievals, 3, "a fresh file triggers no fetch");

  // Another base (test seam vs real): the stored state does not count, and without network the catalog stays EMPTY, i.e. unknown.
  process.env.CBASE_OPENROUTER_BASE = "";
  assert.equal(openRouterBase(), OPENROUTER_BASE);
  assert.equal(openRouterNetworkAllowed(), false, "OFFLINE blocks the real base");
  const realFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = async (...a) => { network++; return realFetch(...a); };
  try {
    startCatalog({ file });
    await catalogReady();
  } finally { globalThis.fetch = realFetch; }
  assert.equal(network, 0, "no fetch to the real base");
  assert.deepEqual(catalogList(), []);
  assert.equal(catalogKnows("a/including"), null, "empty means unknown");
  assert.equal(catalogModel("a/including"), null);
});

test("Context window: at odds => median of the active endpoints (never above context_length), fetch fails => min(top, max), agreed => no fetch; alias asks its target; the median survives the restart", async (t) => {
  const { state, base } = await fakeEndpoint(t);
  withEnvironment(t, { CBASE_OPENROUTER_BASE: base });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-or-context-"));
  const file = path.join(root, "data", "openrouter-catalog.json");
  t.after(() => { stopCatalog(); setCatalogSourceForTests(null); cleanUp(root); });
  setCatalogSourceForTests(null);
  const ep = (...values) => values.map((w) => (typeof w === "number" ? { context_length: w, status: 0 } : w));
  // id => [catalog entry, endpoints (null = 500, undefined = 404), expected BEFORE the first use, expected after]
  const CASES = {
    // the measured case z-ai/glm-5.3-flash (shortened): almost all 1048576, one 1310720, one disturbed
    "a/glm": [{ context_length: 1310720, top_provider: { context_length: 1048576 } }, ep(1048576, 1048576, 1048576, 262144, 1310720, { context_length: 262144, status: -2 }), 1048576, 1048576],
    // the measured shape of meta-llama/llama-4-maverick: top_provider 128000, the majority >= 524288
    "a/maverick": [{ context_length: 1048576, top_provider: { context_length: 128000 } }, ep(128000, 1048576, 1048576, 524288, 524288), 128000, 524288],
    // even count => the lower of the two middle ones (neither top_provider nor maximum)
    "b/currently": [{ context_length: 131072, top_provider: { context_length: 100000 } }, ep(131072, 40960), 100000, 40960],
    // a negative status does not count; without the filter the median would be 262144
    "c/status": [{ context_length: 1000000, top_provider: { context_length: 262144 } }, ep({ context_length: 262144, status: -2 }, { context_length: 262144, status: -1 }, 1000000, { context_length: 1000000 }), 262144, 1000000],
    // endpoint fetch fails (500) => min(top_provider, context_length) stays
    "d/retrieval-fails": [{ context_length: 1310720, top_provider: { context_length: 1048576 } }, null, 1048576, 1048576],
    // no active endpoint => likewise
    "d/none-active": [{ context_length: 262144, top_provider: { context_length: 202800 } }, ep({ context_length: 262144, status: -3 }), 202800, 202800],
    // median above context_length => context_length
    "e/median-over-max": [{ context_length: 128000, top_provider: { context_length: 64000 } }, ep(256000, 256000, 64000), 64000, 128000],
    // top_provider larger than context_length, endpoints missing (404) => context_length
    "e/top-larger": [{ context_length: 128000, top_provider: { context_length: 256000 } }, undefined, 128000, 128000],
    // agreed => context_length, NO fetch
    "f/agreed": [{ context_length: 200000, top_provider: { context_length: 200000 } }, ep(1000), 200000, 200000],
    // top_provider missing or null => context_length, no fetch
    "g/top-null": [{ context_length: 200000, top_provider: { context_length: null } }, ep(1000), 200000, 200000],
    // only top_provider => its number, no fetch
    "h/only-top": [{ top_provider: { context_length: 64000 } }, ep(1000), 64000, 64000],
    "h/nothing": [{ top_provider: {} }, ep(1000), 0, 0],
    // an alias like `~z-ai/glm-flash-latest`: its own endpoints are EMPTY (measured), the target is asked
    "~i/alias-latest": [{ context_length: 200000, top_provider: { context_length: 100000 }, alias_target: { name: "Target", slug: "i/target-2026" } }, [], 100000, 200000],
  };
  state.catalog = Object.entries(CASES).map(([id, [x]]) => WITH_TOOL(id, x));
  state.endpoints = { ...Object.fromEntries(Object.entries(CASES).map(([id, f]) => [id, f[1]])), "i/target-2026": ep(100000, 200000, 200000) };
  const contexts = () => Object.fromEntries(Object.keys(CASES).map((id) => [id, catalogModel(id)?.context]));

  startCatalog({ file });
  await catalogReady();
  assert.deepEqual(contexts(), Object.fromEntries(Object.entries(CASES).map(([id, f]) => [id, f[2]])), "before the first use");

  const results = await Promise.all(Object.keys(CASES).map((id) => catalogUse(id)));
  assert.deepEqual(contexts(), Object.fromEntries(Object.entries(CASES).map(([id, f]) => [id, f[3]])), "after the first use");
  const atOdds = ["a/glm", "a/maverick", "b/currently", "c/status", "d/retrieval-fails", "d/none-active", "e/median-over-max", "e/top-larger", "i/target-2026"];
  assert.deepEqual(state.endpointRetrievals.map((a) => a.id).sort(), [...atOdds].sort(), "exactly the ones at odds are fetched, the alias through its target");
  assert.ok(state.endpointRetrievals.every((a) => a.auth === ""), "the endpoints are public: the key does not go along");
  assert.equal(results.filter(Boolean).length, 6, "six medians stored (the three failures and the four agreed ones do not)");
  assert.equal(state.modelRetrievals, 1, "the alias target came from the catalog: no second catalog fetch");

  // Second use: the medians hold for 24 h, the failures are not repeated for 10 min: no fetch.
  state.endpointRetrievals.length = 0;
  await Promise.all(Object.keys(CASES).map((id) => catalogUse(id)));
  assert.deepEqual(state.endpointRetrievals, []);

  // The median is in the file: a new start uses it at once, without a fetch.
  state.modelStatus = 500;
  startCatalog({ file });
  assert.deepEqual(contexts(), Object.fromEntries(Object.entries(CASES).map(([id, f]) => [id, f[3]])), "after the restart from the file");
  assert.deepEqual(state.endpointRetrievals, []);
});
