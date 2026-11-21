// The provider of the last answer — at the main seam: real server, real loop engine, the built-in OpenRouter on a FAKE
// endpoint (chat/completions with the field `provider` on every chunk, plus `/models` and `/models/<id>/endpoints`) via
// the test seam `CBASE_OPENROUTER_BASE`.
//
// OpenRouter picks the provider anew PER REQUEST (by price and load). The context bar therefore names the provider that
// delivered the LAST answer, and its window; calculation continues with the catalog number `context`. The chain:
// connector (`provider` field of the chunk, connectors/openai-chat.js) -> engine (`message.provider` at message_start,
// contract.js) -> runs/do-run.js -> runs/upstream-display.js (`upstreamReporter`: asynchronous via `providerWindow`,
// providers/openrouter-endpoints.js) -> chat columns `upstream_provider`/`upstream_window` (store/chats.js) and SSE
// `harness/provider`.
//
// What it proves: (1) after the turn chat and stream carry name AND window, the endpoint was asked with the provider's
// key; (2) a second turn over another provider follows, the endpoints came from the cache; (3) a model switch empties both
// fields; (4) an endpoint that does not answer does NOT hold the run — the turn is done while the lookup hangs, and if it
// breaks off the name stands without window; (5) a 500 likewise; (6) a name with an unknown window gets ONE new attempt in
// the next run.
//
// Waits for events, never for a duration (waitForTruthy without deadline).
//
// Counter-tests: (a) providers/engine.js without the provider at usageStart => red at "message_start carries the
// provider" (`undefined` instead of 'DeepInfra'); (b) runs/do-run.js without the call of `upstreamReport` => no endpoint
// lookup, no `harness/provider` — the test waits at the first `providerNotice` (aborted from outside, no red line: a
// promise that never comes true is a hang here, see agent-harness.mjs:waitForTruthy); (c) store/chats.js:updateChat
// without the emptying at the switch => red at "a model switch empties both fields" (['Reka', 262144] instead of ['', 0]).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { json, withAgentsServer, logInOpenRouter } from "./agent-harness.mjs";

// The measured shape of the OpenRouter endpoints (provider_name, context_length, status), shortened: z-ai/glm-5.3-flash has
// 33, among them DeepInfra and Novita with 1,048,576 and Reka with 262,144.
const ENDPOINTS = [
  { provider_name: "DeepInfra", context_length: 1048576, status: 0 },
  { provider_name: "Reka", context_length: 262144, status: 0 },
  { provider_name: "Novita", context_length: 1048576, status: 0 },
  { provider_name: "Parasail", context_length: 524288, status: 0 },
];

