// The targets of a deploy and their post-observations (deploy.mjs runTargets).
//
// `./deploy all` lets the post-observation of the server (150 s: does the gateway replace a B? do the inner containers come
// back?) run in the background while the client builds. It used to be a bare promise in an array:
//   · if a later target failed, the process ended with `process.exit` — the observation died wordlessly;
//   · if it turned red WHILE a later target built, nothing held it — an unhandledRejection ended the process at once,
//     say in the middle of an app-bundle swap.
// Promises: (1) a failed target waits for the post-observation and names its result at the error; (2) a red
// post-observation during a later target is no unhandledRejection, it is thrown after the last target; (3) both
// red => both in the text; (4) without a follow-up the targets that ran come back; (5) main goes through runTargets, the old
// array is gone. Waiting is on events (gates), never on a duration.
// COUNTER-PROOF: against a state without runTargets the file fails at the import; (5) is red there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runTargets } from "./deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function gate() {
  let on;
  const p = new Promise((r) => { on = r; });
  return { p, on };
}
// A few rounds of the event loop — enough for a promise without a handler to be reported as an unhandledRejection.
const rounds = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
async function silent(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
}

test("(1) a later target fails: the post-observation runs to the end, its result stands at the error", async () => {
  const postObservation = gate();
  const thrown = gate();
  let finished = false;
  const run = silent(() => runTargets(["server", "client"], async (t, { afterRun, laterTargets }) => {
    if (t === "server") {
      assert.deepEqual(laterTargets, ["client"]);
      afterRun(postObservation.p, "server post-observation");
      return;
    }
    thrown.on();
    throw new Error("client build failed");
  })).then(() => { finished = true; }, (e) => { finished = true; return e; });
  await thrown.p;
  await rounds();
  assert.equal(finished, false, "runTargets ended before the post-observation — the process would have ended it wordlessly");
  postObservation.on();
  const e = await run;
  assert.match(e.message, /^client build failed — server post-observation: ran to the end, green$/);
});

test("(2) the post-observation turns red while a later target builds: no unhandledRejection, thrown after the last target", async () => {
  const unhandled = [];
  const fang = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", fang);
  const further = gate();
  const run = [];
  try {
    const run2 = silent(() => runTargets(["server", "client", "mobile"], async (t, { afterRun }) => {
      run.push(t);
      if (t === "server") afterRun(Promise.reject(new Error("this B does not run the expected state")), "server post-observation");
      if (t === "client") await further.p;
    }));
    await rounds();
    further.on();
    await assert.rejects(run2, /^Error: this B does not run the expected state$/);
    await rounds();
    assert.deepEqual(run, ["server", "client", "mobile"], "the later targets did not run to the end");
    assert.deepEqual(unhandled, [], "unhandledRejection — the process would have ended in the middle of the client swap");
  } finally {
    process.off("unhandledRejection", fang);
  }
});

test("(3) both red: the target's error, plus the post-observation", async () => {
  const e = await silent(() => runTargets(["server", "client"], async (t, { afterRun }) => {
    if (t === "server") afterRun(Promise.reject(new Error("B replaced")), "server post-observation");
    else throw new Error("client does not start");
  })).catch((x) => x);
  assert.equal(e.message, "client does not start — plus RED server post-observation: B replaced");
});

test("(4) without a follow-up: the targets that ran; with one runTargets waits for it, even after the last target", async () => {
  const queue = [];
  const postObservation = gate();
  let finished = false;
  const run = silent(() => runTargets(["web", "server", "client"], async (t, { afterRun }) => {
    queue.push(t);
    if (t === "server") afterRun(postObservation.p.then(() => queue.push("postObservation")));
  })).then((d) => { finished = true; return d; });
  await rounds();
  assert.equal(finished, false, "runTargets ended before the post-observation");
  postObservation.on();
  assert.deepEqual(await run, ["web", "server", "client"]);
  assert.deepEqual(queue, ["web", "server", "client", "postObservation"]);
  assert.deepEqual(await silent(() => runTargets(["web"], async () => {})), ["web"], "without a follow-up: the targets that ran");
});

test("(5) main goes through runTargets — the bare array of post-observations is gone", () => {
  const deploy = fs.readFileSync(path.join(HERE, "deploy.mjs"), "utf8");
  const main = deploy.slice(deploy.indexOf("async function main("), deploy.indexOf("export async function runTargets("));
  assert.match(main, /const done = await runTargets\(o\.targets, async \(t, \{ laterTargets, afterRun \}\) => \{/);
  assert.match(main, /if \(r\?\.postObservation\) afterRun\(r\.postObservation, "server post-observation"\);/);
  assert.doesNotMatch(main, /deployStandalone|"standalone"/, "the standalone app is no target any more");
  assert.doesNotMatch(main, /afterRuns|Promise\.all\(/, "a post-observation without a handler in main");
});
