// `busy`, `projectWork` and the delete lock of a copy under construction, and the counts `copies`/`copiesWaiting` on
// `/api/runs/active`.
//
// What holds here (through the real route, a project from POST /api/workspaces/:wid/projects, the build a steerable
// placeholder):
//   - waiting does NOT hold a copy `busy` (no instance row, no work); `copies`/`copiesWaiting` count it;
//   - from the FIRST step of the build (`clone1`) `busy` is true: the instance row `copy-<name>` stands in the same step in
//     `create`, plus the heavy load "copy-clone" in `projectWork`; likewise in `freeze` (the main pauses, the copy has no
//     container yet); in `creation` the heavy load is free and `busy` holds through the instance row ALONE — the deploy gate
//     and the idle reaper read the same field;
//   - DELETE of the project is 409 and names instance, state and phase — never a value (the fallback is WITHOUT the copy
//     step: the test removes `setCopyDeleteStep` for its duration — with it the first DELETE would start the clearing and
//     the copy would be gone after `ready`; the copy step is held by stacks-remove.test.js (5));
//   - `ready` is no work (`busy` false, `copies` 1); `removed` no longer counts.
//   - The fields `copies`/`copiesWaiting` ALWAYS stand, even 0 (a missing field means "unknown" to the deploy).
//   - An ORPHANED build (after a restart the hook "project-instances" sets the instance row to `error`, `busy` falls) counts
//     in `copiesWaiting` — before, during and after the restart dismantling; otherwise the idle reaper would put B to sleep in
//     the middle of the dismantling (server/gateway/containers.js busyFrom reads the number).
//
// COUNTER-PROOF: runs/routes.js `copiesWaiting` without the orphaned build (only `waiting_*`) ⇒ the second test goes red
// ("after the hook project-instances: copiesWaiting 0").
// COUNTER-PROOF: stacks/state.js coupleInstance creates the instance row only at the transition to the phase "creation" ⇒ red ("the instance row is missing in clone1"; `busy` would then
// hold in `clone1` and `freeze` only through the heavy load). The delete lock stays 409 — it carries the stack_copies row
// itself; what turns red here is the work in `projectWork`, the actual promise.
//
// No clock: the build holds at three gates in memory (promises), the tick of the queue is set to one day, the one pass is a
// call of the test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { instancesRestartGrace } from "../electron/server/projectbox/instances.js";
import { setCopyDeleteStep } from "../electron/server/projectbox/erase.js";
import { copyDeleteStep } from "../electron/server/stacks/remove.js";
import { buildAlive, copiesRestartGrace, setCopyProcedure, setCopyDismantling } from "../electron/server/stacks/queue.js";
import { copyRequests, setCopyState } from "../electron/server/stacks/state.js";
import { wakeStorageQueue } from "../electron/server/workflows/storage-queue.js";

function open() {
  let resolve;
  const promise = new Promise((a) => { resolve = a; });
  return { promise, resolve };
}

async function erase(base, pid) {
  const r = await fetch(`${base}/api/projects/${pid}`, { method: "DELETE", headers: { Connection: "close" } });
  return { status: r.status, body: await r.json() };
}

// Only ids, states and phases — `since` is a time of day.
const work = (a) => a.projectWork.map((x) => [x.projectId, x.instance, x.state, x.phase]);

