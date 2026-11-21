// State of the project containers: table `project_instances` (store/project-instances.js), the setter with the
// `project/instance` event and the restart grace (projectbox/instances.js), and the `projectWork` field with `busy`,
// `quiet` and `open.projectInstances` on /api/runs/active (runs/routes.js).
//
// What holds here:
//   - Store: create with defaults; a change stamps `state_since` only for a new state; `desired` is JSON (broken ⇒ null);
//     a second key throws (UNIQUE); an unknown state throws; `converted` only with `converted_at`.
//   - Event: every change of state, phase or error is in the global stream — a change to other fields is not.
//   - Route: without a row `projectWork: []` and everything as before; `relocation` ⇒ `busy:true`, `quiet:false`; `ready`
//     and `error` ⇒ `busy:false`; the field is never missing and carries only ids, state, phase and `since` — no error text,
//     no path.
//   - Restart grace: a row in `create`/`start`/`recreate` without a living procedure becomes `error` with a reason, `busy`
//     falls; `relocation` stays; a row whose procedure lives in THIS process stays too.
//
// COUNTER-TESTS (each shown red):
//   runs/routes.js `|| projectWork.length > 0` removed from `busy`              ⇒ "Route …", both "Restart grace …" and
//     quiet.test.js "projectInstances …" red on busy
//   runs/routes.js `projectWork` removed from the response                      ⇒ "Route …" red (field missing)
//   server.js registration "project-instances" at the hook "restartGrace" removed      ⇒ "Restart grace …" hangs waiting for
//     `error` (no deadline — the suite deadline is the emergency brake; the wait line on stderr says what for)
//   projectbox/instances.js `if (procedureAlive(…)) continue;` removed                ⇒ "Restart grace in process …" red
//   projectbox/instances.js counter of the procedures replaced by `delete` (a set) ⇒ "Restart grace in process …" red
//     ("one is still alive")
//   projectbox/instances.js change comparison replaced by `if (after)`           ⇒ "Event …" red (network change reports)
//   store/project-instances.js state_since stamped on EVERY state argument       ⇒ "Store …" red
//   Outside this file: registration "project-instances" in store.js removed ⇒ tools/check/tree-rules.test.mjs (e)
//   red; `projectInstances: 0` in openWork ⇒ quiet.test.js "projectInstances …" red.
//
// No clock: waits are on states (`waitForTruthy` without deadline) and on the stream barrier.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as store from "../electron/server/store.js";
import { instancesRestartGrace, setInstanceState, withProcedure } from "../electron/server/projectbox/instances.js";
import { json, withAgentsServer } from "./agent-harness.mjs";
import { GLOBAL } from "./quiet.mjs";

const T0 = 1_790_000_000_000;
const FIELDS_WORK = ["instance", "phase", "projectId", "since", "state"];

async function active(base) { return json(`${base}/api/runs/active`); }

// A reader of the global stream (/api/events) — the same form as in quiet.test.js.
async function globalReaderFor(base) {
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal, headers: { Accept: "text/event-stream", Connection: "close" } });
  assert.equal(res.status, 200);
  const pump = (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split("\n")) if (line.startsWith("data: ")) { try { events.push(JSON.parse(line.slice(6))); } catch { /* partial line */ } }
        }
      }
    } catch { /* abort on close */ }
  })();
  return { events, async shutdown() { ac.abort(); await pump; } };
}

