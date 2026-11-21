// The airlock of the periodic retrieval: web/src/lib/retrieval-airlock.ts is compiled with tsc and RUN -- with gates instead of
// durations (every answer is a promise the test itself fulfils; no clock). The promises, each with the way that breaks it:
//   (a) at most ONE fetch at a time -- the beat (`nudge(false)`) during a running one does nothing, and the answer of a fetch that
//       took longer than several beats is ADOPTED (the old state discarded it: "only the answer of the latest counts");
//   (b) causes during a fetch (`nudge()`) yield exactly ONE follow-up, no matter how many;
//   (c) an error is reported even if no state ever arrived, and afterwards the next nudge goes through again;
//   (d) after `end()` nothing is reported and nothing started any more.
// Plus the guard on the side: InstancesPage.tsx loads through the airlock, the beat nudges without a follow-up (instances-ui.test.mjs "tab").
//
// Run:  node --test web/test/retrieval-airlock.test.mjs
// COUNTER-TESTS (each turns red once):
//   - delete the branch `if (running) { ... return; }` in `nudge` (every nudge starts a fetch) => (a) and (b) red;
//   - replace the loop `while (again && alive)` by a single pass (no follow-up) => (b) red;
//   - `end` without `alive = false` => (d) red.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const SOURCE = path.join(webDir, "src", "lib", "retrieval-airlock.ts");
const tsc = path.join(webDir, "node_modules", "typescript", "bin", "tsc");

let tmp = null;
after(() => { try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* cleanup says nothing about the product */ } });

let module = null;
async function load() {
  if (module) return module;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-retrieval-airlock-"));
  execFileSync(process.execPath, [tsc, SOURCE, "--outDir", tmp, "--module", "es2022", "--target", "es2022", "--moduleResolution", "bundler"], { stdio: "pipe" });
  module = await import(pathToFileURL(path.join(tmp, "retrieval-airlock.js")).href);
  return module;
}

// A fetch whose answers the test gives by hand: `calls` counts the started ones, `respond(i, value)`/`fail(i, e)` fulfils the i-th.
function handRetrieval() {
  const open = [];
  return {
    fetch: () => new Promise((resolve, reject) => { open.push({ resolve, reject }); }),
    get calls() { return open.length; },
    respond: (i, value) => open[i].resolve(value),
    fail: (i, e) => open[i].reject(e),
  };
}
// The reports as a list, plus a gate per expected report (we wait for the event, never for a duration).
function reporter() {
  const list = [];
  const wait = [];
  const comes = (entry) => { list.push(entry); for (const w of wait.splice(0)) w(); };
  return {
    list,
    report: { ok: (value) => comes(["ok", value]), error: (e) => comes(["error", String(e?.message || e)]) },
    until: (n) => new Promise((r) => { const check = () => { if (list.length >= n) r(); else wait.push(check); }; check(); }),
  };
}
// Let all continuations that are already due run (no duration: setImmediate comes after the microtasks).
const traverse = () => new Promise((r) => setImmediate(r));

test("(a) at most one fetch; the beat during a running one does nothing; an answer slower than the beat is adopted", async () => {
  const { retrievalAirlock } = await load();
  const a = handRetrieval();
  const m = reporter();
  const s = retrievalAirlock(a.fetch, m.report);
  s.nudge();
  assert.equal(s.running(), true);
  // Three beats pass, the route does not answer yet (the case from the field: 7-12 s against a 5 s beat).
  for (let i = 0; i < 3; i++) s.nudge(false);
  await traverse();
  assert.equal(a.calls, 1, "the beat started a second fetch next to the running one");
  a.respond(0, "A");
  await m.until(1);
  assert.deepEqual(m.list, [["ok", "A"]], "the answer of the slow fetch was not adopted");
  await traverse();
  assert.equal(a.calls, 1, "a beat without a cause produced a follow-up");
  assert.equal(s.running(), false);
  // The next beat starts again -- and again its answer counts, also across further beats.
  s.nudge(false);
  s.nudge(false);
  assert.equal(a.calls, 2);
  a.respond(1, "B");
  await m.until(2);
  assert.deepEqual(m.list, [["ok", "A"], ["ok", "B"]]);
});

test("(b) causes during a fetch: exactly one follow-up", async () => {
  const { retrievalAirlock } = await load();
  const a = handRetrieval();
  const m = reporter();
  const s = retrievalAirlock(a.fetch, m.report);
  s.nudge();
  s.nudge();
  s.nudge(true);
  s.nudge(false);
  s.nudge();
  assert.equal(a.calls, 1, "a cause started a second fetch next to the running one");
  a.respond(0, "prior");
  await m.until(1);
  await traverse();
  assert.equal(a.calls, 2, "no (or more than one) follow-up after the causes");
  a.respond(1, "after");
  await m.until(2);
  await traverse();
  assert.equal(a.calls, 2, "the follow-up triggered another one");
  assert.deepEqual(m.list, [["ok", "prior"], ["ok", "after"]]);
});

test("(c) an error is reported, even with no state ever; afterwards the next nudge goes through", async () => {
  const { retrievalAirlock } = await load();
  const a = handRetrieval();
  const m = reporter();
  const s = retrievalAirlock(a.fetch, m.report);
  s.nudge();
  s.nudge(false);
  a.fail(0, new Error("502 Bad Gateway"));
  await m.until(1);
  assert.deepEqual(m.list, [["error", "502 Bad Gateway"]], "the error of the first fetch did not arrive -- \"unknown\" would keep meaning \"loading...\"");
  await traverse();
  assert.equal(s.running(), false);
  s.nudge(false);
  assert.equal(a.calls, 2, "after an error the airlock stayed shut");
  a.respond(1, "ok");
  await m.until(2);
  assert.deepEqual(m.list.at(-1), ["ok", "ok"]);
});

test("(d) after end(): no report, no follow-up, no new fetch", async () => {
  const { retrievalAirlock } = await load();
  const a = handRetrieval();
  const m = reporter();
  const s = retrievalAirlock(a.fetch, m.report);
  s.nudge();
  s.nudge(); // follow-up marked
  s.end();
  a.respond(0, "too late");
  await traverse();
  await traverse();
  assert.deepEqual(m.list, [], "an answer after detaching was still reported (another project, dead state)");
  assert.equal(a.calls, 1, "after end() the follow-up ran anyway");
  s.nudge();
  assert.equal(a.calls, 1, "after end() a new fetch started");
});
