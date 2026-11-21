// The progress of a copy being built (projectbox/copy-progress.js) — the "Active runs" pill (field `copies` at GET /api/active-runs) and the
// "Instances" tab (field `progress` in the tree) show it.
//
//   (1) The phases and journal steps stand here a second time — bound to the source: `BUILD_PHASES` to store `STACK_COPY_PHASES.build`,
//       `JOURNAL_STEPS` to the order of the `journal.step("…")` calls in stacks/build.js.
//   (2) Waiting: step 0, no estimate. In the build without a finished predecessor: the step from the phase, NO estimate (never an
//       invented number).
//   (3) With a predecessor (durations measured on ORBIT): share and remaining time from its steps; in the start the stage.
//   (4) If a step runs longer than back then, the bar stays just below its end (`overrun`, remainder 0) — never full.
//   (5) A predecessor with the same base goes first; a dismantled or incomplete one does not count.
//   (6) A rebuild after going back into the queue does NOT inherit the old clock — with the REAL sequence of both paths (restart via
//       stacks/queue.js copiesRestartGrace with the real dismantling stacks/dismantling.js; BUILD-5: the writes of the failing freeze, then
//       stacks/build.js backAfterServerEnd), the real setter and the real journal (stacks/state.js copyJournal) under a mock clock
//       (`t.mock.timers`, Date only). The progress starts at the new attempt (step, start, share, remainder), and only its last attempt
//       counts as a predecessor. (6b) the same on the pure computation, plus: a predecessor with a dismantling section but without a
//       separator (a second attempt from before) does not count.
//   (7) store `stackCopiesFinishedBuilt` — only finished builds (also removed ones), without its own, same base first, the newest,
//       capped; a broken journal carries nothing. `progressOf` reads only through it, a waiting copy not at all.
//   (8) The route: `copies` next to `items`, with project, workspace and progress from the store (stage from the instance row);
//       `counts` stays the count of the runs.
// Counter-tests (which sabotage turns which test red): without `CAP_IN_STEP` (the share grows with the time in the step) => (4) red at
// share 0.97; without the preference for the same base => (5) red at the estimate. copy-progress.js without the separator handling =>
// (6) red on BOTH paths at the start, (6b) red (the predecessor with a dismantling counted), (7) red (no capped reading);
// store/stack-copies.js without the separator (only the condition in changeStackCopy disabled) => (6) red on both paths (no
// `fresh_start` on entering the build).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import * as store from "../electron/server/store.js";
import * as copyProgressModule from "../electron/server/projectbox/copy-progress.js";
import { BUILD_PHASES, JOURNAL_STEPS, progressOf, copyProgress, stepDurations } from "../electron/server/projectbox/copy-progress.js";
import { backAfterServerEnd } from "../electron/server/stacks/build.js";
import { copiesRestartGrace, setCopyDismantling } from "../electron/server/stacks/queue.js";
import { dismantleCopy } from "../electron/server/stacks/dismantling.js";
import { copyRequests, copyJournal, setCopyState } from "../electron/server/stacks/state.js";
import { json, withAgentsServer, projectWithoutInstance, waitForTruthy } from "./agent-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A journal of step durations (ms), starting at `t0`; `until` = the step that is still running (announced, not done).
function journal(durations, t0, { until = null, direction = "forward" } = {}) {
  const log = [];
  let t = t0;
  for (const s of JOURNAL_STEPS) {
    log.push({ direction, step: s, what: "announced", at: t });
    if (s === until) break;
    t += durations[s];
    log.push({ direction, step: s, what: "done", at: t });
    t += 10;
  }
  return { direction, step: until || "ready", log };
}
// Measured on ORBIT (copy "test"): 312 s, 2.6 s, 4.4 s, 68.8 s, 0.1 s.
const ORBIT = { freeze: 312_368, creation: 2_606, prepare: 4_400, start: 68_759, ready: 81 };
const TOTAL = Object.values(ORBIT).reduce((a, b) => a + b, 0);

