// The names of the COPIES (projectbox/names.js, header "THE COPIES"). A copy `copy-<name>` is called
// `<name>.<label of the main's name>.cbase` - assigned synchronously at its creation (projectbox/instance.js), brought along by
// `bringAlongNames` (mains first), listed in `GET /api/projects` under `instance.copies` (only when there are copies) and in the
// /etc/hosts block.
//
// What holds:
//   (1) pure: a copy's name from the main's stored name; without it null; an invalid instance throws.
//   (3) every copy carries, beside its instance row's state, that of its living copy row (`copyState`, "" without) - a copy
//       being cleared away (`earmarked`) or after a failed clear-away keeps its instance row `ready`; only the second state
//       shows the chats' instance choice what runs/instance-switch.js instanceChoice rejects.
//   (2) on the server with the fake docker: the main is called `shop.cbase`; without a copy `/api/projects` carries no `copies`.
//       Two copies, each with its own row through the creation in progress: `k1.shop.cbase`, `k2.shop.cbase` right after
//       the creation, both in the block, both in `instance.copies` (identifier, name, chat, state - no paths). A copy row
//       without a name gets it in the restart grace ("project-names"). After a copy is removed (row gone, the teardown calls
//       bringAlongNames) its name is gone from the block, the other stays, foreign lines byte-equal.
//
// COUNTER-TESTS (each shown red, then reverted):
//   instance.js: the name of a copy at creation removed (`dnsName` only for the main)  => (2) red (no name after the creation)
//   names.js: bringAlongNames only for the main again                                    => (2) red (the restart-grace row)
//   names.js: projectInstanceField without `copies`                                      => (2) red
//   names.js: projectInstanceField without `copyState`                                   => (3) and (2) red
//   this test without waiting for openHooks() after the restart grace                    => (2) red ("a restart-grace consumer
//     ran past the end of operation", plus log lines against the cleaned-up docker)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DIRS } from "../electron/server/app-state.js";
import * as store from "../electron/server/store.js";
import { BLOCK_BEGINNING, BLOCK_END } from "../electron/server/projectbox/hosts-file.js";
import { dnsNameOf, bringAlongNames } from "../electron/server/projectbox/names.js";
import { createInstance, withProjectOccupancy } from "../electron/server/projectbox/instance.js";
import { setInstanceState } from "../electron/server/projectbox/instances.js";
import { fireHooks, openHooks } from "../electron/server/runs/hooks.js";
import { instanceChoice } from "../electron/server/runs/instance-switch.js";
import { json, withAgentsServer, waitForTruthy } from "./agent-harness.mjs";
import { fakeDocker } from "./fake-docker.mjs";
import { HOSTS_TEST, ID, withOps, scenario } from "./projectbox-scenario.mjs";

const FOREIGN = "127.0.0.1\tlocalhost\n# from docker\n172.24.0.5\tb-container\n";

// The lines in the /etc/hosts block (without start and end mark).
function rowsInBlock(file) {
  const text = fs.readFileSync(file, "utf8");
  const a = text.indexOf(BLOCK_BEGINNING);
  if (a < 0) return [];
  const e = text.indexOf(BLOCK_END, a);
  return text.slice(a + BLOCK_BEGINNING.length, e).split("\n").filter(Boolean);
}

// ── (1) pure ────────────────────────────────────────────────────────────────────────────────────────────────────────

