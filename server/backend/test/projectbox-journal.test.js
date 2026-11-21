// The journal of unsecured procedures: the sheet projectbox/journal.js, the storage store/project-relocations.js (schema
// register "project-relocations"), the decider hook in projectbox/instances.js and the location
// `<data>/relocations/<projectId>/<time>/` with `neverMounted` (projectbox/creation.js).
//
// What holds:
//   - BEFORE the effect: while an effect runs, its step is already announced (not done) in the storage, with the data that
//     went with it; afterwards done. Built-in sabotage: a journal that writes only after the effect turns the same check red.
//   - Decider: nothing announced or a step before the turn-around => backward from the first return-path step; the
//     turn-around (even only announced) and everything after => forward from the unconfirmed step; a begun return path
//     stays one. A journal with a foreign step is not guessed.
//   - Resuming: a process that dies in the middle of an effect leaves the announced step; the next repeats exactly it,
//     never a done one. An error before the turn-around runs the return path and throws `JournalTurned`; an error from the
//     turn-around on leaves the procedure standing forward.
//   - Storage: one open relocation per project; log per announcement and confirmation; dismantling keys ONLY as names (a
//     value from .env* throws); an unknown section throws; ended is read-only.
//   - `instancesRestartGrace` hands every half relocation without a living procedure to the decider (instance in `relocation`,
//     open journal without instance, instance in `create` WITH an open journal - it does not become `error`); without a
//     decider everything stays.
//   - Turning: `atTurnAround` runs BEFORE the first return-path step (after an error before the turn-around with step and
//     error, in the restart grace with cause "restartGrace"), never on a resumed return path; if it throws, no return-path
//     step takes effect. An error AT the turn-around with `turnaroundNotReached` runs the return path (never afterwards). If
//     the return path fails, `JournalReturnPathFailed` carries the original error.
//   - `relocationElsewhere` holds a new relocation back while another open journal is undecided or its procedure lives; the
//     mark hangs on id, location and creation time (another database with the same id is not decided);
//     `relocationResumeFailed` puts reason and way out on the row.
//   - Location: `relocationLocation` lets no id and no time lead out of the folder; `createRelocationLocation` creates 0700 and
//     refuses a level that is a symlink; `neverMounted` names `relocations` AND `copies` with everything below.
//
// COUNTER-TESTS (each shown red, then reverted):
//   projectbox/journal.js `step`: the writing of the announcement moved behind the effect => "Before the effect ..." red
//     (the same sabotage is BUILT IN below and must be red)
//   projectbox/journal.js `decide`: `<` swapped for `<=` at the turn-around                => "Decider ..." red
//   projectbox/journal.js `nextStep`: an unconfirmed step is skipped             => "Decider ..." and "Resuming ..." red
//   projectbox/instances.js without the decider hook                                      => "Restart grace ..." red (no hook)
//   projectbox/creation.js without `copies` in neverMounted                              => "Location ..." red
//   store/project-relocations.js without `checkDismantling`                              => "Storage ..." red (the value lands in
//     the database)
//   Outside this file: the registration "project-relocations" in store.js removed => tools/check/tree-rules.test.mjs and
//   schema-register.test.js red.
//
// No clock: only promises that the test itself resolves are awaited.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as store from "../electron/server/store.js";
import * as inst from "../electron/server/projectbox/instances.js";
import { neverMounted } from "../electron/server/projectbox/creation.js";
import {
  JournalTurned, JournalReturnPathFailed, RELOCATION_FOLDER, decide, createJournal, run, journalPlan, nextStep, relocationLocation, createRelocationLocation, relocationTime,
} from "../electron/server/projectbox/journal.js";

const PLAN = journalPlan({ forward: ["plan", "creation", "stop", "copy", "check", "remove"], backward: ["r-container", "r-row"], pivot: "check" });

// A storage in memory - like the table: `write` replaces the named fields, `data` per section.
function storageDeposit() {
  let state = null;
  const data = {};
  return {
    read: () => (state ? { ...state } : null),
    write: (f) => {
      const { data: d, ...rest } = f;
      if (d) Object.assign(data, d);
      if (Object.keys(rest).length) state = { ...(state || {}), ...rest };
    },
    data,
  };
}

