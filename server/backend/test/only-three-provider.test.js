// Only three providers remain: Claude, Codex, OpenRouter.
//
// Before, `POST /api/provider-configs` created a third-party provider with a freely chosen id (presets openai-chat,
// openai-responses, anthropic-msgs, openrouter), `registerDbProviders` registered it at start, and every route that took a
// provider id thereby knew arbitrarily many. Since then:
//   - the registry knows exactly `PROVIDER` (contract account/usage-contract.js), and `registerConnector` THROWS for any other
//     id, even from a test (a test replaces one of the three and restores it, server/backend/test/openrouter-spy.mjs);
//   - no route creates a provider any more: `/api/presets`, `/api/provider-models`, `/api/provider-configs*` are gone;
//   - every route that takes a provider id rejects a foreign one with 400; before, chats silently fell back to the global
//     provider, and an agent definition "nebius::..." later ran silently with the chat's provider (resolveModelRef
//     `unknownProvider`);
//   - OpenRouter's access lives under `/api/openrouter` (contract `OPENROUTER_*`): GET only says WHETHER a key is set, PUT
//     requires both switches as booleans, an empty key is a 400, DELETE removes it, and the key never leaves the server, not
//     even through /api/providers.
//
// Runs at the main seam (agent-harness.mjs, real server, the built-in OpenRouter on the harness's fake endpoint).
// The fake Claude answers `claude auth status` (the route /api/providers asks it) and nothing else; nothing is run here.
//
// COUNTER-TESTS: in providers/index.js `registerConnector`, remove the check against `PROVIDER` (the line
// `if (!errs.length && !PROVIDER.includes(connector.id)) ...`) => test 1 red at "a fourth id throws" (Missing expected exception).
// Because the agent route exists twice: in projects/routes.js delete the POST check `if (foreignProviderIn(b.model)) ...` =>
// test 2 red ("POST /api/projects/.../agents with "nebius": 201 !== 400").
import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER, OPENROUTER_ACCESS_FIELDS } from "../electron/server/account/usage-contract.js";
import { PROVIDERS, getConnector, isProviderId, listConnectors, registerConnector } from "../electron/server/providers/index.js";
import { openRouterSpy } from "./openrouter-spy.mjs";
import * as store from "../electron/server/store.js";
import { withAgentsServer } from "./agent-harness.mjs";

test("The registry knows exactly the three providers of the contract; a fourth id throws, a replacement under one of the three does not", () => {
  assert.deepEqual(listConnectors().map((c) => c.id), [...PROVIDER], "in the order of the contract");
  assert.deepEqual(Object.keys(PROVIDERS), [...PROVIDER], "the view for /api/providers likewise");
  for (const id of PROVIDER) assert.equal(isProviderId(id), true);
  for (const id of ["nebius", "openai-chat", "anthropic-msgs", "openai-responses", "", "OpenRouter"]) assert.equal(isProviderId(id), false, `"${id}" is not a provider`);
  const real = getConnector("openrouter");
  try {
    assert.throws(() => registerConnector({ ...openRouterSpy(), id: "nebius" }), /only claude, codex, openrouter/, "a fourth id throws");
    assert.equal(isProviderId("nebius"), false, "... and is not in the registry afterwards");
    // Replacing one of the three works (this is how tests run without a server), and the original can be restored.
    const spy = openRouterSpy({ models: [{ id: "x" }] });
    registerConnector(spy);
    assert.equal(getConnector("openrouter"), spy);
    assert.deepEqual(listConnectors().map((c) => c.id), [...PROVIDER], "a replacement does not make a fourth");
  } finally { registerConnector(real); }
  assert.equal(getConnector("openrouter"), real);
});

// The fake Claude: answers `claude auth status --json` at once (the route /api/providers asks it), everything else ends empty.
const CLAUDE_ONLY_STATUS = `#!/usr/bin/env node
if (process.argv.includes("auth")) process.stdout.write(JSON.stringify({ loggedIn: false }));
process.exit(0);
`;

