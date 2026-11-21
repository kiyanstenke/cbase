// ONE default model per provider, for the BUILT-IN OpenRouter.
//
// An editor field (`providers.default_model`, read by the connector for an empty model) and the selection under Settings →
// Providers (`default_model_<id>`, read by `defaultModelFor`) used to be two "default model" fields that could name different
// models. Only the selection is left; the editor and its routes are gone, OpenRouter is built in (connectors/openrouter.js).
// What stays is the promise itself: /api/providers (`defaultModel`), every run (`defaultModelFor`) and the connector for an
// empty model (`resolveModelRef("openrouter::")`) name the SAME model, and `PUT /api/default-model` acts on all three. The
// models come from the catalog (providers/openrouter-catalog.js, here from the test source): only models with tools are
// selectable, an empty catalog is unknown (the stored default keeps applying). The context window from the catalog is
// checked by server/backend/test/openrouter-catalog.test.js.
//
// No fallback to the first catalog model: without a stored default there is none (""), and a run without a model ends with a
// message before any request goes out (connectors/openai-chat.js `withoutModel`); a stored one the catalog does not list (with
// tools) keeps APPLYING and shows as `defaultModelInvalid` in /api/providers.
//
// COUNTER-TESTS: removing the line `defaultModel: () => defaultModelFor(OPENROUTER_ID),` from the built-in OpenRouter in
// providers/index.js makes the connector take the first catalog model for an empty model, so test 1 turns red at "stored
// selection: both ways". providers/index.js defaultModelFor without the line `if (p === OPENROUTER_ID) return stored || "";`
// turns test 1 red at "without a choice: no default" (LLAMA instead of "") and test 2 at `defaultModel`.
//
// The SHORTLIST in the system prompt is stably ordered: default first, the used ones by name, not by "last used", otherwise
// every run of another OpenRouter model would change the prompt of all chats (prompt cache rewritten). COUNTER-TEST:
// store/provider.js usedModelsSince with `SELECT model, MAX(at) AS last_used … GROUP BY model ORDER BY last_used DESC` turns
// test 3 red at "the order does not depend …".
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { startServer } from "../electron/server/server.js";
import { agentHosts, defaultModelFor, getConnector, resolveModelRef, defaultModelInvalid } from "../electron/server/providers/index.js";
import { catalogReady, setCatalogSourceForTests } from "../electron/server/providers/openrouter-catalog.js";
import { subagentChoicePrompt } from "../electron/server/runs/system-prompt.js";

// The shape of the public API (GET /models): two models with tools, one without.
const CATALOG = [
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", supported_parameters: ["tools"], context_length: 1_048_576 },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", supported_parameters: ["tools", "reasoning"], context_length: 1_048_576 },
  { id: "without/tools", name: "Without tools", supported_parameters: ["temperature"], context_length: 8192 },
];
const LLAMA = "meta-llama/llama-4-maverick";
const GLM = "z-ai/glm-5.3-flash";

function cleanUp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
  catch (e) { console.warn(`Cleanup of ${dir} failed (${e.code || e.message}) — test unaffected.`); }
}
const both = () => ({ selection: defaultModelFor("openrouter"), connector: resolveModelRef("openrouter::").model });

