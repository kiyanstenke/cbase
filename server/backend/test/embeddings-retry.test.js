// A failed load of the embedding model is tried again after RETRY_AFTER_MS — not never again (embeddings.js).
//
// Why: on 20.11.2026 the model download was cut off once during a cold start ("terminated"); the loader marked itself failed
// for the rest of the process and the knowledge search ran lexically only until the next restart, unnoticed.
// Counter-test: with the old behaviour (a permanent failure flag) the call after the waiting time stays null and the loader is
// asked only once — the second and third assertions below turn red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_AFTER_MS, embeddingsAvailable, setEmbedClock, setEmbedLoader } from "../electron/server/embeddings.js";

test("a failed model load is retried after the waiting time, never before — and a success stays", async () => {
  let now = 1_000_000;
  let calls = 0;
  let fail = true;
  setEmbedClock(() => now);
  setEmbedLoader(async () => { calls += 1; if (fail) throw new Error("terminated"); return { model: true }; });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    assert.equal(await embeddingsAvailable(), false, "first load fails");
    assert.equal(calls, 1);
    now += RETRY_AFTER_MS[0] - 1;
    assert.equal(await embeddingsAvailable(), false, "before the waiting time: no new attempt");
    assert.equal(calls, 1, "the loader is not asked again before the waiting time");
    now += 1;
    assert.equal(await embeddingsAvailable(), false, "second attempt, fails again");
    assert.equal(calls, 2, "after the waiting time the loader is asked again");
    now += RETRY_AFTER_MS[1] - 1;
    await embeddingsAvailable();
    assert.equal(calls, 2, "the second waiting time is the longer one");
    now += 1;
    fail = false;
    assert.equal(await embeddingsAvailable(), true, "third attempt succeeds");
    assert.equal(calls, 3);
    assert.equal(await embeddingsAvailable(), true);
    assert.equal(calls, 3, "a loaded model is not loaded again");
    assert.match(errors[0], /next attempt in 5 min/);
  } finally {
    console.error = orig;
    setEmbedLoader(null);
    setEmbedClock(null);
  }
});

test("the waiting times grow and the last one repeats", () => {
  assert.deepEqual(RETRY_AFTER_MS, [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000]);
  for (let i = 1; i < RETRY_AFTER_MS.length; i++) assert.ok(RETRY_AFTER_MS[i] > RETRY_AFTER_MS[i - 1]);
});