test("busy: waiting is not busy; in clone1, freeze and creation busy through the instance row (create + heavy load), the delete lock names the phase; ready not busy; copies/copiesWaiting count", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-busy-")); // empty ⇒ the storage gate is open
  const prior = { CBASE_STORAGE_ROOT: process.env.CBASE_STORAGE_ROOT, CBASE_GRAPH_TICK_MS: process.env.CBASE_GRAPH_TICK_MS };
  process.env.CBASE_STORAGE_ROOT = rootDir;
  process.env.CBASE_GRAPH_TICK_MS = String(24 * 3_600_000);
  const gates = { clone1: open(), freeze: open(), creation: open() };
  let run = null;
  let copy = null;
  try {
    await withAgentsServer(async ({ base, ws, chat, root }) => {
      setCopyDeleteStep(null);
      try {
        const filePath = path.join(root, "workspace", "busy");
        fs.mkdirSync(filePath, { recursive: true });
        const p = await json(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Busy", path: filePath }) });
        const a0 = await json(`${base}/api/runs/active`);
        assert.deepEqual([a0.busy, a0.copies, a0.copiesWaiting], [false, 0, 0], "the fields always stand, even 0");

        // The placeholder build: clone1 → (gate) → freeze → (gate) → clone2, heavy load free → creation → (gate) → ready.
        setCopyProcedure(({ copy: k, releaseHeavyLoad }) => {
          run = (async () => {
            await gates.clone1.promise;
            setCopyState(k.id, "build", { phase: "freeze" });
            await gates.freeze.promise;
            setCopyState(k.id, "build", { phase: "clone2" });
            releaseHeavyLoad();
            setCopyState(k.id, "build", { phase: "creation" });
            await gates.creation.promise;
            // The wake call at `ready` (stacks/inset.js) is not the subject here — the mark stands beforehand, otherwise a wake
            // turn (busy:true) would run in the chat and "ready not busy" would no longer test the instance row
            // (stacks-inset.test.js holds the wake call).
            store.writeStackCopyJournal(k.id, { data: { inset: { wakeCall: { state: "ready", at: 0 } } } });
            setCopyState(k.id, "ready");
          })();
          return run;
        });

        // Waiting: no instance row, no work.
        copy = copyRequests({ projectId: p.id, name: "k1", chatId: chat.id });
        const a1 = await json(`${base}/api/runs/active`);
        assert.deepEqual([a1.busy, a1.copies, a1.copiesWaiting, work(a1)], [false, 1, 1, []], JSON.stringify(a1));

        // The pass: ONE synchronous step — the instance row stands before anything waits.
        assert.equal(wakeStorageQueue(), 1);
        const i = store.projectInstance(p.id, "copy-k1");
        assert.deepEqual(i && [i.state, i.phase], ["create", "clone1"], "the instance row is missing in clone1");
        // clone1 and freeze with the heavy load; creation without — there `busy` holds through the instance row ALONE.
        for (const [phase, beforeGate] of [["clone1", null], ["freeze", "clone1"], ["creation", "freeze"]]) {
          if (beforeGate) {
            gates[beforeGate].resolve();
            await waitForTruthy(() => (store.stackCopy(copy.id).phase === phase ? true : null), `phase ${phase}`);
          }
          const a = await json(`${base}/api/runs/active`);
          assert.equal(a.busy, true, `${phase}: busy is false — deploy and idle reaper would not see the work`);
          assert.deepEqual([a.copies, a.copiesWaiting], [1, 0]);
          const heavy = phase === "creation" ? [] : [[p.id, "copy-k1", "heavyLoad", "copy-clone"]];
          assert.deepEqual(work(a), [[p.id, "copy-k1", "create", phase], ...heavy], `${phase}: ${JSON.stringify(a.projectWork)}`);
          const r = await erase(base, p.id);
          assert.equal(r.status, 409, `${phase}: ${JSON.stringify(r.body)}`);
          assert.match(r.body.error, new RegExp(`eine Kopie lebt noch — copy-k1 \\(build, ${phase}\\); löschen erst nach dem Abräumen`)); // German T() output (uiLang de)
          assert.ok(store.getProject(p.id), `${phase}: the project fell`);
        }

        // Ready: no work any more, the copy lives.
        gates.creation.resolve();
        await waitForTruthy(() => (buildAlive(store.stackCopy(copy.id)) ? null : true), "build finished");
        assert.equal(store.stackCopy(copy.id).state, "ready");
        const a3 = await json(`${base}/api/runs/active`);
        assert.deepEqual([a3.busy, a3.copies, a3.copiesWaiting, work(a3)], [false, 1, 0, []], JSON.stringify(a3));

        // Removed no longer counts.
        setCopyState(copy.id, "error", { error: "end of test" });
        store.deleteProjectInstance(p.id, "copy-k1");
        setCopyState(copy.id, "removed");
        const a4 = await json(`${base}/api/runs/active`);
        assert.deepEqual([a4.busy, a4.copies, a4.copiesWaiting], [false, 0, 0]);
        copy = null;
      } finally {
        // Even after a red test: no new starts, all gates open, wait for the build, the rows gone.
        setCopyDeleteStep(copyDeleteStep); // the connection server.js sets
        setCopyProcedure(null);
        setCopyDismantling(null);
        gates.clone1.resolve();
        gates.freeze.resolve();
        gates.creation.resolve();
        if (run) await run.catch(() => {});
        if (copy) {
          await waitForTruthy(() => (buildAlive(store.stackCopy(copy.id)) ? null : true), "build finished (cleanup)");
          const k = store.stackCopy(copy.id);
          if (k && k.state !== "removed") {
            if (["build", "ready"].includes(k.state)) setCopyState(k.id, "error", { error: "end of test" });
            store.deleteProjectInstance(k.projectId, "copy-k1");
            setCopyState(k.id, "removed");
          }
        }
      }
    });
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("orphaned build counts in copiesWaiting — after the hook \"project-instances\", during and after the restart dismantling; it does not hold busy", async () => {
  let copy = null;
  const gate = open();
  let dismantling = null;
  await withAgentsServer(async ({ base, chat }) => {
    try {
      // Without a procedure connection: the postponed copy does not build again at once. The dismantling holds at a gate.
      setCopyProcedure(null);
      setCopyDismantling((o) => {
        dismantling = gate.promise.then(() => { store.deleteProjectInstance(o.copy.projectId, o.instance); });
        return dismantling;
      });
      // The build of the LAST server run: the rows stand, no procedure lives in this process.
      copy = copyRequests({ projectId: "p-g22", name: "k1", chatId: chat.id });
      setCopyState(copy.id, "build", { phase: "clone1" });
      setCopyState(copy.id, "build", { phase: "freeze" });
      const a0 = await json(`${base}/api/runs/active`);
      assert.deepEqual([a0.busy, a0.copies, a0.copiesWaiting], [true, 1, 0], `the instance row in create holds busy: ${JSON.stringify(a0)}`);

      // The hook "project-instances" (before copiesRestartGrace, server.js): create without a procedure ⇒ error — `busy` falls.
      instancesRestartGrace();
      assert.equal(store.projectInstance("p-g22", "copy-k1").state, "error");
      const a1 = await json(`${base}/api/runs/active`);
      assert.deepEqual([a1.busy, a1.copies, a1.copiesWaiting], [false, 1, 1], `after the hook project-instances: copiesWaiting ${a1.copiesWaiting} — the idle reaper would put B to sleep`);

      // During the dismantling (under the occupancy "copy-dismantling", which lives only in memory).
      assert.equal(copiesRestartGrace(), 1);
      await waitForTruthy(() => (dismantling ? true : null), "dismantling begun");
      const a2 = await json(`${base}/api/runs/active`);
      assert.deepEqual([a2.busy, a2.copies, a2.copiesWaiting], [false, 1, 1], `during the dismantling: ${JSON.stringify(a2)}`);

      // Afterwards it waits in the queue again — and keeps counting.
      gate.resolve();
      await waitForTruthy(() => (store.stackCopy(copy.id).state === "waiting_queue" ? true : null), "back in the queue");
      const a3 = await json(`${base}/api/runs/active`);
      assert.deepEqual([a3.busy, a3.copies, a3.copiesWaiting], [false, 1, 1]);
      setCopyState(copy.id, "removed");
      copy = null;
    } finally {
      gate.resolve();
      if (dismantling) await dismantling.catch(() => {});
      setCopyDismantling(null);
      if (copy) {
        // No waiting for the dismantling (it may never have begun — a hang instead of a red): the row goes to `removed` itself;
        // a dismantling that ends afterwards no longer finds it in `build` and does nothing.
        const k = store.stackCopy(copy.id);
        if (k && k.state !== "removed") {
          if (["build", "ready"].includes(k.state)) setCopyState(k.id, "error", { error: "end of test" });
          store.deleteProjectInstance(k.projectId, "copy-k1");
          setCopyState(k.id, "removed");
        }
      }
    }
  });
});