// The promise "before the effect" as a list of violations - the same check against the real journal and the sabotage.
async function violationsBeforeTheEffect(factory) {
  const v = [];
  const deposit = storageDeposit();
  const j = factory(deposit);
  for (const [name, data] of [["plan", { plan: { n: 1 } }], ["creation", { insideIds: ["c1"] }], ["stop", undefined]]) {
    await j.step(name, async () => {
      const s = deposit.read();
      if (s?.step !== name) v.push(`${name}: during the effect "${s?.step ?? "nothing"}" is in the journal`);
      if (s?.done === name) v.push(`${name}: already done before the effect`);
      if (data) for (const k of Object.keys(data)) if (deposit.data[k] === undefined) v.push(`${name}: section ${k} written only after the effect`);
    }, { data });
    if (deposit.read()?.done !== name) v.push(`${name}: not done afterwards`);
  }
  return v;
}

test("Before the effect: the step is announced with its data BEFORE it takes effect - the built-in sabotage (writing afterwards) is red", async () => {
  assert.deepEqual(await violationsBeforeTheEffect(createJournal), []);
  // The sabotage: the same interface, but the announcement comes only after the effect.
  const afterwards = ({ read, write }) => ({
    snapshot: read,
    async step(name, effect, { direction = "forward", data } = {}) {
      const result = await effect();
      write({ direction, step: name, done: name, ...(data ? { data } : {}) });
      return result;
    },
  });
  const v = await violationsBeforeTheEffect(afterwards);
  assert.ok(v.some((x) => x.includes("during the effect")), `the sabotage went unnoticed: ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.includes("only after the effect")), `the data sabotage went unnoticed: ${JSON.stringify(v)}`);
});

test("Plan: names unique, both directions disjoint, the turn-around is a forward step", () => {
  assert.throws(() => journalPlan({ forward: ["a", "a"], pivot: "a" }), /duplicate/);
  assert.throws(() => journalPlan({ forward: ["a", "b"], backward: ["b"], pivot: "a" }), /both directions/);
  assert.throws(() => journalPlan({ forward: ["a"], backward: ["r"], pivot: "r" }), /no forward step/);
  assert.throws(() => journalPlan({ forward: ["A b"], pivot: "A b" }), /invalid step name/);
  assert.throws(() => journalPlan({ forward: [], pivot: "a" }), /list/);
  assert.ok(Object.isFrozen(PLAN) && Object.isFrozen(PLAN.forward));
});

test("Decider: backward before the turn-around, forward from the turn-around (even only announced); a return path stays one; foreign steps are not guessed", () => {
  const e = (state) => decide(PLAN, state);
  const R0 = { direction: "backward", from: "r-container" };
  assert.deepEqual(e(null), R0, "nothing announced: nothing took effect");
  assert.deepEqual(e({ direction: "forward", step: "", done: "" }), R0);
  for (const s of ["plan", "creation", "stop", "copy"]) {
    assert.deepEqual(e({ direction: "forward", step: s, done: "" }), R0, `${s} announced`);
    assert.deepEqual(e({ direction: "forward", step: s, done: s }), R0, `${s} done`);
  }
  assert.deepEqual(e({ direction: "forward", step: "check", done: "copy" }), { direction: "forward", from: "check" }, "turn-around announced: forward, repeated");
  assert.deepEqual(e({ direction: "forward", step: "check", done: "check" }), { direction: "forward", from: "remove" });
  assert.deepEqual(e({ direction: "forward", step: "remove", done: "check" }), { direction: "forward", from: "remove" });
  assert.deepEqual(e({ direction: "forward", step: "remove", done: "remove" }), { direction: "forward", from: null }, "finished");
  assert.deepEqual(e({ direction: "backward", step: "r-container", done: "" }), { direction: "backward", from: "r-container" });
  assert.deepEqual(e({ direction: "backward", step: "r-container", done: "r-container" }), { direction: "backward", from: "r-row" });
  assert.deepEqual(e({ direction: "backward", step: "r-row", done: "r-row" }), { direction: "backward", from: null });
  assert.throws(() => e({ direction: "forward", step: "new-in-v2", done: "" }), /not guessed/);
  assert.throws(() => e({ direction: "backward", step: "check", done: "" }), /not guessed/);
  assert.equal(nextStep(["a", "b"], { step: "a", done: "" }), "a");
  assert.equal(nextStep(["a", "b"], { step: "a", done: "a" }), "b");
});

// Effects that count and on request fail or hang (a process that dies in the middle of the effect).
function effects({ fails = null, hangs = null } = {}) {
  const called = [];
  const w = {};
  let reportHangs;
  const hangsReached = new Promise((r) => { reportHangs = r; });
  for (const n of [...PLAN.forward, ...PLAN.backward]) {
    w[n] = () => {
      called.push(n);
      if (n === fails) throw new Error(`${n} fails`);
      if (n === hangs) { reportHangs(); return new Promise(() => {}); } // the process dies here - the promise never completes
      return undefined;
    };
  }
  return { w, called, hangsReached };
}

test("Resuming: after a death in the middle of the effect exactly the unconfirmed step runs once more, never a done one", async () => {
  // Died after the turn-around: the next "process" resumes forward.
  const deposit = storageDeposit();
  const a = effects({ hangs: "remove" });
  void run(PLAN, createJournal(deposit), a.w, { fresh: true });
  await a.hangsReached;
  assert.deepEqual(deposit.read(), { direction: "forward", step: "remove", done: "check" });
  const b = effects();
  const result = await run(PLAN, createJournal(deposit), b.w);
  assert.deepEqual(result, { direction: "forward", run: ["remove"] });
  assert.deepEqual(b.called, ["remove"], "only the unconfirmed step, nothing before");
  assert.deepEqual(await run(PLAN, createJournal(deposit), effects().w), { direction: "forward", run: [] }, "finished is finished");

  // Died before the turn-around: the next "process" runs the return path, completely.
  const deposit2 = storageDeposit();
  const c = effects({ hangs: "copy" });
  void run(PLAN, createJournal(deposit2), c.w, { fresh: true });
  await c.hangsReached;
  assert.deepEqual(deposit2.read(), { direction: "forward", step: "copy", done: "stop" });
  const d = effects();
  assert.deepEqual(await run(PLAN, createJournal(deposit2), d.w), { direction: "backward", run: ["r-container", "r-row"] });
  assert.deepEqual(d.called, ["r-container", "r-row"]);

  // Died in the middle of the return path: it stays a return path and resumes at the unconfirmed step.
  const deposit3 = storageDeposit();
  deposit3.write({ direction: "backward", step: "r-row", done: "r-container" });
  const f = effects();
  assert.deepEqual(await run(PLAN, createJournal(deposit3), f.w), { direction: "backward", run: ["r-row"] });
});

test("Error: before the turn-around it turns back at once (JournalTurned, whole return path); from the turn-around the procedure stays standing forward", async () => {
  const deposit = storageDeposit();
  const a = effects({ fails: "stop" });
  await assert.rejects(run(PLAN, createJournal(deposit), a.w, { fresh: true }), (e) => e instanceof JournalTurned && e.step === "stop" && /stop fails/.test(e.cause?.message));
  assert.deepEqual(a.called, ["plan", "creation", "stop", "r-container", "r-row"]);
  assert.deepEqual(deposit.read(), { direction: "backward", step: "r-row", done: "r-row" });

  const deposit2 = storageDeposit();
  const b = effects({ fails: "check" });
  await assert.rejects(run(PLAN, createJournal(deposit2), b.w, { fresh: true }), /check fails/);
  assert.deepEqual(b.called, ["plan", "creation", "stop", "copy", "check"], "no return path from the turn-around");
  assert.deepEqual(decide(PLAN, deposit2.read()), { direction: "forward", from: "check" });
  await assert.rejects(run(PLAN, createJournal(deposit2), effects().w, { fresh: true }), /resume, do not begin anew/, "a begun procedure does not begin anew");
  const empty = effects();
  assert.deepEqual(await run(PLAN, createJournal(storageDeposit()), empty.w), { direction: "backward", run: ["r-container", "r-row"] }, "without fresh: an empty journal means return path (restart grace)");

  await assert.rejects(run(PLAN, createJournal(storageDeposit()), { plan: () => {} }), /no effect for/, "missing effects are reported before any effect");
});

test("Turning: atTurnAround before the first return-path step (error, restart grace), never on a resumed return path; if it throws, no return path; turnaroundNotReached only at the turn-around; a failed return path keeps the reason", async () => {
  // Error before the turn-around: step and error, BEFORE r-container takes effect.
  const a = effects({ fails: "stop" });
  const g1 = [];
  const bw1 = (w) => { g1.push({ step: w.step, error: w.error?.message ?? null, cause: w.cause, prior: [...a.called] }); };
  await assert.rejects(run(PLAN, createJournal(storageDeposit()), a.w, { fresh: true, atTurnAround: bw1 }), JournalTurned);
  assert.deepEqual(g1, [{ step: "stop", error: "stop fails", cause: "error", prior: ["plan", "creation", "stop"] }]);

  // Restart grace before the turn-around: cause "restartGrace", the interrupted step.
  const ab2 = storageDeposit();
  ab2.write({ direction: "forward", step: "copy", done: "stop" });
  const b = effects();
  const g2 = [];
  assert.deepEqual(await run(PLAN, createJournal(ab2), b.w, { atTurnAround: (w) => { g2.push({ ...w, prior: [...b.called] }); } }),
    { direction: "backward", run: ["r-container", "r-row"] });
  assert.deepEqual(g2, [{ step: "copy", error: null, cause: "restartGrace", prior: [] }]);

  // A resumed return path does not turn again (the earlier reason stays).
  const ab3 = storageDeposit();
  ab3.write({ direction: "backward", step: "r-row", done: "r-container" });
  const g3 = [];
  await run(PLAN, createJournal(ab3), effects().w, { atTurnAround: (w) => { g3.push(w); } });
  assert.deepEqual(g3, []);

  // atTurnAround throws (the reason cannot be written): no return-path step takes effect.
  const d = effects({ fails: "creation" });
  await assert.rejects(run(PLAN, createJournal(storageDeposit()), d.w, { fresh: true, atTurnAround: () => { throw new Error("the database does not write"); } }), /does not write/);
  assert.deepEqual(d.called, ["plan", "creation"]);
  await assert.rejects(run(PLAN, createJournal(storageDeposit()), effects().w, { atTurnAround: "yes" }), /atTurnAround/);

  // An error AT the turn-around with `turnaroundNotReached`: return path. Without the mark it stays (test "Error").
  const e = effects();
  e.w.check = () => { e.called.push("check"); throw Object.assign(new Error("container does not start"), { turnaroundNotReached: true }); };
  await assert.rejects(run(PLAN, createJournal(storageDeposit()), e.w, { fresh: true }), (x) => x instanceof JournalTurned && x.step === "check");
  assert.deepEqual(e.called.slice(-3), ["check", "r-container", "r-row"]);
  // After the turn-around the mark does not apply - there is no return path there.
  const f = effects();
  f.w.remove = () => { f.called.push("remove"); throw Object.assign(new Error("rm fails"), { turnaroundNotReached: true }); };
  await assert.rejects(run(PLAN, createJournal(storageDeposit()), f.w, { fresh: true }), (x) => !(x instanceof JournalTurned) && /rm fails/.test(x.message));
  assert.ok(!f.called.includes("r-container"), JSON.stringify(f.called));

  // The return path fails: the original error is not lost.
  const g = effects({ fails: "r-container" });
  g.w.stop = () => { g.called.push("stop"); throw new Error("origin"); };
  const ab7 = storageDeposit();
  await assert.rejects(run(PLAN, createJournal(ab7), g.w, { fresh: true }),
    (x) => x instanceof JournalReturnPathFailed && x.step === "stop" && x.origin?.message === "origin" && /r-container fails/.test(x.cause?.message) && /origin/.test(x.message));
  assert.equal(ab7.read().direction, "backward", "the return path stays one (the restart grace resumes it)");
});

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-journal-"));
  store.initStore(dir);
  try { return await fn(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }
}

test("Storage: one open relocation per project, log, sections, dismantling only with names, ended read-only - wired to the journal", async () => {
  await withStore(async () => {
    const u = store.createRelocation({ projectId: "p-1", location: "/d/relocations/p-1/x" });
    assert.deepEqual([u.direction, u.step, u.done, u.end, u.endedAt, u.log], ["forward", "", "", "", null, []]);
    assert.throws(() => store.createRelocation({ projectId: "p-1", location: "/d/y" }), (e) => store.isUniqueViolation(e), "second open relocation of the same project");
    assert.equal(store.openRelocation("p-1").id, u.id);

    // The journal over the table - the wiring the procedure uses.
    const j = createJournal({ read: () => store.readRelocation(u.id), write: (f) => store.writeRelocation(u.id, f) });
    const old = [{ id: "c1", restart: "always" }];
    await j.step("stop", () => {
      const z = store.readRelocation(u.id);
      assert.deepEqual([z.step, z.done, z.policies], ["stop", "", old], "before the effect in the table");
    }, { data: { policies: old } });
    await j.step("copy", () => {});
    const z = store.readRelocation(u.id);
    assert.deepEqual([z.step, z.done], ["copy", "copy"]);
    assert.deepEqual(z.log.map((p) => `${p.what}:${p.step}`), ["announced:stop", "done:stop", "announced:copy", "done:copy"]);

    // Dismantling keys: names only.
    const rb = [{ file: ".env", key: ["PORT", "NEXT_PUBLIC_URL"] }];
    assert.deepEqual(store.writeRelocation(u.id, { data: { dismantling: rb } }).dismantling, rb);
    for (const wrong of [
      [{ file: ".env", key: ["PORT=3100"] }],
      [{ file: ".env", key: ["PORT"], values: { PORT: "3100" } }],
      [{ file: ".env", key: ["secret password"] }],
      [{ file: "../outside/.env", key: ["PORT"] }],
      ["PORT=3100"],
    ]) {
      assert.throws(() => store.writeRelocation(u.id, { data: { dismantling: wrong } }), /dismantling/, JSON.stringify(wrong));
    }
    assert.deepEqual(store.readRelocation(u.id).dismantling, rb, "a rejected value is not in the table");
    assert.throws(() => store.writeRelocation(u.id, { data: { envValues: { PORT: "3100" } } }), /unknown section/);
    assert.throws(() => store.writeRelocation(u.id, { direction: "sideways" }), /direction/);

    assert.deepEqual(store.openRelocations().map((x) => x.id), [u.id]);
    const finished = store.endRelocation(u.id, "finished");
    assert.equal(finished.end, "finished");
    assert.ok(finished.endedAt > 0);
    assert.throws(() => store.writeRelocation(u.id, { step: "x" }), /ended/);
    assert.throws(() => store.endRelocation(u.id, "finished"), /no open/);
    assert.deepEqual(store.openRelocations(), []);
    const second = store.createRelocation({ projectId: "p-1", location: "/d/z" });
    assert.deepEqual(store.relocationsOf("p-1").map((x) => x.id), [u.id, second.id], "after the end the next may begin");
    assert.equal(store.deleteRelocation(second.id), 1);
  });
});

test("Restart grace hands every half relocation without a procedure to the decider; without a decider everything stays", async () => {
  assert.equal(typeof inst.setRelocationDecider, "function", "no hook for the relocation decider");
  await withStore(async () => {
    inst.setInstanceState("p-relocation", "main", "relocation", { phase: "images" });
    store.createRelocation({ projectId: "p-relocation", location: "/d/a" });
    store.createRelocation({ projectId: "p-early", location: "/d/b" }); // steps 1-2: no instance row yet
    inst.setInstanceState("p-creation", "main", "create", { phase: "container" }); // step 3
    store.createRelocation({ projectId: "p-creation", location: "/d/c" });
    inst.setInstanceState("p-alive", "main", "relocation");
    inst.setInstanceState("p-old", "main", "start"); // without journal: the old rule
    let resolve;
    const alive = inst.withProcedure("p-alive", "main", () => new Promise((r) => { resolve = r; }));

    // Without a decider: leave it, busy holds.
    inst.setRelocationDecider(null);
    inst.instancesRestartGrace();
    assert.equal(store.instanceFor("p-relocation").state, "relocation");
    assert.equal(store.instanceFor("p-creation").state, "create", "a relocation's creation belongs to the journal, not to the rule \"error\"");
    assert.equal(store.instanceFor("p-old").state, "error", "without a journal the old rule still applies");

    const seen = [];
    inst.setRelocationDecider((e) => { seen.push({ k: `${e.projectId}/${e.instance}`, row: e.row?.state ?? null, journal: e.journal?.location ?? null }); return Promise.reject(new Error("logged, not thrown")); });
    try {
      inst.instancesRestartGrace();
      seen.sort((x, y) => x.k.localeCompare(y.k));
      assert.deepEqual(seen, [
        { k: "p-creation/main", row: "create", journal: "/d/c" },
        { k: "p-early/main", row: null, journal: "/d/b" },
        { k: "p-relocation/main", row: "relocation", journal: "/d/a" },
      ], "p-alive is missing: its procedure lives");
      assert.equal(store.instanceFor("p-creation").state, "create");
    } finally {
      inst.setRelocationDecider(null);
      resolve();
      await alive;
    }
  });
});

test("Location: relocations/<projectId>/<time>, nothing leads out; 0700, no symlink level; neverMounted names relocations and copies", () => {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cbase-relocation-location-")));
  try {
    const time = relocationTime(Date.UTC(2026, 8, 29, 15, 30, 12, 7));
    assert.equal(time, "20260929-153012-007");
    assert.equal(relocationLocation({ data, projectId: "p-1", time }), path.join(data, RELOCATION_FOLDER, "p-1", time));
    for (const [projectId, z] of [["..", time], ["a/b", time], ["", time], ["p-1", "../x"], ["p-1", "20260929"]]) {
      assert.throws(() => relocationLocation({ data, projectId, time: z }), /invalid/, `${projectId} ${z}`);
    }
    assert.throws(() => relocationLocation({ data: "rel", projectId: "p", time }), /absolute/);

    const location = createRelocationLocation({ data, projectId: "p-1", time });
    assert.equal(fs.statSync(location).mode & 0o777, 0o700);
    // A level as a symlink (here the project): refused, nothing created below.
    const foreign = path.join(data, "foreign");
    fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(data, RELOCATION_FOLDER, "p-2"));
    assert.throws(() => createRelocationLocation({ data, projectId: "p-2", time }), /not a folder/);

    const flat = { scratch: "/f/s", attachments: "/f/a", outputs: "/f/o", playwrightConfigs: "/f/pc", playwrightProfiles: "/f/pp", browserProfiles: "/f/b", serviceLogs: "/f/l" };
    const never = neverMounted({ home: "/h", data: "/h/cbase/data", flat });
    for (const n of [RELOCATION_FOLDER, "copies"]) {
      const e = never.find((x) => x.path === path.join("/h/cbase/data", n));
      assert.ok(e, `${n} is missing in neverMounted`);
      assert.equal(e.below, true, `${n}: nothing below either`);
    }
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("An open journal of another project holds a new relocation back until decided or while its procedure lives; a failed resume stands with its way out on the row", async () => {
  let id = null;
  await withStore(async () => {
    const a = store.createRelocation({ projectId: "p-a", location: "/d/itself5" });
    id = a.id;
    assert.equal(inst.relocationElsewhere("p-a"), null, "the own journal does not count here (RELOCATION_OPEN exists for that)");
    assert.deepEqual(inst.relocationElsewhere("p-b"), { projectId: "p-a", instance: "main", relocationId: a.id, step: null, direction: "forward", reason: "restart-grace-pending" });
    assert.match(inst.relocationElsewhereText(inst.relocationElsewhere("p-b")), /\/api\/projects\/p-a\/relocation\/resume/);
    inst.relocationDecided(a.id, "p-a");
    assert.equal(inst.relocationElsewhere("p-b"), null, "decided and without a procedure: free - the half one is named, it does not lock for ever");
    let resolve;
    const alive = inst.withProcedure("p-a", "main", () => new Promise((r) => { resolve = r; }));
    assert.equal(inst.relocationElsewhere("p-b")?.reason, "running");
    resolve();
    await alive;

    inst.setInstanceState("p-a", "main", "relocation", { phase: "networks" });
    inst.relocationResumeFailed("p-a", "main", new Error("heavy load gone"));
    const z = store.instanceFor("p-a");
    assert.deepEqual([z.state, z.phase], ["relocation", "hold-resume"]);
    assert.match(z.error, /heavy load gone.*\/api\/projects\/p-a\/relocation\/resume/);
    assert.match(inst.relocationResumeError("p-a")?.text || "", /heavy load gone/);
    inst.relocationDecided(a.id, "p-a");
    assert.equal(inst.relocationResumeError("p-a"), null, "a new attempt takes away the old reason");
  });
  // Another database, the same id: not decided (the mark does not hang on the id alone).
  await withStore(async () => {
    const a2 = store.createRelocation({ projectId: "p-a", location: "/d/itself5-two" });
    assert.equal(a2.id, id);
    assert.equal(inst.relocationElsewhere("p-b")?.reason, "restart-grace-pending");
  });
});