test("(1) a copy's name: <name>.<label of the main>.cbase - null without the main's name, an invalid instance throws", async () => {
  await withAgentsServer(async () => {
    const pid = `p-names-${crypto.randomUUID().slice(0, 8)}`;
    try {
      store.createProjectInstance({ projectId: pid, state: "ready" });
      assert.equal(dnsNameOf(pid, "copy-k1"), null, "a copy got a name although its main carries none");
      store.changeProjectInstance(pid, "main", { dnsName: "till-2.cbase" });
      assert.equal(dnsNameOf(pid, "copy-k1"), "k1.till-2.cbase");
      assert.equal(dnsNameOf(pid, "copy-review-3"), "review-3.till-2.cbase");
      store.createProjectInstance({ projectId: pid, instance: "copy-k1", state: "create", chatId: "c1", copyName: "k1", dnsName: "fixed.till-2.cbase" });
      assert.equal(dnsNameOf(pid, "copy-k1"), "fixed.till-2.cbase", "a stored name stays fixed");
      for (const wrong of ["copy-K1", "copy-", "k1", "copy-a/b"]) assert.throws(() => dnsNameOf(pid, wrong), TypeError, wrong);
    } finally { store.deleteProjectInstance(pid); }
  });
});

// ── (2) on the server ───────────────────────────────────────────────────────────────────────────────────────────────────

test("(2) two copies with their own rows: names after the creation, in the block and in /api/projects; the restart grace brings names along; gone after the removal", async () => {
  await withAgentsServer(async (ctx) => {
    const s = scenario(ctx, { name: "Shop", projectId: crypto.randomUUID() });
    const pid = s.projectId;
    const names = ["k1", "k2"];
    const fd = await fakeDocker({ images: { "cbase-projectbox:latest": ID }, programs: s.programs, infoFailures: Object.fromEntries(names.map((n) => [`cbase-k-${pid}-${n}`, 1e9])) });
    try {
      fs.writeFileSync(HOSTS_TEST, FOREIGN);
      const main = await withOps(fd, () => createInstance(pid, s.opts));
      assert.equal(main.dnsName, "shop.cbase");
      const withoutCopy = (await json(`${ctx.base}/api/projects`)).find((p) => p.id === pid);
      assert.ok(withoutCopy.instance && !("copies" in withoutCopy.instance), `without a copy instance carries a field copies: ${JSON.stringify(withoutCopy.instance)}`);

      // The copies under construction: their entrypoint waits for `.prepared` (phase=prepare), no dockerd in them.
      fs.writeFileSync(path.join(s.inside, "run", "cbase-projectbox.status"), "phase=prepare\nnotice=waiting for .prepared\n");
      const copies = [];
      for (const n of names) {
        const inst = `copy-${n}`;
        fs.mkdirSync(path.join(DIRS.data, "copies", pid, n), { recursive: true });
        setInstanceState(pid, inst, "create", { phase: "creation", chatId: `chat-${n}`, copyName: n });
        const z = await withOps(fd, () => withProjectOccupancy(pid, "copy", () => createInstance(pid, { ...s.opts, instance: inst, build: true, occupancyHeld: true })));
        assert.equal(z.dnsName, `${n}.shop.cbase`, `${inst}: no name right after the creation - ${JSON.stringify(z)}`);
        assert.ok(z.ip && z.ip !== main.ip, `${inst}: address ${z.ip} beside ${main.ip}`);
        copies.push(z);
      }
      const block = () => rowsInBlock(HOSTS_TEST);
      assert.deepEqual(block(), [`${main.ip} shop.cbase`, `${copies[0].ip} k1.shop.cbase`, `${copies[1].ip} k2.shop.cbase`]);
      assert.ok(fs.readFileSync(HOSTS_TEST, "utf8").startsWith(FOREIGN), "foreign lines changed");

      const withCopies = (await json(`${ctx.base}/api/projects`)).find((p) => p.id === pid);
      // `copyState` "": these instance rows have no living copy row in stack_copies - the creation here is by hand.
      assert.deepEqual(withCopies.instance.copies, names.map((n) => ({ identifier: `${pid}/copy-${n}`, name: `${n}.shop.cbase`, chatId: `chat-${n}`, state: "create", copyState: "" })));
      assert.equal(withCopies.instance.name, "shop.cbase");

      // A copy row without a name (e.g. from an older version): the restart grace assigns it, after the main's.
      store.changeProjectInstance(pid, "copy-k2", { dnsName: "" });
      fs.writeFileSync(HOSTS_TEST, FOREIGN);
      // Wait for the whole chain, still in operation: the consumers without `wait` ("project-thaw", "project-helper" ...) would
      // otherwise run past withOps and fd.cleanUp(), against the already cleaned-up fake docker - an error there would be a
      // log line, never a red test.
      await withOps(fd, async () => {
        await fireHooks("restartGrace", {});
        await waitForTruthy(() => openHooks() === 0, "the restart-grace consumers are done");
      });
      assert.equal(openHooks(), 0, "a restart-grace consumer ran past the end of operation");
      assert.equal(store.projectInstance(pid, "copy-k2").dnsName, "k2.shop.cbase", "the restart grace gave the copy no name");
      assert.deepEqual(block(), [`${main.ip} shop.cbase`, `${copies[0].ip} k1.shop.cbase`, `${copies[1].ip} k2.shop.cbase`], "the restart grace did not write the block");

      // Removal (a copy's teardown, stacks/: row gone, then bringAlongNames): its name is gone.
      store.deleteProjectInstance(pid, "copy-k1");
      const r = await withOps(fd, () => bringAlongNames({ path: HOSTS_TEST }));
      assert.equal(r.written, true, JSON.stringify(r));
      assert.deepEqual(block(), [`${main.ip} shop.cbase`, `${copies[1].ip} k2.shop.cbase`], "after the removal the name was still there");
      assert.deepEqual((await json(`${ctx.base}/api/projects`)).find((p) => p.id === pid).instance.copies.map((k) => k.name), ["k2.shop.cbase"]);
      store.deleteProjectInstance(pid, "copy-k2");
      await withOps(fd, () => bringAlongNames({ path: HOSTS_TEST }));
      assert.deepEqual(block(), [`${main.ip} shop.cbase`]);
      assert.ok(!("copies" in (await json(`${ctx.base}/api/projects`)).find((p) => p.id === pid).instance), "without copies the field is still there");
    } finally {
      for (const z of store.projectInstancesInState(store.PROJECT_WORK_STATES)) setInstanceState(z.projectId, z.instance, "error", { error: "test end" });
      fs.rmSync(path.join(DIRS.data, "copies"), { recursive: true, force: true });
      fd.cleanUp();
    }
  });
});