test("(1) BUILD_PHASES == store STACK_COPY_PHASES.build, JOURNAL_STEPS == the steps in stacks/build.js", () => {
  assert.deepEqual([...BUILD_PHASES], [...store.STACK_COPY_PHASES.build]);
  const source = fs.readFileSync(path.join(HERE, "../electron/server/stacks/build.js"), "utf8");
  const steps = [...source.matchAll(/journal\.step\("([a-z]+)"/g)].map((m) => m[1]).filter((s) => s !== "dismantling");
  assert.deepEqual(steps, [...JOURNAL_STEPS]);
});

test("(2) waiting: step 0 without an estimate; in the build without a predecessor: step from the phase, no number", () => {
  const w = copyProgress({ state: "waiting_storage", phase: "", requestedAt: 1000 }, { now: 5000 });
  assert.deepEqual(w, { kind: "waiting", reason: "storage", step: 0, steps: 6, phase: "", begin: 1000, stage: null, share: null, restMs: null, estimateMs: null, overrun: false });
  assert.equal(copyProgress({ state: "waiting_queue", requestedAt: 1 }).reason, "queue");

  const k = { state: "build", phase: "clone2", requestedAt: 1000, journal: journal(ORBIT, 2000, { until: "freeze" }) };
  const a = copyProgress(k, { previous: [], now: 60_000 });
  assert.equal(a.kind, "create");
  assert.equal(a.step, 3);
  assert.equal(a.begin, 2000, "begin is the first step of the journal, not the request");
  assert.equal(a.share, null);
  assert.equal(a.restMs, null);

  for (const z of ["ready", "error", "clearAway", "removed"]) assert.equal(copyProgress({ state: z, phase: "" }), null, z);
  assert.equal(copyProgress({ state: "build", phase: "unknown", journal: null }).step, 0);
});

test("(3) with a predecessor: share and remainder from its steps; in the start the stage of the instance row", () => {
  const previous = [{ baseInstance: "main", journal: journal(ORBIT, 0) }];
  // 150 s in the clone: 150 / 388 ≈ 0.387, remainder ≈ 238 s.
  const k = { state: "build", phase: "clone1", baseInstance: "main", requestedAt: 0, journal: journal(ORBIT, 10_000, { until: "freeze" }) };
  const a = copyProgress(k, { previous, now: 160_000 });
  assert.equal(a.step, 1);
  assert.equal(a.share, Math.round((150_000 / TOTAL) * 1000) / 1000);
  assert.equal(a.restMs, TOTAL - 150_000);
  assert.equal(a.estimateMs, TOTAL);
  assert.equal(a.overrun, false);

  // In the start, 30 s in: before = freeze + creation + prepare.
  const t0 = 10_000;
  const kStart = { state: "build", phase: "start", baseInstance: "main", journal: journal(ORBIT, t0, { until: "start" }) };
  const startSince = kStart.journal.log.at(-1).at;
  const s = copyProgress(kStart, { previous, instancePhase: "stage 2/3", now: startSince + 30_000 });
  const before = ORBIT.freeze + ORBIT.creation + ORBIT.prepare;
  assert.equal(s.step, 6);
  assert.deepEqual(s.stage, { seq: 2, from: 3 });
  assert.equal(s.share, Math.round(((before + 30_000) / TOTAL) * 1000) / 1000);
  assert.equal(s.restMs, TOTAL - before - 30_000);
  assert.equal(copyProgress({ ...kStart, phase: "creation" }, { previous, instancePhase: "stage 2/3" }).stage, null, "the stage applies only in the start");
});

test("(4) a step longer than back then: the bar stays just below its end, remainder 0, `overrun`", () => {
  const previous = [{ baseInstance: "main", journal: journal(ORBIT, 0) }];
  const k = { state: "build", phase: "clone1", baseInstance: "main", journal: journal(ORBIT, 0, { until: "freeze" }) };
  const a = copyProgress(k, { previous, now: ORBIT.freeze * 3 });
  assert.equal(a.share, Math.round(((ORBIT.freeze * 0.95) / TOTAL) * 1000) / 1000);
  assert.ok(a.share < 0.97);
  assert.equal(a.restMs, 0);
  assert.equal(a.overrun, true);
});

test("(5) the same base goes first; dismantled or incomplete does not count", () => {
  const half = { freeze: 10_000, creation: 1_000, prepare: 1_000, start: 8_000, ready: 0 };
  const previous = [
    { baseInstance: "main", journal: journal(half, 0) }, // the NEWEST, but another base
    { baseInstance: "copy-k1", journal: journal(ORBIT, 0) },
  ];
  const k = { state: "build", phase: "clone1", baseInstance: "copy-k1", journal: journal(ORBIT, 0, { until: "freeze" }) };
  assert.equal(copyProgress(k, { previous, now: 1000 }).estimateMs, TOTAL);

  const back = journal(ORBIT, 0);
  back.log.push({ direction: "backward", step: "dismantling", what: "announced", at: 999_999 });
  assert.equal(stepDurations(back), null);
  assert.equal(stepDurations(journal(ORBIT, 0, { until: "start" })), null);
  assert.equal(stepDurations(null), null);
  assert.equal(copyProgress({ ...k, baseInstance: "main" }, { previous: [{ baseInstance: "main", journal: back }], now: 1000 }).share, null);
});

// ── (6) and (7) — BEFORE the first server: afterwards the queue waker and build procedure of server.js hang on the module (setQueueWakeup,
// setCopyProcedure), and the queue would at once build the deferred copy again ─────────────────────────────────────────────────────────

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-copy-progress-"));
  try {
    store.initStore(dir);
    return await fn(dir);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Temp */ }
  }
}