test("Store: create, change, desired, key collision, unknown state, converted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-project-instances-"));
  try {
    store.initStore(dir);
    assert.equal(store.instanceFor("p1"), null, "without a row: null (today's path)");
    assert.equal(store.converted("p1"), false);
    assert.deepEqual(store.projectInstances(), []);
    assert.deepEqual(store.projectInstancesInState([]), [], "an empty list yields []");

    const a = store.createProjectInstance({ projectId: "p1", state: "create", phase: "network", now: T0 });
    assert.equal(a.instance, "main", "stage 1: the main instance is the default");
    assert.equal(a.identifier, "p1/main");
    assert.equal(store.instanceIdentifier("p1"), "p1/main");
    assert.equal(a.state, "create");
    assert.equal(a.phase, "network");
    assert.equal(a.convertedAt, null);
    assert.equal(a.desired, null);
    assert.equal(a.chatId, null, "stage 2: empty for now");
    assert.equal(a.copyName, "");
    assert.equal(a.error, "");
    assert.equal(a.containerId, "");
    assert.deepEqual([a.stateSince, a.createdAt, a.updatedAt], [T0, T0, T0]);
    assert.deepEqual(store.instanceFor("p1"), a);

    // Key collision: the same (project, instance) a second time throws — another instance of the same project does not.
    assert.throws(() => store.createProjectInstance({ projectId: "p1", state: "start" }), (e) => store.isUniqueViolation(e));
    const copy = store.createProjectInstance({ projectId: "p1", instance: "copy-a", state: "create", now: T0 + 1 });
    assert.equal(copy.identifier, "p1/copy-a");
    assert.equal(store.instanceFor("p1").instance, "main", "instanceFor is the main instance in stage 1");

    // An unknown state throws, on create as on change — no silent state.
    assert.throws(() => store.createProjectInstance({ projectId: "p2", state: "running" }), /unknown state/);
    assert.throws(() => store.changeProjectInstance("p1", "main", { state: "running" }), /unknown state/);
    assert.throws(() => store.createProjectInstance({ projectId: "p2" }), /mandatory/);

    // Change: only a NEW state stamps state_since; every change stamps updated_at.
    const w1 = store.changeProjectInstance("p1", "main", { phase: "container", network: "cbase-p-p1", now: T0 + 10 });
    assert.equal(w1.prior.phase, "network");
    assert.equal(w1.after.phase, "container");
    assert.equal(w1.after.network, "cbase-p-p1");
    assert.equal(w1.after.stateSince, T0, "without a state change state_since stays");
    assert.equal(w1.after.updatedAt, T0 + 10);
    const w2 = store.changeProjectInstance("p1", "main", { state: "ready", now: T0 + 20 });
    assert.equal(w2.after.state, "ready");
    assert.equal(w2.after.stateSince, T0 + 20);
    const w3 = store.changeProjectInstance("p1", "main", { state: "ready", phase: "", now: T0 + 30 });
    assert.equal(w3.after.stateSince, T0 + 20, "the same state again is not a change");
    // `applied`: without a row nothing is applied.
    assert.deepEqual(store.changeProjectInstance("p9", "main", { state: "ready" }), { prior: null, after: null, applied: false });

    // desired: JSON there and back, replaced as a whole; broken JSON yields null, the row stays readable.
    const desired = { container: [{ name: "db", service: "db", state: "running", exitCode: null, depends_on: [] }], native: [], at: T0 };
    assert.deepEqual(store.changeProjectInstance("p1", "main", { desired }).after.desired, desired);
    assert.equal(store.changeProjectInstance("p1", "main", { desired: null }).after.desired, null);
    const raw = new DatabaseSync(path.join(dir, "automater.db"));
    try { raw.prepare("UPDATE project_instances SET desired = '{broken' WHERE project_id = 'p1' AND instance = 'main'").run(); }
    finally { raw.close(); }
    assert.equal(store.instanceFor("p1").desired, null);

    // converted: only with converted_at — the state alone converts nothing.
    assert.equal(store.converted("p1"), false, "ready without converted_at is not converted");
    store.changeProjectInstance("p1", "main", { convertedAt: T0 + 40 });
    assert.equal(store.converted("p1"), true);
    assert.equal(store.converted("p2"), false);

    assert.deepEqual(store.projectInstancesInState(store.PROJECT_WORK_STATES).map((z) => z.identifier), ["p1/copy-a"]);
    // `stop` is work (an unsecured step, holds `busy`), `stopped` is quiet.
    assert.deepEqual([...store.PROJECT_WORK_STATES], ["create", "start", "recreate", "relocation", "clearAway", "stop"]);
    assert.deepEqual([...store.PROJECT_STATES], ["create", "start", "ready", "recreate", "relocation", "clearAway", "error", "stop", "stopped"]);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Temp */ }
  }
});