test("built-in OpenRouter: selection and connector name the same model; none without a choice (a run ends with a message), the choice with one even if the catalog no longer lists it; an empty catalog keeps the stored default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-f19-or-"));
  try {
    store.initStore(root);
    setCatalogSourceForTests(() => CATALOG);
    await catalogReady();
    assert.deepEqual(both(), { selection: "", connector: "" }, "without a choice: no default, never the first catalog model");
    assert.equal(defaultModelInvalid("openrouter"), false, "no stored default is not an invalid one");
    // A run without a model ends with a message that says where to fix it, before any request goes out.
    const or = getConnector("openrouter");
    await assert.rejects(or.complete({ messages: [{ role: "user", content: "hello" }], model: "" }), /kein Modell gewählt und kein Standardmodell/);
    await assert.rejects(or.runOnce("hello", { model: "" }), /kein Modell gewählt und kein Standardmodell/);

    store.setSetting("default_model_openrouter", GLM);
    assert.deepEqual(both(), { selection: GLM, connector: GLM }, "stored selection: both ways");
    assert.equal(defaultModelInvalid("openrouter"), false);

    // A stored default the catalog does not list with tools (or no longer at all) keeps APPLYING (silently running another
    // model would be worse), and the settings page learns of it (`defaultModelInvalid`).
    for (const m of ["without/tools", "z-ai/glm-5.2-alt"]) {
      store.setSetting("default_model_openrouter", m);
      assert.deepEqual(both(), { selection: m, connector: m }, `"${m}" stays the default`);
      assert.equal(defaultModelInvalid("openrouter"), true, `the catalog does not list "${m}" with tools`);
    }

    // Empty is not unknown: without a file and without network the catalog is empty; the stored default keeps applying
    // instead of sending every chat without a model into a 400 with ""; it is not invalid then (the catalog knows nothing).
    store.setSetting("default_model_openrouter", GLM);
    setCatalogSourceForTests(() => { throw new Error("no network"); });
    await catalogReady();
    assert.deepEqual(both(), { selection: GLM, connector: GLM }, "empty catalog: the stored default on both ways");
    store.setSetting("default_model_openrouter", "z-ai/glm-5.2-alt");
    assert.equal(defaultModelInvalid("openrouter"), false, "empty catalog: unknown, not invalid");
  } finally {
    setCatalogSourceForTests(null);
    cleanUp(root);
  }
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test("at the server: /api/providers, defaultModelFor and the connector name the same; PUT /api/default-model acts on all three and accepts only catalog models with tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-f19-server-"));
  const dataRoot = path.join(root, "data-root");
  const prior = { CBASE_EMBED_OFFLINE: process.env.CBASE_EMBED_OFFLINE, CBASE_TRIGGER_POLL: process.env.CBASE_TRIGGER_POLL, CBASE_RESTART_GRACE_MS: process.env.CBASE_RESTART_GRACE_MS };
  process.env.CBASE_EMBED_OFFLINE = "1";
  process.env.CBASE_TRIGGER_POLL = "0";
  process.env.CBASE_RESTART_GRACE_MS = "3600000"; // no restart tick in this test
  let server;
  try {
    fs.mkdirSync(path.join(dataRoot, "data"), { recursive: true });
    setCatalogSourceForTests(() => CATALOG);
    const port = await freePort();
    server = await startServer({ port, dataRoot, webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    await catalogReady();
    const base = `http://127.0.0.1:${port}`;
    const json = async (p, init) => { const r = await fetch(`${base}${p}`, { headers: { "Content-Type": "application/json" }, ...init }); return { status: r.status, body: await r.json() }; };
    const route = async () => (await json("/api/providers")).body.providers.find((p) => p.id === "openrouter");

    const or = await route();
    assert.deepEqual(or.models.map((m) => m.id), [LLAMA, GLM], "/api/providers: the catalog list, only models with tools");
    assert.equal(or.defaultModel, "", "without a choice: no default");
    assert.equal(or.defaultModelInvalid, false);
    assert.deepEqual(both(), { selection: "", connector: "" }, "... and the same on both ways");

    assert.equal((await json("/api/default-model", { method: "PUT", body: JSON.stringify({ provider: "openrouter", model: GLM }) })).status, 200);
    assert.equal((await route()).defaultModel, GLM);
    assert.equal((await route()).defaultModelInvalid, false);
    assert.deepEqual(both(), { selection: GLM, connector: GLM });
    for (const id of ["claude", "codex"]) {
      assert.equal((await json("/api/providers")).body.providers.find((p) => p.id === id).defaultModelInvalid, false, `${id}: never`);
    }

    // Only catalog models with tools: everything else is a 400 and changes nothing.
    for (const model of ["without/tools", "exists/es-not", ""]) {
      const r = await json("/api/default-model", { method: "PUT", body: JSON.stringify({ provider: "openrouter", model }) });
      assert.equal(r.status, 400, `"${model}" is no selectable OpenRouter model`);
    }
    assert.deepEqual(both(), { selection: GLM, connector: GLM }, "the rejected attempts change nothing");

    // A stored default the catalog no longer lists (renamed, switched off): IT is named, with the flag.
    store.setSetting("default_model_openrouter", "z-ai/glm-5.2-alt");
    const old = await route();
    assert.deepEqual([old.defaultModel, old.defaultModelInvalid], ["z-ai/glm-5.2-alt", true]);
  } finally {
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
    setCatalogSourceForTests(null);
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    cleanUp(root);
  }
});

test("shortlist in the system prompt: default first, the used ones by name; a run of another model does not change the prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-shortlist-"));
  const INCLUDING = (id) => ({ id, name: id, supported_parameters: ["tools"], context_length: 100_000 });
  try {
    store.initStore(root);
    setCatalogSourceForTests(() => [INCLUDING("a/one"), INCLUDING("b/two"), INCLUDING("c/three")]);
    await catalogReady();
    store.setOpenRouterAccess({ apiKey: "sk-or-test", extraBody: {} }); // without a key agentHosts does not name OpenRouter
    store.setSetting("default_model_openrouter", "c/three");
    const t = Date.now();
    const run = (model, at) => store.addUsageEvent({ provider: "openrouter", model, input: 10, output: 1, billing: "metered", at });
    const prompt = () => subagentChoicePrompt([], agentHosts());
    const shortlist = () => agentHosts().find((h) => h.id === "openrouter").models.map((m) => m.id);

    run("b/two", t - 3000);
    run("a/one", t - 2000); // last used: a
    const prior = prompt();
    assert.deepEqual(shortlist(), ["c/three", "a/one", "b/two"], "default first, then by name");
    run("b/two", t - 1000); // now last used: b
    assert.deepEqual(shortlist(), ["c/three", "a/one", "b/two"], "the order does not depend on the last use");
    assert.equal(prompt(), prior, "same prompt: the chats' prompt cache stays");
    assert.ok(prior.includes("openrouter::c/three, openrouter::a/one, openrouter::b/two"), prior);
  } finally {
    setCatalogSourceForTests(null);
    cleanUp(root);
  }
});