const shareOf = (ms, total) => Math.round((ms / total) * 1000) / 1000;
const sum = (d) => JOURNAL_STEPS.reduce((s, x) => s + d[x], 0);

// The steps of an attempt from `from`, as stacks/build.js copyBuild runs them: set the phase, `journal.step` with the effect —
// here it only advances the mock clock by the duration; "ready" sets the state via the real setter (the instance row becomes ready).
async function runSteps(t, id, durations, fromIdx = "freeze") {
  const journal = copyJournal(id);
  for (const s of JOURNAL_STEPS.slice(JOURNAL_STEPS.indexOf(fromIdx))) {
    if (["creation", "prepare", "start"].includes(s)) setCopyState(id, "build", { phase: s });
    await journal.step(s, () => {
      t.mock.timers.tick(durations[s]);
      if (s === "ready") setCopyState(id, "ready", { result: {} });
    });
  }
}

// Request a copy and begin its build like the queue (stacks/queue.js start: `build`/`clone1`, reason empty).
function begin(pid, name) {
  const k = copyRequests({ projectId: pid, name });
  setCopyState(k.id, "build", { phase: "clone1", reason: "" });
  return k;
}

// The first attempt announces "freeze" — and dies in it: the effect never ends (the process ends, not it).
function freezeBegun(id) {
  copyJournal(id).step("freeze", () => new Promise(() => {}));
}

