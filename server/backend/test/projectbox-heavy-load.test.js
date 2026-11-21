// The heavy-load lock per user container: projectbox/heavyLoad.js and its reader in /api/runs/active (runs/routes.js).
//
// What holds:
//   - ONE lock, the kind in its value: a second occupation fails with `HeavyLoadOccupied` and names the holder, whatever the
//     kind and whatever the project. An unknown kind throws. Release is idempotent and never releases the lock of a
//     successor. `withHeavyLoad` also releases after a throw. The wakeup comes after the release.
//   - Route: while the lock is held it appears in `projectWork` (the same five fields, `state: "heavyLoad"`, the kind as
//     phase) and `busy`/`quiet` say "work" - without an instance row, without a turn. Afterwards empty again.
//
// COUNTER-TESTS (each shown red, then reverted):
//   runs/routes.js without the heavy-load reader                  => "Route ..." red (busy false, projectWork empty while held)
//   projectbox/heavyLoad.js `if (holders) throw ...` removed        => "One lock ..." red (the second occupation succeeds); the same
//     sabotage is BUILT IN below (copy in a temp dir) and must be red
//   projectbox/heavyLoad.js token comparison in release removed    => "One lock ..." red (the stale release frees the successor)
//
// No clock: `since` is only compared against the lock's own row.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import * as heavy from "../electron/server/projectbox/heavyLoad.js";
import { json, withAgentsServer } from "./agent-harness.mjs";

const SOURCE = new URL("../electron/server/projectbox/heavyLoad.js", import.meta.url);
const FIELDS_WORK = ["instance", "phase", "projectId", "since", "state"];

// The lock's promises as a list of violations - the same check runs against the real module and against the sabotage.
async function violationsTheLock(m) {
  const v = [];
  const free1 = m.occupyHeavyLoad("relocation", { projectId: "p-a" });
  try {
    for (const [kind, target] of [["relocation", { projectId: "p-a" }], ["copy-clone", { projectId: "p-b", instance: "copy-k1" }], ["relocation", { projectId: "p-c" }]]) {
      try {
        const f = m.occupyHeavyLoad(kind, target);
        v.push(`second occupation "${kind}" for ${target.projectId} succeeded`);
        f();
      } catch (e) {
        if (e?.code !== "HEAVY_LOAD_OCCUPIED") v.push(`wrong error: ${e?.message}`);
        else if (e.occupied?.kind !== "relocation" || e.occupied?.projectId !== "p-a" || e.occupied?.instance !== "main") v.push(`holder named wrongly: ${JSON.stringify(e.occupied)}`);
      }
    }
  } finally {
    free1();
  }
  // Release is idempotent: the stale release must not free the successor.
  const free2 = m.occupyHeavyLoad("copy-clone", { projectId: "p-d", instance: "copy-k2" });
  if (free1() !== false) v.push("a second release reported success");
  if (m.heavyLoadStatus()?.projectId !== "p-d") v.push("the stale release freed the successor's lock");
  free2();
  if (m.heavyLoadStatus() !== null) v.push("not free after the release");
  return v;
}

test("One lock per backend, the kind in its value: second occupation fails and names the holder; release is idempotent; withHeavyLoad releases after a throw", async () => {
  assert.deepEqual([...heavy.HEAVY_LOAD_KINDS], ["relocation", "copy-clone"]);
  assert.equal(heavy.heavyLoadStatus(), null, "free by default");
  assert.deepEqual(await violationsTheLock(heavy), []);

  assert.throws(() => heavy.occupyHeavyLoad("umzugg", { projectId: "p" }), /unknown kind/);
  assert.throws(() => heavy.occupyHeavyLoad("relocation", {}), /without projectId/);
  assert.equal(heavy.heavyLoadStatus(), null, "a rejected call occupies nothing");

  await assert.rejects(heavy.withHeavyLoad("relocation", { projectId: "p-w" }, async () => {
    assert.deepEqual({ ...heavy.heavyLoadStatus(), since: 0 }, { kind: "relocation", projectId: "p-w", instance: "main", since: 0 });
    throw new Error("step 6 fails");
  }), /step 6 fails/);
  assert.equal(heavy.heavyLoadStatus(), null, "free again after the throw");

  // The wakeup comes AFTER the release, as a microtask, with the releaser's kind.
  const woken = [];
  heavy.setHeavyLoadWakeup((w) => woken.push({ ...w, freeAtWake: heavy.heavyLoadStatus() === null }));
  try {
    const f = heavy.occupyHeavyLoad("copy-clone", { projectId: "p-k", instance: "copy-k1" });
    f();
    f();
    assert.deepEqual(woken, [], "the wakeup does not run synchronously inside the release");
    await Promise.resolve();
    assert.deepEqual(woken, [{ kind: "copy-clone", projectId: "p-k", instance: "copy-k1", freeAtWake: true }], "exactly one wakeup per release");
  } finally {
    heavy.setHeavyLoadWakeup(null);
  }
});

test("Built-in sabotage: without the holder check the second occupation succeeds - the check above is red", async () => {
  const text = fs.readFileSync(SOURCE, "utf8");
  const row = "  if (holder) throw new HeavyLoadOccupied(holder, kind);\n";
  assert.ok(text.includes(row), "the check line no longer looks like this - update the sabotage");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-heavy-load-"));
  try {
    const target = path.join(dir, "heavy-load-without-check.js");
    fs.writeFileSync(target, text.replace(row, ""));
    const sabotaged = await import(pathToFileURL(target).href);
    const v = await violationsTheLock(sabotaged);
    assert.ok(v.some((x) => x.startsWith("second occupation")), `the sabotage went unnoticed: ${JSON.stringify(v)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Route: the held lock appears in projectWork and makes busy true - without an instance row, without a turn; empty afterwards", async () => {
  await withAgentsServer(async ({ base }) => {
    const active = () => json(`${base}/api/runs/active`);
    const empty = await active();
    assert.deepEqual([empty.busy, empty.projectWork, empty.quiet], [false, [], true]);
    const free = heavy.occupyHeavyLoad("relocation", { projectId: "p-route" });
    try {
      const a = await active();
      assert.equal(a.busy, true, "a relocation halts deploy and reaper, even before the setup");
      assert.equal(a.quiet, false);
      assert.equal(a.runs, 0, "no turn - busy comes from the lock alone");
      assert.equal(a.projectWork.length, 1);
      const [e] = a.projectWork;
      assert.deepEqual(Object.keys(e).sort(), FIELDS_WORK, "the same five fields as an instance - no path");
      assert.deepEqual([e.projectId, e.instance, e.state, e.phase], ["p-route", "main", "heavyLoad", "relocation"]);
      assert.equal(e.since, heavy.heavyLoadStatus().since);
    } finally {
      free();
    }
    const afterwards = await active();
    assert.deepEqual([afterwards.busy, afterwards.projectWork], [false, []]);
  });
});