async function fakeRouter() {
  const state = { provider: "DeepInfra", mode: "normal", hanging: [], endpointRetrievals: [], responses: 0 };
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const u = decodeURIComponent(req.url);
    const t = u.match(/^\/v1\/models\/(.+)\/endpoints$/);
    if (req.method === "GET" && t) {
      state.endpointRetrievals.push({ id: t[1], mode: state.mode, auth: req.headers.authorization || "" });
      if (state.mode === "hangs") { state.hanging.push(res); return; }
      if (state.mode === "broken") { res.writeHead(500); res.end("broken"); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: t[1], endpoints: ENDPOINTS } }));
      return;
    }
    if (req.method === "GET" && u.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      // The catalog shape (providers/openrouter-catalog.js): only models with tools; uniform context (no median lookup of
      // the catalog — the endpoint lookups below belong to the display alone).
      const entry = (id, name) => ({ id, name, supported_parameters: ["tools"], context_length: 1048576, top_provider: { context_length: 1048576 } });
      res.end(JSON.stringify({ data: [entry("z-ai/glm-5.3-flash", "GLM 5.3 Flash"), entry("z-ai/glm-5.3", "GLM 5.3")] }));
      return;
    }
    if (req.method !== "POST" || !u.endsWith("/chat/completions")) { res.writeHead(404); res.end(); return; }
    let b = {};
    try { b = JSON.parse(raw); } catch { /* empty */ }
    if (b.stream === false) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provider: state.provider, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      return;
    }
    const n = ++state.responses;
    const header = { id: `gen-${n}`, provider: state.provider, model: b.model, object: "chat.completion.chunk" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const row = (o) => res.write(`data: ${JSON.stringify({ ...header, ...o })}\n\n`);
    row({ choices: [{ index: 0, delta: { role: "assistant", content: `Answer via ${state.provider}` }, finish_reason: null }] });
    row({ choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }] });
    row({ choices: [], usage: { prompt_tokens: 26000, completion_tokens: 7 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}/v1`,
    state,
    close: () => new Promise((r) => {
      for (const h of state.hanging.splice(0)) { try { h.socket?.destroy(); } catch { /* already gone */ } }
      srv.closeAllConnections?.();
      srv.close(() => r());
    }),
  };
}

// The chat's event stream, recorded.
async function stream(base, chatId) {
  const ctl = new AbortController();
  const events = [];
  const r = await fetch(`${base}/api/chats/${chatId}/stream`, { signal: ctl.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const blk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const z of blk.split("\n")) if (z.startsWith("data: ")) { try { events.push(JSON.parse(z.slice(6))); } catch { /* not a line */ } }
        }
      }
    } catch { /* unsubscribed */ }
  })();
  return { events, close: () => ctl.abort() };
}

test("provider of the last answer: name and window on chat and stream, a second provider follows, a model switch empties, a hanging or broken endpoint leaves the run untouched", async () => {
  const router = await fakeRouter();
  const basePrior = process.env.CBASE_OPENROUTER_BASE;
  process.env.CBASE_OPENROUTER_BASE = router.url;
  try {
    await withAgentsServer(async ({ base, dataRoot, ws, waitForTruthy, waitForIdle, barrier }) => {
      const id = "openrouter";
      await logInOpenRouter({ base, dataRoot }, { apiKey: "sk-or-test" });
      const chat = await json(`${base}/api/chats`, { method: "POST", body: JSON.stringify({ workspaceId: ws.id, provider: id, model: "z-ai/glm-5.3-flash", permissionMode: "bypassPermissions" }) });
      await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Upstream" }) });
      const s = await stream(base, chat.id);
      const fields = async () => { const c = await json(`${base}/api/chats/${chat.id}`); return [c.upstreamProvider, c.upstreamWindow]; };
      const turn = async (text) => {
        const mark = s.events.length;
        await json(`${base}/api/chats/${chat.id}/message`, { method: "POST", body: JSON.stringify({ text }) });
        await waitForTruthy(() => s.events.slice(mark).some((e) => e.type === "harness" && e.subtype === "run_done"), "run_done");
        await waitForIdle();
      };
      const providerNotice = (name) => waitForTruthy(() => {
        const e = s.events.find((x) => x.type === "harness" && x.subtype === "provider" && x.provider === name);
        return e ? { provider: e.provider, window: e.window } : null;
      }, `harness/provider ${name}`);
      try {
        assert.deepEqual(await fields(), ["", 0], "a new chat knows no provider");

        // (1) DeepInfra: the name is at message_start (engine), name and window on chat and stream (do-run).
        await turn("First question");
        const start = s.events.filter((e) => e.type === "stream_event" && e.event?.type === "message_start" && !e.parent_tool_use_id).at(-1);
        assert.equal(start?.event?.message?.provider, "DeepInfra", "message_start carries the provider");
        assert.deepEqual(await providerNotice("DeepInfra"), { provider: "DeepInfra", window: 1048576 });
        assert.deepEqual(await fields(), ["DeepInfra", 1048576]);
        assert.deepEqual(router.state.endpointRetrievals.map((a) => [a.id, a.auth]), [["z-ai/glm-5.3-flash", "Bearer sk-or-test"]],
          "ONE lookup, for the chat's model, with the provider's key");

        // (2) Reka: follows — from the cache (no second lookup).
        router.state.provider = "Reka";
        await turn("Second question");
        assert.deepEqual(await providerNotice("Reka"), { provider: "Reka", window: 262144 });
        assert.deepEqual(await fields(), ["Reka", 262144]);
        assert.equal(router.state.endpointRetrievals.length, 1, "the endpoints came from the cache");

        // (3) A model switch empties both fields (the provider belonged to the old model).
        await json(`${base}/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ model: "z-ai/glm-5.3" }) });
        assert.deepEqual(await fields(), ["", 0], "a model switch empties both fields");

        // (4) The endpoint hangs: the turn is done anyway — the answer is in the history before the lookup ends.
        router.state.mode = "hangs";
        router.state.provider = "Novita";
        await turn("Third question");
        await waitForTruthy(() => router.state.hanging.length > 0, "hanging endpoint lookup");
        const log = await json(`${base}/api/chats/${chat.id}/log`);
        const rows = Array.isArray(log) ? log : (log.messages || []);
        assert.ok(rows.some((m) => m.role === "assistant" && String(m.text).includes("Answer via Novita")), "the turn's answer is there");
        assert.ok(!s.events.some((e) => e.type === "harness" && e.subtype === "provider" && e.provider === "Novita"), "no notice while the lookup hangs");
        assert.deepEqual(await fields(), ["", 0]);
        // It breaks off => the name without window.
        for (const h of router.state.hanging.splice(0)) h.socket.destroy();
        assert.deepEqual(await providerNotice("Novita"), { provider: "Novita", window: 0 });
        assert.deepEqual(await fields(), ["Novita", 0]);

        // (5) A 500 likewise: name without window, the run untouched.
        router.state.mode = "broken";
        router.state.provider = "Parasail";
        await turn("Fourth question");
        assert.deepEqual(await providerNotice("Parasail"), { provider: "Parasail", window: 0 });
        assert.deepEqual(await fields(), ["Parasail", 0]);

        // (6) The same name, window still unknown: the next run tries ONCE more — and finds it.
        router.state.mode = "normal";
        // The cut behind the stream barrier (quiet.mjs): the look over HTTP into the chat (fields()) can lag behind — an
        // earlier written event would otherwise count as a later one.
        const prior = await barrier(s, chat.id);
        await turn("Fifth question");
        await waitForTruthy(() => s.events.slice(prior).find((e) => e.type === "harness" && e.subtype === "provider"), "harness/provider after the new attempt");
        assert.deepEqual(s.events.slice(prior).filter((e) => e.type === "harness" && e.subtype === "provider").map((e) => [e.provider, e.window]), [["Parasail", 524288]]);
        assert.deepEqual(await fields(), ["Parasail", 524288]);
      } finally {
        s.close();
      }
    });
  } finally {
    if (basePrior === undefined) delete process.env.CBASE_OPENROUTER_BASE; else process.env.CBASE_OPENROUTER_BASE = basePrior;
    await router.close();
  }
});