// ── (3) copyState ─────────────────────────────────────────────────────────────────────────────────────

test("(3) `copyState` per copy: the copy row's state beside the instance row's - exactly those instanceChoice accepts carry `ready`", async () => {
  await withAgentsServer(async (ctx) => {
    const p = await ctx.projectWithoutInstance({ name: "Choice", path: path.join(ctx.root, "workspace", "choice") });
    const pid = p.id;
    try {
      store.createProjectInstance({ projectId: pid, state: "ready", convertedAt: Date.now() });
      // Every instance row is `ready` - as in the window that counts: clearing away only changes stack_copies (stacks/routes.js DELETE).
      const cases = [["k1", "ready", ""], ["k2", "clearAway", "earmarked"], ["k3", "error", ""], ["k4", null, ""]];
      for (const [n, kz, phase] of cases) {
        store.createProjectInstance({ projectId: pid, instance: `copy-${n}`, state: "ready", copyName: n });
        if (kz) store.createStackCopy({ projectId: pid, name: n, state: kz, phase });
      }
      const field = (await json(`${ctx.base}/api/projects`)).find((x) => x.id === pid)?.instance;
      assert.deepEqual(field?.copies?.map((k) => [k.identifier, k.state, k.copyState]),
        cases.map(([n, kz]) => [`${pid}/copy-${n}`, "ready", kz ?? ""]), JSON.stringify(field));
      // The other side: the server accepts exactly the copy whose copy row is `ready` - the same boundary the client computes.
      assert.equal(instanceChoice(pid, "copy-k1"), "copy-k1");
      for (const n of ["k2", "k3", "k4"]) assert.throws(() => instanceChoice(pid, `copy-${n}`), (e) => e.code === "UNKNOWN_INSTANCE", n);
    } finally { store.deleteProjectInstance(pid); }
  });
});