test("Route: without a row as before; relocation ⇒ busy, ready and error ⇒ not busy; the field is never missing and carries only ids", async () => {
  await withAgentsServer(async ({ base }) => {
    const empty = await active(base);
    assert.deepEqual(empty.projectWork, [], "without a row: the field is there, empty");
    assert.equal(empty.busy, false);
    assert.equal(empty.quiet, true);
    assert.equal(empty.open.projectInstances, 0);
    try {
      setInstanceState("p-route", "main", "relocation", { phase: "stack-stop", network: "cbase-p-route" });
      const u = await active(base);
      assert.equal(u.busy, true, "a relocation stops deploy and reaper");
      assert.equal(u.quiet, false);
      assert.equal(u.open.projectInstances, 1);
      assert.equal(u.runs, 0, "no turn — busy comes from the instance alone");
      assert.equal(u.projectWork.length, 1);
      const [e] = u.projectWork;
      assert.deepEqual(Object.keys(e).sort(), FIELDS_WORK, "only ids, state, phase, since — no path, no error text");
      assert.deepEqual([e.projectId, e.instance, e.state, e.phase], ["p-route", "main", "relocation", "stack-stop"]);
      assert.equal(e.since, store.instanceFor("p-route").stateSince);

      for (const z of ["create", "start", "recreate"]) {
        setInstanceState("p-route", "main", z);
        const s = await active(base);
        assert.equal(s.busy, true, `${z} is an unsecured step`);
        assert.deepEqual(s.projectWork.map((x) => x.state), [z]);
      }

      setInstanceState("p-route", "main", "error", { error: "Probe: /home/agent/secret is broken" });
      const f = await active(base);
      assert.equal(f.busy, false, "error does not hold busy");
      assert.equal(f.quiet, true);
      assert.deepEqual(f.projectWork, []);
      assert.doesNotMatch(JSON.stringify(f), /secret/, "no error text on the unauthenticated route");

      setInstanceState("p-route", "main", "ready");
      const b = await active(base);
      assert.equal(b.busy, false);
      assert.equal(b.quiet, true);
      assert.deepEqual(b.projectWork, []);
      assert.equal(b.open.projectInstances, 0);
    } finally {
      // The harness waits for quiet in its finally — a row at work would hold it forever.
      setInstanceState("p-route", "main", "ready");
    }
  });
});

test("Event: every change of state, phase or error is in the global stream — other fields are not", async () => {
  await withAgentsServer(async ({ base, waitForTruthy, barrier }) => {
    const reader = await globalReaderFor(base);
    try {
      await waitForTruthy(() => reader.events.some((e) => e.type === "init"), "init of the global stream");
      const bar = await barrier(reader, GLOBAL);
      setInstanceState("p-ev", "main", "create", { phase: "network" });        // new ⇒ event
      setInstanceState("p-ev", "main", "create", { phase: "network", subnet: "10.231.1.0/24" }); // network only ⇒ none
      setInstanceState("p-ev", "main", "create", { phase: "container" });   // phase ⇒ event
      setInstanceState("p-ev", "main", "error", { error: "broken" });      // state ⇒ event
      setInstanceState("p-ev", "main", "error", { error: "broken otherwise" }); // error ⇒ event
      setInstanceState("p-ev", "main", "ready");                            // state, error cleared ⇒ event
      const until = await barrier(reader, GLOBAL);
      const ev = reader.events.slice(bar, until).filter((e) => e.type === "project/instance");
      assert.deepEqual(ev, [
        { type: "project/instance", projectId: "p-ev", instance: "main", state: "create", phase: "network", error: "" },
        { type: "project/instance", projectId: "p-ev", instance: "main", state: "create", phase: "container", error: "" },
        { type: "project/instance", projectId: "p-ev", instance: "main", state: "error", phase: "container", error: "broken" },
        { type: "project/instance", projectId: "p-ev", instance: "main", state: "error", phase: "container", error: "broken otherwise" },
        { type: "project/instance", projectId: "p-ev", instance: "main", state: "ready", phase: "container", error: "" },
      ]);
      assert.equal(store.instanceFor("p-ev").subnet, "10.231.1.0/24", "the network change is in the row all the same");
    } finally {
      setInstanceState("p-ev", "main", "ready");
      await reader.shutdown();
    }
  });
});