const WAYS = {
  // W15: the process ended in the middle of the freeze; the restart dismantles and puts the copy back in its old place.
  async w15(k) {
    setCopyDismantling(dismantleCopy);
    try {
      assert.equal(copiesRestartGrace(), 1);
      await waitForTruthy(() => {
        const z = store.stackCopy(k.id).state;
        if (z !== "build" && z !== "waiting_queue") throw new Error(`W15: ${k.name} stands in "${z}" instead of back in the queue`);
        return z === "waiting_queue" ? true : null;
      }, `${k.name} back in the queue (W15)`);
    } finally { setCopyDismantling(null); }
    assert.ok(store.stackCopy(k.id).journal.data.dismantling, "W15: the dismantling wrote its section (only `note`)");
  },
  // BUILD-5: the freeze failed at server end and dismantled itself (stacks/freeze.js: the clone dismantling takes the instance row LAST,
  // then `error` with an announced way back) — the build puts the copy back into the queue.
  async build5(k) {
    const instance = `copy-${k.name}`;
    store.deleteProjectInstance(k.projectId, instance);
    setCopyState(k.id, "error", { error: "pause: server end" }, { returnPathAtServerEnd: true });
    const z = backAfterServerEnd(store.stackCopy(k.id), instance, { dismantled: true }, "freeze");
    assert.equal(z.state, "waiting_queue");
    assert.equal(store.stackCopy(k.id).journal.data.dismantling, undefined, "BUILD-5 leaves no dismantling section in the journal");
  },
};

for (const [way, back] of Object.entries(WAYS)) {
  test(`(6) ${way}: after going back into the queue the progress starts at the new attempt, and only its last one counts as a predecessor`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    await withStore(async () => {
      const pid = `p-${way}`;
      // The older predecessor: an attempt with the ORBIT durations — a first attempt carries no separator.
      const old = begin(pid, "old");
      await runSteps(t, old.id, ORBIT);
      assert.equal(store.stackCopy(old.id).state, "ready");
      assert.ok(!store.stackCopy(old.id).journal.log.some((p) => p.what === store.STACK_COPY_FRESH_START));

      // The first attempt: the deploy hits it 200 s into the freeze.
      t.mock.timers.tick(60_000);
      const k = begin(pid, "k");
      const beforeTheDeploy = Date.now();
      freezeBegun(k.id);
      t.mock.timers.tick(200_000);
      await back(k);

      // The new attempt, as queue and build begin it.
      t.mock.timers.tick(120_000);
      setCopyState(k.id, "build", { phase: "clone1", reason: "" });
      const fresh = Date.now();
      const logPrior = store.stackCopy(k.id).journal.log;
      assert.deepEqual(logPrior.at(-1), { step: "", what: store.STACK_COPY_FRESH_START, at: fresh }, "entering the build separates");
      let freezeFinished = null;
      let enter = null;
      const effectRunning = new Promise((r) => { enter = r; });
      const freeze = copyJournal(k.id).step("freeze", () => new Promise((r) => { freezeFinished = r; enter(); }));
      assert.deepEqual(store.stackCopy(k.id).journal.log, logPrior,
        "the precondition of B1: the state already carried \"freeze\" — the announcement of the new attempt writes NO row");

      t.mock.timers.tick(10_000);
      const f = progressOf(store.stackCopy(k.id));
      assert.equal(f.kind, "create");
      assert.equal(f.step, 1);
      assert.equal(f.begin, fresh, `begin is the new attempt, not ${beforeTheDeploy} (before the deploy)`);
      assert.equal(f.overrun, false, "10 s in the new attempt is not \"longer than last time\"");
      assert.equal(f.share, shareOf(10_000, TOTAL));
      assert.equal(f.restMs, TOTAL - 10_000);

      // The new attempt runs to the end — faster than the older predecessor, so that the estimate shows which one counts.
      const fast = { freeze: 100_000, creation: 2_000, prepare: 3_000, start: 40_000, ready: 50 };
      t.mock.timers.tick(fast.freeze - 10_000);
      await effectRunning;
      freezeFinished();
      await freeze;
      await runSteps(t, k.id, fast, "creation");
      assert.equal(store.stackCopy(k.id).state, "ready");
      assert.deepEqual(stepDurations(store.stackCopy(k.id).journal), fast, "only the last attempt: \"freeze\" counts from the separator");

      // The next copy: its estimate comes from the last attempt of the newest predecessor — not from 420 s of freeze (200 s
      // before the deploy, 120 s pause, 100 s new), not from the older one.
      t.mock.timers.tick(30_000);
      const n = begin(pid, "n");
      freezeBegun(n.id);
      t.mock.timers.tick(10_000);
      const g = progressOf(store.stackCopy(n.id));
      assert.equal(g.estimateMs, sum(fast));
      assert.equal(g.share, shareOf(10_000, sum(fast)));
      assert.equal(g.overrun, false);
    });
  });
}

