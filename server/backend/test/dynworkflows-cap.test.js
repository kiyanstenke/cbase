// The concurrency of the dynamic workflows as a unit, without a server: the default per run (fixed 8), the slots under both
// caps (dynworkflows/cap.js runSlots) and the prompt-cache stagger (createStagger). The main seam with a real server and fake
// CLI is in dynworkflows-concurrency.test.js. A file of its own because `initStore` binds the storage of the process (like
// archive-store.test.js).
//
// COUNTER-TESTS (each turns the named test red):
//   - the old formula min(16, max(2, CPUs - 2)) turns "default per run" red (4 CPUs => 2, 32 => 16);
//   - removing the per-run cap in distribute() (the `continue` branch) turns "slots: cap per run ..." red;
//   - removing `!prefixCache ||` in before() turns "stagger: without prefix cache ..." red;
//   - removing the condition `&& w.storage` at the hold in distribute() (a slot without a process waits behind the storage)
//     turns "storage gate: ..." red (the main seam is in dynworkflows-save-gate.test.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as capModule from "../electron/server/dynworkflows/cap.js";
import {
  USER_CAP_SETTING, USER_CAP_DEFAULT, STAGGER_MS_DEFAULT, capStatus, createStagger,
  runCap, runSlots, userCap, setUserCap, storageCandidates, staggerMs,
} from "../electron/server/dynworkflows/cap.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-cap-"));
store.initStore(dir);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Set the environment per test and restore it afterwards: the knob is read at call time.
function withEnvironment(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = String(v); }
  const back = () => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let r;
  try { r = fn(); } catch (e) { back(); throw e; }
  if (r && typeof r.then === "function") return r.finally(back);
  back();
  return r;
}
// Has a promise not settled yet: once through the microtasks, then look; no time window, the slots resolve synchronously
// in distribute().
const state = async (p) => { let finished = false; p.then(() => { finished = true; }); await Promise.resolve(); await Promise.resolve(); return finished; };

// The default does not come from a formula over the core count (Node reports 4 CPUs in the user container). The core count
// is FAKED here (os.availableParallelism, as the container reports it and as a big machine): the default stays 8, only the
// knob overrides it.
test("default per run: 8 at the same time, independent of the core count (4 CPUs like in the user container, 32 CPUs, one); the knob overrides", () => {
  assert.equal(capModule.RUN_CAP_DEFAULT, 8);
  const real = os.availableParallelism;
  try {
    for (const cpus of [1, 4, 32]) {
      os.availableParallelism = () => cpus;
      withEnvironment({ CBASE_DYNWF_RUN_CAP: undefined }, () => assert.equal(runCap(), 8, `${cpus} CPUs`));
    }
  } finally { os.availableParallelism = real; }
  withEnvironment({ CBASE_DYNWF_RUN_CAP: "3" }, () => assert.equal(runCap(), 3));
  withEnvironment({ CBASE_DYNWF_RUN_CAP: "0" }, () => assert.equal(runCap(), 8, "an invalid knob falls back to the default"));
  // Description side = execution side: the guide the model reads under Ultracode (dynworkflows/guide.md, section on the
  // cap) names the same number, and no core count.
  const guide = fs.readFileSync(new URL("../electron/server/dynworkflows/guide.md", import.meta.url), "utf8");
  assert.match(guide, new RegExp(`At most ${capModule.RUN_CAP_DEFAULT} agents run at the same time per run`), "the guide names the cap per run");
  assert.doesNotMatch(guide, /CPUs/, "the guide still computes the cap from the core count");
  withEnvironment({ CBASE_DYNWF_STAGGER_MS: undefined }, () => assert.equal(staggerMs(), STAGGER_MS_DEFAULT));
  withEnvironment({ CBASE_DYNWF_STAGGER_MS: "0" }, () => assert.equal(staggerMs(), 0));
});

test("cap per user: default 8, a set value wins, a missing or invalid field is no statement", () => {
  withEnvironment({ CBASE_DYNWF_USER_CAP: undefined }, () => {
    store.setSetting(USER_CAP_SETTING, "");
    assert.equal(userCap(), USER_CAP_DEFAULT);
    assert.equal(USER_CAP_DEFAULT, 8);
    assert.deepEqual(setUserCap(undefined), { ok: false, error: "missing" });
    assert.deepEqual(setUserCap(null), { ok: false, error: "missing" });
    assert.deepEqual(setUserCap(0), { ok: false, error: "invalid" });
    assert.deepEqual(setUserCap(2.5), { ok: false, error: "invalid" });
    assert.equal(userCap(), 8, "a rejected value changes nothing");
    assert.deepEqual(setUserCap(5), { ok: true, cap: 5 });
    assert.equal(userCap(), 5);
    store.setSetting(USER_CAP_SETTING, "");
  });
});