test("Restart grace in process: an instance with a LIVING procedure stays, without it becomes error — also after overlapping procedures", async () => {
  await withAgentsServer(async ({ base }) => {
    let resolve1, resolve2;
    const gate1 = new Promise((r) => { resolve1 = r; });
    const gate2 = new Promise((r) => { resolve2 = r; });
    try {
      setInstanceState("p-procedure", "main", "create", { phase: "container" });
      const a1 = withProcedure("p-procedure", "main", () => gate1);
      const a2 = withProcedure("p-procedure", "main", () => gate2);
      instancesRestartGrace();
      assert.equal(store.instanceFor("p-procedure").state, "create", "two procedures live — the row stays");
      resolve1();
      await a1;
      instancesRestartGrace();
      assert.equal(store.instanceFor("p-procedure").state, "create", "one is still alive — the end of the first does not take the marker along");
      assert.equal((await active(base)).busy, true);
      resolve2();
      await a2;
      instancesRestartGrace();
      const z = store.instanceFor("p-procedure");
      assert.equal(z.state, "error", "without a procedure the row is a leftover");
      assert.match(z.error, /Neustart des Servers während „create“ \(Phase „container“\)/);
      assert.equal(z.phase, "container", "the phase stays — it says where it broke off");
      assert.equal((await active(base)).busy, false);
    } finally {
      resolve1(); resolve2();
      setInstanceState("p-procedure", "main", "ready");
    }
  });
});

// A row straight into the database of the server process (with opts.childProcess the test does not share its module state; the
// harness read access db() is readOnly). Waits for the lock to free without a practical deadline, like db().
function writeRow(dataRoot, { projectId, state, phase = "" }) {
  const raw = new DatabaseSync(path.join(dataRoot, "data", "automater.db"), { timeout: 2_147_483_647 });
  try {
    const t = Date.now();
    raw.prepare(`INSERT INTO project_instances (project_id, instance, state, phase, state_since, created_at, updated_at)
      VALUES (?, 'main', ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, instance) DO UPDATE SET state = excluded.state, phase = excluded.phase, error = ''`)
      .run(projectId, state, phase, t, t, t);
  } finally { raw.close(); }
}

test("Restart grace after a hard restart: recreate and start without a procedure become error, busy falls; relocation stays", async () => {
  await withAgentsServer(async ({ base, dataRoot, waitForTruthy, crash, db }) => {
    const row = (projectId) => {
      const d = db();
      try { const r = d.prepare("SELECT state, phase, error FROM project_instances WHERE project_id = ? AND instance = 'main'").get(projectId); return r ? { ...r } : null; }
      finally { d.close(); }
    };
    writeRow(dataRoot, { projectId: "p-new", state: "recreate", phase: "image" });
    writeRow(dataRoot, { projectId: "p-quiet", state: "ready" });
    const prior = await active(base);
    assert.equal(prior.busy, true, "before the restart: recreate is work");
    assert.deepEqual(prior.projectWork.map((x) => x.projectId), ["p-new"]);

    await crash();
    const target = await waitForTruthy(async () => { const s = await active(base); return s.busy === false ? s : null; }, "busy falls after the restart grace");
    assert.deepEqual(target.projectWork, []);
    assert.equal(target.quiet, true);
    const fresh = row("p-new");
    assert.equal(fresh.state, "error");
    assert.match(fresh.error, /Neustart des Servers während „recreate“ \(Phase „image“\)/);
    assert.equal(row("p-quiet").state, "ready", "the restart grace does not touch ready");

    // Second restart: start becomes error, relocation stays — both in the SAME run of the hook (the "start" row is the
    // sign that it ran; there is no waiting on an absence).
    writeRow(dataRoot, { projectId: "p-start", state: "start", phase: "stack" });
    writeRow(dataRoot, { projectId: "p-relocation", state: "relocation", phase: "copy" });
    try {
      await crash();
      await waitForTruthy(() => row("p-start")?.state === "error", "start becomes error");
      assert.deepEqual(row("p-relocation"), { state: "relocation", phase: "copy", error: "" }, "the relocation journal decides the relocation");
      const s = await active(base);
      assert.equal(s.busy, true, "the relocation holds busy");
      assert.deepEqual(s.projectWork.map((x) => `${x.projectId}:${x.state}`), ["p-relocation:relocation"]);
    } finally {
      writeRow(dataRoot, { projectId: "p-relocation", state: "ready" });
    }
    assert.equal((await active(base)).busy, false);
  }, { childProcess: true });
});