// A request that does not throw on 4xx (the harness's json() throws): { status, body }; `raw` is the response text (for the key search).
async function request(base, path, { method = "GET", body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", Connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: r.status, body: json, raw };
}

test("No route creates a provider, every route with a provider id rejects a foreign one with 400, /api/openrouter keeps its contract and never reveals the key", async () => {
  await withAgentsServer(async (ctx) => {
    const { base, ws, chat } = ctx;
    const r = (path, o) => request(base, path, o);
    const FOREIGN = "nebius";

    // ── The routes that created a provider or loaded its models are gone.
    for (const [method, path, body] of [
      ["GET", "/api/presets"],
      ["GET", "/api/provider-configs"],
      ["POST", "/api/provider-configs", { id: FOREIGN, label: "Nebius", preset: "openai-chat", baseUrl: "https://api.studio.nebius.ai/v1", apiKey: "sk-x" }],
      ["PATCH", `/api/provider-configs/${FOREIGN}`, { label: "x" }],
      ["DELETE", `/api/provider-configs/${FOREIGN}`],
      ["POST", "/api/provider-models", { baseUrl: "https://api.studio.nebius.ai/v1", apiKey: "sk-x" }],
    ]) {
      const a = await r(path, { method, body });
      assert.equal(a.status, 404, `${method} ${path} is gone (${a.status} ${a.raw.slice(0, 120)})`);
    }
    assert.equal(isProviderId(FOREIGN), false, "... and none of the attempts created a provider");

    // ── /api/providers: exactly the three; OpenRouter with the catalog list (only models with tools).
    const list = (await r("/api/providers")).body.providers;
    assert.deepEqual(list.map((p) => p.id), [...PROVIDER]);
    assert.deepEqual(list.find((p) => p.id === "openrouter").models.map((m) => m.id), ["m1", "m2"]);

    // ── Every route that takes a provider id: foreign => 400, and nothing changes.
    const rejected = async (method, path, body, pattern = null) => {
      const a = await r(path, { method, body });
      assert.equal(a.status, 400, `${method} ${path} with "${FOREIGN}": ${a.status} ${a.raw.slice(0, 160)}`);
      if (pattern) assert.match(String(a.body?.error || ""), pattern, `${method} ${path}: the rejection names the provider`);
    };
    await rejected("POST", "/api/chats", { workspaceId: ws.id, provider: FOREIGN, model: "x" });
    await rejected("PATCH", `/api/chats/${chat.id}`, { provider: FOREIGN });
    assert.equal(store.getChat(chat.id).provider, "claude", "the chat keeps its provider");
    await rejected("PUT", "/api/default-model", { provider: FOREIGN, model: "x" });
    await rejected("PUT", "/api/default-effort", { provider: FOREIGN, effort: "high" });
    await rejected("POST", "/api/provider", { provider: FOREIGN });
    await rejected("GET", `/api/account/${FOREIGN}`);
    await rejected("PUT", "/api/agent-models", { key: "title", provider: FOREIGN, model: "x" });
    assert.equal(store.getSetting("agent_model_title", ""), "", "the app agent stays on auto");
    // Agent definitions (cbase_agent): the reference "<foreign>::model" for POST and PUT.
    await rejected("POST", `/api/workspaces/${ws.id}/agents`, { name: "foreign-agent", model: `${FOREIGN}::meta-llama/x`, body: "x" }, /nebius/);
    const ag = await r(`/api/workspaces/${ws.id}/agents`, { method: "POST", body: { name: "own-agent", model: "openrouter::m1", body: "x" } });
    assert.equal(ag.status, 201, `a reference to one of the three works: ${ag.raw.slice(0, 160)}`);
    await rejected("PUT", `/api/workspaces/${ws.id}/agents/${ag.body.id}`, { model: `${FOREIGN}::meta-llama/x` }, /nebius/);
    assert.equal(store.getAgent(ag.body.id).model, "openrouter::m1");
    // The same two paths on a project agent (projects/routes.js: a second copy of the route, its own guard).
    const proj = await ctx.projectWithoutInstance({ name: "only-three", path: `${ctx.root}/only-three` });
    await rejected("POST", `/api/projects/${proj.id}/agents`, { name: "foreign-agent", model: `${FOREIGN}::meta-llama/x`, body: "x" }, /nebius/);
    const pag = await r(`/api/projects/${proj.id}/agents`, { method: "POST", body: { name: "own-agent", model: "codex::gpt-5.6-sol", body: "x" } });
    assert.equal(pag.status, 201, `project agent with one of the three: ${pag.raw.slice(0, 160)}`);
    await rejected("PUT", `/api/projects/${proj.id}/agents/${pag.body.id}`, { model: `${FOREIGN}::meta-llama/x` }, /nebius/);
    assert.equal(store.getAgent(pag.body.id).model, "codex::gpt-5.6-sol");
    // Graph workflow: run settings.
    const wf = await r(`/api/workspaces/${ws.id}/workflows`, { method: "POST", body: { name: "only-three" } });
    assert.equal(wf.status, 201);
    await rejected("PUT", `/api/workspaces/${ws.id}/workflows/${wf.body.id}`, { graph: wf.body.graph, run: { provider: FOREIGN } }, /nebius/);
    // Outer loop (a scheduled job carries no provider of its own, it runs in the chat).
    const ol = (await r(`/api/workspaces/${ws.id}/outer-loop`)).body.items;
    assert.ok(ol.length >= 1, "the seeded summarizer is there");
    await rejected("PATCH", `/api/workspaces/${ws.id}/outer-loop/${ol[0].id}`, { provider: FOREIGN }, /nebius/);

    // ── /api/openrouter: the contract. The harness set a key; remove it first.
    const without = await r("/api/openrouter", { method: "DELETE" });
    assert.equal(without.status, 200);
    assert.deepEqual(Object.keys(without.body).sort(), [...OPENROUTER_ACCESS_FIELDS].sort(), "exactly the fields of the contract");
    assert.equal(without.body.keySet, false);
    for (const [body, why] of [
      [{ apiKey: "sk-or-x" }, "both switches missing"],
      [{ apiKey: "sk-or-x", onlyWithoutSaving: true }, "one switch missing"],
      [{ apiKey: "sk-or-x", onlyWithoutSaving: "yes", noDataUsage: false }, "a switch is not a boolean"],
      [{ apiKey: "", onlyWithoutSaving: false, noDataUsage: false }, "an empty key"],
      [{ apiKey: "   ", onlyWithoutSaving: false, noDataUsage: false }, "a key of whitespace"],
      [{ apiKey: 42, onlyWithoutSaving: false, noDataUsage: false }, "a key that is not text"],
    ]) {
      const a = await r("/api/openrouter", { method: "PUT", body });
      assert.equal(a.status, 400, `PUT /api/openrouter: ${why}`);
    }
    assert.equal((await r("/api/openrouter")).body.keySet, false, "the rejected attempts set nothing");
    const SECRET = "sk-or-v1-secret-0815";
    const turnedOn = await r("/api/openrouter", { method: "PUT", body: { apiKey: SECRET, onlyWithoutSaving: true, noDataUsage: true } });
    assert.equal(turnedOn.status, 200);
    assert.deepEqual(turnedOn.body, { keySet: true, onlyWithoutSaving: true, noDataUsage: true });
    assert.deepEqual(store.openRouterAccess().extraBody.provider, { zdr: true, data_collection: "deny" }, "the switches in the body of every request");
    // Without `apiKey` the stored one stays; the switches follow the request.
    const onlyToggle = await r("/api/openrouter", { method: "PUT", body: { onlyWithoutSaving: false, noDataUsage: true } });
    assert.deepEqual(onlyToggle.body, { keySet: true, onlyWithoutSaving: false, noDataUsage: true });
    assert.equal(store.openRouterAccess().apiKey, SECRET);
    // The key never leaves the server.
    for (const path of ["/api/openrouter", "/api/providers", "/api/account/openrouter"]) {
      const a = await r(path);
      assert.ok(!a.raw.includes(SECRET), `${path} does not carry the key`);
    }
    assert.equal((await r("/api/providers")).body.providers.find((p) => p.id === "openrouter").connected, true, "connected with a key");
    const way = await r("/api/openrouter", { method: "DELETE" });
    assert.deepEqual(way.body, { keySet: false, onlyWithoutSaving: false, noDataUsage: true }, "DELETE removes only the key");
    assert.equal(store.openRouterAccess().apiKey, "");
    assert.equal((await r("/api/providers")).body.providers.find((p) => p.id === "openrouter").connected, false, "not connected without a key");
  }, { claude: CLAUDE_ONLY_STATUS, engine: true });
});