test("slots: cap per run 2 and per user 3 with two runs; waiting calls report the cap that holds them and start in call order", async () => {
  await withEnvironment({ CBASE_DYNWF_RUN_CAP: "2", CBASE_DYNWF_USER_CAP: "3" }, async () => {
    store.setSetting(USER_CAP_SETTING, "");
    const A = runSlots("wf_aaaaaa");
    const B = runSlots("wf_bbbbbb");
    const reasons = [];
    const enabled = (run, name) => { const p = run.request({ waiting: (d) => reasons.push([name, d]) }); p.name = name; return p; };
    const a1 = enabled(A, "a1"); const a2 = enabled(A, "a2"); const a3 = enabled(A, "a3");
    const b1 = enabled(B, "b1"); const b2 = enabled(B, "b2"); const b3 = enabled(B, "b3");
    assert.deepEqual(reasons, [["a3", "run"], ["b2", "user"], ["b3", "user"]]);
    assert.deepEqual(await Promise.all([a1, a2, a3, b1, b2, b3].map(state)), [true, true, false, true, false, false]);
    assert.deepEqual(capStatus().perRun, { wf_aaaaaa: 2, wf_bbbbbb: 1 });
    assert.equal(capStatus().total, 3);
    // a1 releases: a3 stood BEFORE b2 in the queue and gets the slot (its run has one free again).
    (await a1)();
    assert.deepEqual(await Promise.all([a3, b2, b3].map(state)), [true, false, false]);
    // a2 releases: run A needs none, b2 is next.
    (await a2)();
    assert.deepEqual(await Promise.all([b2, b3].map(state)), [true, false]);
    assert.deepEqual(capStatus().perRun, { wf_aaaaaa: 1, wf_bbbbbb: 2 });
    // Run B is at ITS cap: a release in A does not let b3 go, one in B does.
    (await a3)();
    assert.equal(await state(b3), false, "b3 waits for the cap of its run, not for that of the user");
    const free = await b1;
    free(); free(); // idempotent
    assert.equal(await state(b3), true);
    assert.deepEqual(capStatus().perRun, { wf_bbbbbb: 2 });
    A.close(); B.close();
    assert.deepEqual(capStatus(), { total: 0, perRun: {}, waiting: 0, atStorage: 0, runCap: 2, userCap: 3 });
  });
});

test("slots: close() returns taken ones, waiting calls yield null; and a larger cap releases at once", async () => {
  await withEnvironment({ CBASE_DYNWF_RUN_CAP: "16", CBASE_DYNWF_USER_CAP: undefined }, async () => {
    store.setSetting(USER_CAP_SETTING, "1");
    const A = runSlots("wf_cccccc");
    const B = runSlots("wf_dddddd");
    const a1 = A.request();
    const a2 = A.request();
    const b1 = B.request();
    assert.equal(await state(a2), false);
    A.close();
    assert.equal(await a2, null, "a waiting call of a closed run never starts");
    assert.equal(typeof (await a1), "function");
    assert.equal(await state(b1), true, "the slot of a1 went back to the other run");
    assert.equal(await A.request(), null, "no new slot after closing");
    const b2 = B.request();
    const b3 = B.request();
    assert.equal(await state(b2), false);
    assert.deepEqual(setUserCap(3), { ok: true, cap: 3 });
    assert.deepEqual(await Promise.all([b2, b3].map(state)), [true, true], "the larger cap takes effect without a release");
    B.close();
    assert.equal(capStatus().total, 0);
    store.setSetting(USER_CAP_SETTING, "");
  });
});

