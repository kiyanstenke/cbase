// The rules of the provider of the last answer (runs/upstream-display.js) — without server and without clock: every
// resolution is a promise the test itself fulfills, and the result of `report` is AWAITED. The chain at the real server
// (connector → engine → do-run → chat and stream) is held by server/backend/test/upstream-provider.test.js; there never
// are two resolutions in flight at once and never a switch during a lookup — exactly those paths are covered here.
//
// Counter-tests: (a) the counter per RUN instead of per chat (`let followUp` in the reporter) => red at "the latest resolution
// wins across runs" (Novita writes after Reka); (b) without the check of model/provider at the end => red at "a switch
// during the lookup writes nothing"; (c) the state preloaded from the chat => red at "every run starts empty" (no second
// lookup).
import assert from "node:assert/strict";
import test from "node:test";

import { upstreamReporter } from "../electron/server/runs/upstream-display.js";

// A promise the test fulfills from outside.
function open() {
  let resolve, raise;
  const p = new Promise((r, w) => { resolve = r; raise = w; });
  return { p, resolve, raise };
}

// A chat in memory and a reporter per "run"; `resolve` returns per name what the table says (number, promise or a
// function that throws).
function world(chatId, { model = "z-ai/glm-5.3-flash", provider = "or" } = {}) {
  const chat = { id: chatId, model, provider };
  const written = [];
  const retrievals = [];
  const run = (responses) => upstreamReporter({
    chatId, model: chat.model, provider: chat.provider,
    resolve: (name) => {
      retrievals.push(name);
      const a = responses[name];
      return typeof a === "function" ? a() : a;
    },
    getChat: (id) => (id === chatId ? { ...chat } : null),
    write: (name, window) => written.push([name, window]),
  });
  return { chat, written, retrievals, run };
}

test("the latest resolution of a chat wins — across runs too", async () => {
  const w = world("c-runs");
  const hangs = open();
  const runA = w.run({ Novita: hangs.p });
  const a = runA("Novita");                       // run A: the lookup hangs
  const runB = w.run({ Reka: 262144 });
  assert.equal(await runB("Reka"), true, "run B writes");
  assert.deepEqual(w.written, [["Reka", 262144]]);
  hangs.resolve(1048576);                          // run A comes back too late
  assert.equal(await a, false, "the older resolution no longer writes");
  assert.deepEqual(w.written, [["Reka", 262144]], "Reka stays");
});

test("the latest resolution wins within a run, and a failure of the older one changes nothing", async () => {
  const w = world("c-run");
  const hangs = open();
  const m = w.run({ DeepInfra: hangs.p, Parasail: 524288 });
  const a = m("DeepInfra");
  assert.equal(await m("Parasail"), true);
  hangs.raise(new Error("connection dropped"));
  assert.equal(await a, false);
  assert.deepEqual(w.written, [["Parasail", 524288]]);
});

test("a model or provider switch during the lookup writes nothing", async () => {
  for (const [field, fresh] of [["model", "z-ai/glm-5.3"], ["provider", "claude"]]) {
    const w = world(`c-switch-${field}`);
    const hangs = open();
    const m = w.run({ DeepInfra: hangs.p });
    const a = m("DeepInfra");
    w.chat[field] = fresh;                            // PATCH while the lookup hangs
    hangs.resolve(1048576);
    assert.equal(await a, false, `${field} switched => nothing written`);
    assert.deepEqual(w.written, []);
  }
  // The chat is gone (deleted) => nothing either.
  const w = world("c-gone");
  const m = upstreamReporter({ chatId: "c-gone", model: "", provider: "or", resolve: () => 1, getChat: () => null, write: (...x) => w.written.push(x) });
  assert.equal(await m("DeepInfra"), false);
  assert.deepEqual(w.written, []);
});

test("every run starts empty: the same name is resolved anew in the next run (default model switch)", async () => {
  // chat.model = "" (default): run 1 runs on model A, run 2 after a switch of the default model on B — both via
  // DeepInfra. Preloaded from the chat, the window of A would stay (1,048,576 instead of 131,072).
  const w = world("c-default", { model: "" });
  assert.equal(await w.run({ DeepInfra: 1048576 })("DeepInfra"), true);
  assert.equal(await w.run({ DeepInfra: 131072 })("DeepInfra"), true, "run 2 asks anew");
  assert.deepEqual(w.written, [["DeepInfra", 1048576], ["DeepInfra", 131072]]);
  assert.deepEqual(w.retrievals, ["DeepInfra", "DeepInfra"]);
});

test("within a run: a known window is not asked again, an unknown one once, a name in flight not twice", async () => {
  const w = world("c-once");
  const hangs = open();
  const m = w.run({ Reka: hangs.p, Novita: () => { throw new Error("500"); } });
  const a = m("Reka");
  assert.equal(m("Reka"), null, "the same name is already in flight");
  hangs.resolve(262144);
  assert.equal(await a, true);
  assert.equal(m("Reka"), null, "window known => no new lookup");
  assert.equal(await m("Novita"), true, "a failure reports the name with window 0");
  assert.equal(m("Novita"), null, "same name without a window: no second attempt in the same run");
  assert.equal(m(""), null, "an empty name asks nothing");
  assert.deepEqual(w.written, [["Reka", 262144], ["Novita", 0]]);
  assert.deepEqual(w.retrievals, ["Reka", "Novita"]);
});