test("(6b) a predecessor with a dismantling but without a separator (a second attempt from before) does not count; with a separator only its last attempt", () => {
  const second = journal(ORBIT, 0);
  second.data = { dismantling: { reason: "restart", removed: [], error: [], stayed: [] } };
  assert.equal(stepDurations(second), null);
  const separated = { ...second, log: [...second.log, { step: "", what: store.STACK_COPY_FRESH_START, at: 1_000_000 }, ...journal(ORBIT, 1_000_010).log] };
  assert.deepEqual(stepDurations(separated), ORBIT);
  // After the separator the announcement of "freeze" is missing (the state already carried it): it counts from the separator (10 ms before).
  const advanceNotice = second.log.length + 1;
  assert.deepEqual(separated.log[advanceNotice], { direction: "forward", step: "freeze", what: "announced", at: 1_000_010 });
  const withoutAdvanceNotice = { ...separated, log: separated.log.filter((_, i) => i !== advanceNotice) };
  assert.equal(stepDurations(withoutAdvanceNotice).freeze, ORBIT.freeze + 10);
});

test("(7) stackCopiesFinishedBuilt — only finished builds (also removed ones), without its own, same base first, the newest, capped", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  return withStore((dir) => {
    const pid = "p-b2";
    const finished = (name, { baseInstance = "main", state = "ready", projectId = pid } = {}) => {
      t.mock.timers.tick(1_000);
      const k = store.createStackCopy({ projectId, name, baseInstance, state: "build", phase: "clone1" });
      for (const s of JOURNAL_STEPS) {
        store.writeStackCopyJournal(k.id, { direction: "forward", step: s });
        t.mock.timers.tick(100);
        store.writeStackCopyJournal(k.id, { direction: "forward", step: s, done: s });
      }
      store.changeStackCopy(k.id, { state });
      return k;
    };
    const neverBuilt = (name, state) => {
      t.mock.timers.tick(1_000);
      const k = store.createStackCopy({ projectId: pid, name, state: "build", phase: "clone1" });
      store.writeStackCopyJournal(k.id, { direction: "forward", step: "freeze" });
      store.writeStackCopyJournal(k.id, { direction: "backward", step: "dismantling" });
      store.changeStackCopy(k.id, { state });
      return k;
    };
    finished("a");
    finished("v", { baseInstance: "copy-a" });
    const e = finished("e", { state: "removed" });
    neverBuilt("f", "error");
    neverBuilt("x", "removed");
    t.mock.timers.tick(1_000);
    store.createStackCopy({ projectId: pid, name: "w" }); // waiting, no journal
    finished("z");
    const broken = finished("broken");
    finished("a", { projectId: "p-different" });
    // A journal that is no JSON carries nothing — and does not break the query.
    const raw = new DatabaseSync(path.join(dir, "automater.db"));
    try { raw.prepare("UPDATE stack_copies SET journal = '[' WHERE id = ?").run(broken.id); } finally { raw.close(); }
    assert.equal(store.stackCopy(broken.id).journal, null);

    const names = (list) => list.map((k) => k.name);
    assert.deepEqual(names(store.stackCopiesFinishedBuilt(pid, { baseInstance: "main", limit: 10 })), ["z", "e", "a", "v"],
      "only finished builds, also the removed one; same base first, the newest within it; never-built, waiting, broken and foreign ones not");
    assert.deepEqual(names(store.stackCopiesFinishedBuilt(pid, { baseInstance: "copy-a", limit: 10 })), ["v", "z", "e", "a"]);
    assert.deepEqual(names(store.stackCopiesFinishedBuilt(pid, { withoutId: e.id, baseInstance: "main", limit: 2 })), ["z", "a"], "without its own, capped");
    assert.deepEqual(names(store.stackCopiesFinishedBuilt("p-empty")), []);

    // progressOf reads the predecessors through this query, capped at PREDECESSORS_MAX — a waiting copy not at all.
    const read = [];
    const k = store.createStackCopy({ projectId: pid, name: "fresh", state: "build", phase: "clone1" });
    store.writeStackCopyJournal(k.id, { direction: "forward", step: "freeze" });
    const real = store.stackCopiesFinishedBuilt;
    const f = progressOf(store.stackCopy(k.id), { now: Date.now() + 1_000, read: (...a) => { read.push(a); return real(...a); } });
    assert.ok(f.estimateMs !== null, "estimated from a finished predecessor");
    assert.equal(copyProgressModule.PREDECESSORS_MAX, 5);
    assert.deepEqual(read, [[pid, { withoutId: k.id, baseInstance: "main", limit: copyProgressModule.PREDECESSORS_MAX }]]);
    read.length = 0;
    assert.equal(progressOf(store.stackCopy(store.createStackCopy({ projectId: pid, name: "w2" }).id), { read: (...a) => { read.push(a); return []; } }).kind, "waiting");
    assert.deepEqual(read, [], "a waiting copy reads no predecessors");
  });
});