// The storage gate as a unit: the situation through the seam of the original (CBASE_STORAGE_ROOT, see
// graph-save-gate.test.js), released only through the arbiter's source. No server runs in this process, so the arbiter does
// not know the source, and the wake-up at the end of a slot (storageQueueSoon) stays without effect.
test("storage gate: with full memory slots wait with reason and text of the situation, a slot without a process does not; only the arbiter's candidate releases, one per attempt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-dynwf-gate-"));
  const GIB = 1024 ** 3;
  const situation = (current) => {
    fs.mkdirSync(path.join(root, "sys", "fs", "cgroup"), { recursive: true });
    fs.writeFileSync(path.join(root, "sys", "fs", "cgroup", "memory.max"), `${12 * GIB}\n`);
    fs.writeFileSync(path.join(root, "sys", "fs", "cgroup", "memory.current"), `${current}\n`);
  };
  try {
    await withEnvironment({ CBASE_STORAGE_ROOT: root, CBASE_DYNWF_RUN_CAP: "16", CBASE_DYNWF_USER_CAP: undefined }, async () => {
      store.setSetting(USER_CAP_SETTING, "");
      situation(Math.round(12 * GIB * 0.9));
      const A = runSlots("wf_eeeeee");
      const reasons = [];
      const enabled = (name, o = {}) => A.request({ waiting: (d) => reasons.push([name, "cap", d]), waitingForStorage: (g) => reasons.push([name, "storage", g]), ...o });
      const a1 = enabled("a1");
      const a2 = enabled("a2");
      const without = enabled("without", { storage: false }); // a parked agent keeps running: no new process
      const reason = "wartet auf Speicher: Container bei 90 % seiner Grenze (10,8 von 12,0 GiB)";
      assert.deepEqual(reasons, [["a1", "storage", reason], ["a2", "storage", reason]]);
      assert.deepEqual(await Promise.all([a1, a2, without].map(state)), [false, false, true], "the slot without a process does not wait behind the storage");
      assert.deepEqual([capStatus().atStorage, capStatus().total], [2, 1]);
      const [k] = storageCandidates();
      assert.equal(storageCandidates().length, 1, "ONE candidate for the whole queue");
      assert.equal(k.storage, true);
      assert.ok(Number.isFinite(k.waitingSince) && k.waitingSince > 0, "alt = call time of the oldest storage waiter");
      assert.deepEqual(k.attempts(), { started: false }, "closed is closed");
      situation(3 * GIB);
      // A slot becomes free, the gate is open, yet a1 does NOT start: only the arbiter releases storage waiters.
      (await without)();
      assert.equal(await state(a1), false);
      assert.deepEqual(storageCandidates()[0].attempts(), { started: true });
      assert.deepEqual(await Promise.all([a1, a2].map(state)), [true, false], "one per attempt, the oldest");
      assert.deepEqual(storageCandidates()[0].attempts(), { started: true });
      assert.equal(await state(a2), true);
      assert.deepEqual(storageCandidates(), [], "nobody waits for storage any more");
      assert.deepEqual(reasons.length, 2, "no reason reported a second time");
      A.close();
      assert.deepEqual([capStatus().total, capStatus().waiting, capStatus().atStorage], [0, 0, 0]);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stagger: the first of a prefix starts at once, the others after its first event; without prefix cache and with deadline 0 nobody is delayed", async () => {
  // Deadline one hour: resolved here only by the event, never by the clock (unref, it does not hold the test).
  const s = createStagger({ ms: 3_600_000 });
  assert.equal(s.before("claude::opus::", 1, { prefixCache: true }), null, "the first never waits");
  const two = s.before("claude::opus::", 2, { prefixCache: true });
  const three = s.before("claude::opus::", 3, { prefixCache: true });
  assert.ok(two instanceof Promise && three instanceof Promise);
  assert.equal(s.before("claude::sonnet::", 4, { prefixCache: true }), null, "another prefix has its own first");
  assert.equal(s.before("engine::m1::", 5, { prefixCache: false }), null, "without prefix cache: not delayed");
  assert.equal(s.before("engine::m1::", 6, { prefixCache: false }), null);
  assert.equal(await state(two), false);
  s.firstEvent(2); // an event of a NON-first releases nothing
  assert.equal(await state(two), false);
  s.firstEvent(1);
  assert.deepEqual(await Promise.all([two, three].map(state)), [true, true]);
  assert.equal(s.before("claude::opus::", 7, { prefixCache: true }), null, "after the first everyone starts at once");
  s.close();

  const without = createStagger({ ms: 0 });
  assert.equal(without.before("claude::opus::", 1, { prefixCache: true }), null);
  assert.equal(without.before("claude::opus::", 2, { prefixCache: true }), null, "deadline 0 (gate): no stagger");

  const to = createStagger({ ms: 3_600_000 });
  to.before("k", 1, { prefixCache: true });
  const waiting = to.before("k", 2, { prefixCache: true });
  to.end(1); // the first ends without an event (crash): the others do not wait any longer
  assert.equal(await state(waiting), true);
  to.close();
});