test("(8) GET /api/active-runs: `copies` next to `items`, with project, workspace and progress; `counts` untouched", async () => {
  await withAgentsServer(async (ctx) => {
    const p = projectWithoutInstance({ workspaceId: ctx.ws.id, name: "Copyable", path: path.join(ctx.root, "workspace", "copyable") });
    const finished = store.createStackCopy({ projectId: p.id, name: "old", state: "build", phase: "clone1" });
    for (const s of JOURNAL_STEPS) {
      store.writeStackCopyJournal(finished.id, { direction: "forward", step: s });
      store.writeStackCopyJournal(finished.id, { direction: "forward", step: s, done: s });
    }
    store.changeStackCopy(finished.id, { state: "ready" });
    const waiting = store.createStackCopy({ projectId: p.id, name: "w1", state: "waiting_storage" });
    const inStart = store.createStackCopy({ projectId: p.id, name: "s1", state: "build", phase: "start" });
    store.createProjectInstance({ projectId: p.id, instance: "copy-s1", state: "create", phase: "stage 1/3" });
    // An instance row in `create` is open work (runs/routes.js openWork `projectInstances`) — without clearing away, the end of the
    // harness (waitForQuiet) would wait for it, without a deadline.
    try {
      await check(ctx, p, waiting, inStart);
    } finally {
      store.deleteProjectInstance(p.id, "copy-s1");
    }
  });
});

async function check(ctx, p, waiting, inStart) {
  {
    const view = await json(`${ctx.base}/api/active-runs`);
    assert.deepEqual(view.counts, { total: 0, running: 0, waiting: 0, ask: 0, limit: 0 }, "a copy is no run");
    assert.deepEqual(view.items, []);
    assert.deepEqual(view.copies.map((k) => k.id), [`copy:${waiting.id}`, `copy:${inStart.id}`], "only waiting and arising ones, in request order");
    const [w, s] = view.copies;
    assert.equal(w.name, "w1");
    assert.equal(w.instance, "copy-w1");
    assert.equal(w.projectId, p.id);
    assert.equal(w.projectName, "Copyable");
    assert.equal(w.workspaceId, ctx.ws.id);
    assert.ok(w.workspaceName);
    assert.equal(w.progress.kind, "waiting");
    assert.equal(w.progress.reason, "storage");
    assert.equal(s.state, "build");
    assert.equal(s.progress.step, 6);
    assert.deepEqual(s.progress.stage, { seq: 1, from: 3 });
  }
}
