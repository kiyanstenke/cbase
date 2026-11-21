// Administration against the REAL gateway (index.js as a child process, gateway-harness.mjs with a fake docker; contract in
// administration-contract.js). The calculations alone are in resources.test.js, the docker page alone (inflight, teardown,
// re-creation) in containers.test.js.
//
// The promises and the sabotage that breaks each:
//  - The initial fill takes over what the containers carry NOW, changes nothing on any of them and overwrites no set row.
//      Sabotage: in index.js supplementMissingRows `users.supplementResources(...)` -> `(users.setResources(u.id, ...), true)` and
//      drop the check `if (users.getResources(u.id)) continue;` => "initial fill" red (the set 3 GiB row became 16),
//      also "PUT" and "container actions" (every list overwrote the stored values with the container).
//  - Lowering below the consumption is a 409 with the number; an unknown consumption blocks lowering.
//      Sabotage: in index.js the check `if (l.state === "running" && lowersRam(...))` -> `if (false && ...)` => "lowering" red
//      (200 and a `docker update --memory 6 GiB` against a 6 GiB working set).
//  - The last ACTIVE admin stays admin.
//      Sabotage: in index.js when demoting `lastAdmin(users.listUsers(), target)` -> `false` => "PATCH" red.
//  - A re-creation by the gateway takes the stored value, not the unit.
//      Sabotage: comment out `containers.setResourcesSource(...)` in index.js => "container actions" red (`run` without --memory).
//  - /gw/host stays byte-equal (no per-container values in `cbase`).
//      Sabotage: in containers.js hostResources `cbaseMeter.measure()` -> `measure({ perContainer: true })` => "list" red.
//  - Without a measurable container nothing is stored (unknown is not "does not lower"), and a change that did happen says 502
//    instead of 500.
//      Sabotage: in the PUT of index.js `try { prior = await containers.situation(target); } catch ...` -> `prior = await
//      containers.situation(target);` => "create" red (500 with raw docker text).
//  - The old list GET /gw/admin/users is gone, /gw/admin redirects into the settings.
//      Sabotage: put `if (p === "/gw/admin/users" && m === "GET") return send(res, 200, users.listUsers());` before the create
//      route => "list" red; drop the line with the 302 to ADMINISTRATION_JUMP => "list" red (404).
//
// No clock: waits on the gateway's start lines (listening AND initial fill, see the harness), on gates of the fake docker and on
// responses.
//
// Run:  node --test --test-reporter=tap server/gateway/administration.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { prepareSetup } from "./gateway-harness.mjs";
import { hostSpecs } from "./containers.js";
import * as V from "./administration-contract.js";

const G = 1024 ** 3;
// Same host as the gateway (child process on the same machine, same calculation).
const SPEC = hostSpecs();
const MAX = Math.floor(SPEC.ramTotalBytes / G);
const S = V.CPU_PRIO_SHARES;
const cname = (id) => `cbase-u-${id}`;
const hexId = (z) => z.repeat(64);

function asUser(gw, sess) {
  return async (method, filePath, body) => {
    const r = await fetch(gw.base + filePath, {
      method,
      redirect: "manual",
      headers: { cookie: `cbase_gw=${sess}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML or empty */ }
    return { status: r.status, json, text, location: r.headers.get("location") };
  };
}
const desired = (gw) => JSON.parse(fs.readFileSync(path.join(gw.data, "resources-desired.json"), "utf8"));
const updates = (gw) => gw.calls().filter((z) => z.startsWith("update "));
const creation = (gw, id) => gw.calls().filter((z) => z.startsWith("run ") && z.includes(` --name ${cname(id)} `));
const fresh = (gw, name, role = "user") => gw.users.createUser({ username: name, password: "correct-123", role });

// The values the initial fill takes over are clamped to the host (RAM to MemTotal in whole GiB, a hard CPU limit only below the
// thread count; resources.js valuesFromInspect). A container value above the host would come back as the host's maximum and could
// not be told apart from the next one — so the four values are chosen inside THIS host's range, pairwise distinct: on a large host
// they are 12/8/6 GiB and 2 CPUs, on a 2-core 7 GiB CI runner 7/6/5 GiB and 1 CPU. Below that the test cannot tell the cases apart
// and says so instead of passing.
const FILL = {
  maintainer: Math.min(12, MAX),
  second: Math.min(8, MAX - 1),
  unit: Math.min(6, MAX - 2),
  set: Math.min(16, MAX),
  cpus: Math.min(2, SPEC.threads - 1),
};

test("initial fill: every user without a row gets what their container carries NOW (without a container the unit template) — no container is touched, a set row stays", async (t) => {
  t.diagnostic(`host: ${MAX} GiB, ${SPEC.threads} threads — container values ${FILL.maintainer}/${FILL.second} GiB, unit ${FILL.unit} GiB, ${FILL.cpus} CPU(s)`);
  assert.ok(FILL.unit > 3 && FILL.cpus >= 1, `the host is too small to tell the cases apart (${MAX} GiB, ${SPEC.threads} threads; needs ≥ 6 GiB and ≥ 2 threads)`);
  const gw = await prepareSetup({ env: { GW_CONTAINER_MEM: `${FILL.unit}g`, GW_CONTAINER_CPU_SHARES: String(S.up) } });
  try {
    const maintainer = fresh(gw, "maintainer", "admin");
    const second = fresh(gw, "second");
    const without = fresh(gw, "without");
    const set = fresh(gw, "set");
    gw.container(cname(maintainer.id), { mem: FILL.maintainer * G, shares: S.low }); // the maintainer: low weight
    gw.container(cname(second.id), { mem: FILL.second * G, cpus: FILL.cpus, shares: 0 }); // the second: a hard CPU limit, no weight
    gw.container(cname(without.id), { gone: true });
    gw.container(cname(set.id), { mem: FILL.set * G });
    gw.users.setResources(set.id, { ramGiB: 3, cpuPrio: "up", cpuMax: 1 }, maintainer.id);
    const sess = gw.users.createSession(maintainer.id);
    await gw.start();
    assert.match(gw.log(), /Resources: 3 users taken over from the existing state/);
    assert.deepEqual(gw.users.getResources(maintainer.id), { ramGiB: FILL.maintainer, cpuPrio: "low", cpuMax: null });
    assert.deepEqual(gw.users.getResources(second.id), { ramGiB: FILL.second, cpuPrio: "normal", cpuMax: FILL.cpus });
    assert.deepEqual(gw.users.getResources(without.id), { ramGiB: FILL.unit, cpuPrio: "up", cpuMax: null }, "without a container: the template from the unit");
    assert.deepEqual(gw.users.getResources(set.id), { ramGiB: 3, cpuPrio: "up", cpuMax: 1 }, "a set row stays");
    assert.deepEqual(gw.calls().filter((z) => /^(update|run|start|stop|rm) /.test(z)), [], "the initial fill changes nothing on any container");
    assert.deepEqual(desired(gw), {
      [maintainer.id]: { memory: FILL.maintainer * G, nanoCpus: 0, cpuShares: S.low },
      [second.id]: { memory: FILL.second * G, nanoCpus: FILL.cpus * 1e9, cpuShares: S.normal },
      [without.id]: { memory: FILL.unit * G, nanoCpus: 0, cpuShares: S.up },
      [set.id]: { memory: 3 * G, nanoCpus: 1e9, cpuShares: S.up },
    });
    const v = await asUser(gw, sess)("GET", "/gw/admin/administration");
    assert.equal(v.status, 200, v.text);
    const from = Object.fromEntries(v.json.user.map((n) => [n.username, n.deviating]));
    assert.deepEqual(from, { maintainer: false, second: false, without: false, set: true }, "weight 0 is \"normal\"; the container's value instead of 3 GiB deviates");
  } finally { await gw.end(); }
});

test("list: GET /gw/admin/administration with exactly the contract fields, consumption per container from the cgroup, overcommit; /gw/admin redirects, GET /gw/admin/users is gone, non-admins 403; /gw/host without per-container values", async () => {
  const gw = await prepareSetup();
  try {
    const admin = fresh(gw, "admin", "admin");
    const user = fresh(gw, "user");
    const ID = hexId("a");
    gw.container(cname(user.id), { id: ID, mem: 4 * G, shares: S.low });
    gw.cgroup(ID, { "memory.current": 3 * G, "memory.stat": `anon 1\ninactive_file ${G}`, "memory.swap.current": 0, "cpu.stat": "usage_usec 5000000", "cpu.weight": 50 });
    gw.psIds([ID]);
    gw.container(cname(admin.id), { stopped: true, mem: 2 * G });
    gw.users.setResources(admin.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    gw.users.setResources(user.id, { ramGiB: 4, cpuPrio: "low", cpuMax: null }, null);
    const a = asUser(gw, gw.users.createSession(admin.id));
    const n = asUser(gw, gw.users.createSession(user.id));
    await gw.start();

    const r = await a("GET", "/gw/admin/administration");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json), [...V.ADMINISTRATION_FIELDS]);
    assert.deepEqual(r.json.server, {
      threads: SPEC.threads, ramTotalBytes: SPEC.ramTotalBytes, ramAllocatedBytes: 6 * G, reserveBytes: V.HOST_RESERVE_GIB * G,
      overcommitted: 6 * G > SPEC.ramTotalBytes - V.HOST_RESERVE_GIB * G,
    });
    for (const x of r.json.user) {
      assert.deepEqual(Object.keys(x), [...V.USER_FIELDS]);
      assert.deepEqual(Object.keys(x.container), [...V.CONTAINER_FIELDS]);
      assert.deepEqual(Object.keys(x.resources), [...V.RESOURCES_FIELDS]);
      assert.deepEqual(Object.keys(x.actual), [...V.ACTUAL_FIELDS]);
    }
    const byKey = Object.fromEntries(r.json.user.map((x) => [x.username, x]));
    assert.deepEqual([byKey.admin.itself, byKey.user.itself], [true, false]);
    assert.deepEqual(byKey.user.container, { state: "running", since: "2026-10-15T08:00:00Z" });
    assert.deepEqual(byKey.user.actual, { ramBytes: 4 * G, cpuMax: null, cpuWeight: 50 }, "cpu.weight from the cgroup");
    assert.deepEqual(Object.keys(byKey.user.consumption), [...V.CONSUMPTION_FIELDS]);
    assert.equal(byKey.user.consumption.ramBytes, 2 * G, "working set: current - inactive_file");
    assert.equal(typeof byKey.user.consumption.cpuThreads, "number", "measured in the meter's window");
    assert.deepEqual(byKey.admin.container, { state: "stopped", since: "2026-10-15T09:00:00Z" });
    assert.equal(byKey.admin.consumption, null, "stopped: no consumption");
    assert.deepEqual(byKey.admin.actual, { ramBytes: 2 * G, cpuMax: null, cpuWeight: null });
    assert.deepEqual([byKey.admin.deviating, byKey.user.deviating], [false, false]);

    // Overcommit: a limit as large as the host (on a STOPPED container — applied without measuring).
    const large = await a("PUT", `/gw/admin/users/${admin.id}/resources`, { ramGiB: MAX, cpuPrio: "normal", cpuMax: null });
    assert.equal(large.status, 200, large.text);
    assert.equal(large.json.actual.ramBytes, MAX * G);
    const server = (await a("GET", "/gw/admin/administration")).json.server;
    assert.equal(server.ramAllocatedBytes, (MAX + 4) * G);
    assert.equal(server.overcommitted, true, "the sum exceeds what remains after the reserve — allowed, but warned");

    const jump = await a("GET", "/gw/admin");
    assert.deepEqual([jump.status, jump.location], [302, V.ADMINISTRATION_JUMP], "the old page redirects into Settings -> Administration");
    assert.equal((await a("GET", "/gw/admin/users")).status, 404, "the list has ONE place");
    for (const [m, p] of [["GET", "/gw/admin/administration"], ["GET", "/gw/admin"], ["PUT", `/gw/admin/users/${user.id}/resources`],
      ["PATCH", `/gw/admin/users/${admin.id}`], ["POST", `/gw/admin/users/${admin.id}/stop`], ["POST", "/gw/admin/users"]]) {
      assert.equal((await n(m, p, m === "GET" ? undefined : {})).status, 403, `${m} ${p} as user`);
    }

    const host = await a("GET", "/gw/host");
    assert.deepEqual(Object.keys(host.json.cbase), ["memBytes", "cpuCores", "swapBytes", "diskBytes", "at", "diskAt"], "/gw/host stays byte-equal");
    assert.equal(host.json.cbase.memBytes, 2 * G, "same probe: the sum is the working set of the one container");
  } finally { await gw.end(); }
});

test("PUT …/resources: required fields (null is a statement) and ranges => 400 without effect; otherwise stored, applied by id (swap 2 x RAM, \"no limit\" = --cpus <threads>), resources-desired.json follows; a failed apply stays stored and visible", async () => {
  const gw = await prepareSetup();
  try {
    const admin = fresh(gw, "admin", "admin");
    const user = fresh(gw, "user");
    gw.container(cname(user.id), { mem: 2 * G, shares: S.normal });
    gw.users.setResources(user.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    const a = asUser(gw, gw.users.createSession(admin.id));
    await gw.start();
    const filePath = `/gw/admin/users/${user.id}/resources`;
    const gut = { ramGiB: 4, cpuPrio: "up", cpuMax: null };
    for (const [body, pattern] of [
      [{ ramGiB: 4, cpuPrio: "up" }, /Required field missing: cpuMax/],
      [{ cpuPrio: "up", cpuMax: null }, /Required field missing: ramGiB/],
      [{}, /Required field missing: ramGiB, cpuPrio, cpuMax/],
      [{ ...gut, ramGB: 4 }, /unknown field: ramGB/],
      [{ ...gut, ramGiB: MAX + 1 }, /ramGiB/],
      [{ ...gut, ramGiB: 1 }, /ramGiB/],
      [{ ...gut, ramGiB: "4" }, /ramGiB/],
      [{ ...gut, cpuPrio: "turbo" }, /cpuPrio/],
      [{ ...gut, cpuMax: 0 }, /cpuMax/],
      [{ ...gut, cpuMax: SPEC.threads + 1 }, /cpuMax/],
    ]) {
      const r = await a("PUT", filePath, body);
      assert.equal(r.status, 400, `${JSON.stringify(body)}: ${r.text}`);
      assert.match(r.json.error, pattern);
    }
    assert.deepEqual(updates(gw), [], "no docker update after a 400");
    assert.deepEqual(gw.users.getResources(user.id), { ramGiB: 2, cpuPrio: "normal", cpuMax: null });

    const ok = await a("PUT", filePath, gut);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(Object.keys(ok.json), [...V.USER_FIELDS], "the response is the user in the list form");
    assert.deepEqual(updates(gw), [`update --memory ${4 * G} --memory-swap ${8 * G} --cpu-shares ${S.up} --cpus ${SPEC.threads} id-${cname(user.id)}`],
      "by id, with swap and with --cpus <threads> for \"no limit\" (--cpus 0 lifts nothing)");
    assert.deepEqual([ok.json.resources, ok.json.actual, ok.json.deviating], [gut, { ramBytes: 4 * G, cpuMax: null, cpuWeight: null }, false]);
    assert.deepEqual(gw.users.getResources(user.id), gut);
    assert.deepEqual(desired(gw)[user.id], { memory: 4 * G, nanoCpus: 0, cpuShares: S.up });

    const hart = await a("PUT", filePath, { ramGiB: 4, cpuPrio: "normal", cpuMax: 1 });
    assert.equal(hart.status, 200, hart.text);
    assert.match(updates(gw)[1], / --cpus 1 id-/);
    assert.deepEqual(hart.json.actual, { ramBytes: 4 * G, cpuMax: 1, cpuWeight: null });
    assert.deepEqual(desired(gw)[user.id], { memory: 4 * G, nanoCpus: 1e9, cpuShares: S.normal });

    gw.marker("update-fails");
    const broken = await a("PUT", filePath, { ramGiB: 5, cpuPrio: "normal", cpuMax: 1 });
    assert.equal(broken.status, 502, broken.text);
    assert.match(broken.json.error, /Saved, but not applied/);
    assert.equal(gw.users.getResources(user.id).ramGiB, 5, "the value stays stored — the next creation reads it");
    const afterwards = (await a("GET", "/gw/admin/administration")).json.user.find((x) => x.id === user.id);
    assert.equal(afterwards.deviating, true, "and the list shows that the container does not carry it");

    assert.equal((await a("PUT", "/gw/admin/users/00000000-0000-0000-0000-000000000000/resources", gut)).status, 404);
  } finally { await gw.end(); }
});

test("lowering: below working set + RAM_BUFFER_BYTES is 409 with consumptionBytes, nothing stored, nothing applied; an unknown consumption blocks lowering, never raising; a stopped one is not measured; 409 while deleting", async () => {
  const gw = await prepareSetup();
  try {
    const admin = fresh(gw, "admin", "admin");
    const full = fresh(gw, "full");
    const blind = fresh(gw, "blind");
    const out = fresh(gw, "off");
    const victim = fresh(gw, "victim");
    const ID = hexId("b");
    gw.container(cname(full.id), { id: ID, mem: 12 * G });
    gw.cgroup(ID, { "memory.current": 6 * G, "memory.stat": "inactive_file 0", "memory.swap.current": 0, "cpu.stat": "usage_usec 1" });
    gw.psIds([ID]);
    gw.container(cname(blind.id), { mem: 4 * G }); // running, but without a measurable id
    gw.container(cname(out.id), { mem: 8 * G, stopped: true });
    for (const [u, ramGiB] of [[full, 12], [blind, 4], [out, 8], [victim, 2]]) gw.users.setResources(u.id, { ramGiB, cpuPrio: "normal", cpuMax: null }, null);
    const sess = gw.users.createSession(admin.id);
    const a = asUser(gw, sess);
    await gw.start();
    const put = (u, ramGiB) => a("PUT", `/gw/admin/users/${u.id}/resources`, { ramGiB, cpuPrio: "normal", cpuMax: null });

    const toDeep = await put(full, 6);
    assert.equal(toDeep.status, 409, toDeep.text);
    assert.deepEqual(Object.keys(toDeep.json), ["error", "consumptionBytes"]);
    assert.equal(toDeep.json.consumptionBytes, 6 * G);
    assert.match(toDeep.json.error, /currently occupies 6,0 GiB/);
    assert.deepEqual(updates(gw), [], "nothing applied");
    assert.equal(gw.users.getResources(full.id).ramGiB, 12, "nothing stored");
    assert.equal((await put(full, 7)).status, 200, "7 GiB ≥ 6 GiB + 0,5 GiB");
    assert.equal(updates(gw).length, 1);

    const unknown = await put(blind, 3);
    assert.equal(unknown.status, 409, unknown.text);
    assert.equal(unknown.json.consumptionBytes, null, "not measured is not \"little\"");
    assert.match(unknown.json.error, /cannot be measured/);
    assert.equal((await put(blind, 5)).status, 200, "raising works without a measurement");
    assert.equal((await put(out, 2)).status, 200, "a stopped container has no working set");

    gw.marker("hangs-exec"); // the deletion waits in the stop of the project containers
    const erase = fetch(`${gw.base}/gw/admin/users/${victim.id}`, { method: "DELETE", headers: { cookie: `cbase_gw=${sess}` } });
    assert.equal(await gw.waitAtGate("exec"), true, gw.log());
    const midway = await put(victim, 3);
    assert.equal(midway.status, 409, midway.text);
    assert.match(midway.json.error, /being removed/);
    const unlock = await a("PATCH", `/gw/admin/users/${victim.id}`, { locked: false });
    assert.equal(unlock.status, 409, "no unlocking in the middle of a deletion");
    gw.openGate("exec");
    assert.equal((await erase).status, 200);
    assert.equal(gw.users.getResources(victim.id), null, "the row goes with the user");
    assert.equal(desired(gw)[victim.id], undefined, "and with it out of resources-desired.json");
  } finally { await gw.end(); }
});

test("PATCH: exactly one field; the last ACTIVE admin stays admin, the own account is not locked; locking works at once, unlocking allows login again, a new role applies from the next request", async () => {
  const gw = await prepareSetup();
  try {
    const A = fresh(gw, "anna", "admin");
    const B = fresh(gw, "bert", "admin");
    const C = fresh(gw, "carl");
    const a = asUser(gw, gw.users.createSession(A.id));
    const c = asUser(gw, gw.users.createSession(C.id));
    await gw.start();
    const patch = (u, body) => a("PATCH", `/gw/admin/users/${u.id}`, body);
    for (const wrong of [{}, { role: "admin", locked: true }, { roles: "admin" }, { role: "boss" }, { locked: "yes" }, { locked: null }]) {
      assert.equal((await patch(C, wrong)).status, 400, JSON.stringify(wrong));
    }
    const locked = await patch(B, { locked: true });
    assert.equal(locked.status, 200, locked.text);
    assert.deepEqual(Object.keys(locked.json), [...V.USER_FIELDS]);
    assert.deepEqual([locked.json.locked, locked.json.role], [true, "admin"]);
    const selfBack = await patch(A, { role: "user" });
    assert.equal(selfBack.status, 400, "the locked admin does not count — Anna is the last active one");
    assert.match(selfBack.json.error, /last active admin/);
    assert.match((await patch(A, { locked: true })).json.error, /own account/);
    assert.equal((await patch(B, { locked: false })).json.locked, false);
    assert.equal((await patch(B, { role: "user" })).json.role, "user");
    assert.equal((await patch(A, { role: "user" })).status, 400, "now Anna is the only admin");
    assert.equal(gw.users.getUser(A.id).role, "admin");

    assert.equal((await c("GET", "/gw/me")).status, 200);
    assert.equal((await patch(C, { locked: true })).status, 200);
    assert.equal((await c("GET", "/gw/me")).status, 401, "the session falls with the lock");
    const login = () => fetch(`${gw.base}/gw/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "carl", password: "correct-123" }) }).then((r) => r.status);
    assert.equal(await login(), 401, "locked does not log in");
    assert.equal((await patch(C, { locked: false })).status, 200);
    assert.equal(await login(), 200, "unlocked again");

    assert.equal((await patch(B, { role: "admin" })).status, 200);
    assert.equal((await patch(A, { role: "user" })).status, 200, "with Bert as active admin Anna may step down");
    assert.equal((await a("GET", "/gw/admin/administration")).status, 403, "the new role applies at once");
  } finally { await gw.end(); }
});

test("container actions: start creates with the STORED value (no --cpus without a limit), stop with the deadline, restart first stop then start; a locked user does not start", async () => {
  const gw = await prepareSetup({ env: { GW_CONTAINER_MEM: "9g" } }); // the unit says something different from the rows
  try {
    const admin = fresh(gw, "admin", "admin");
    const one = fresh(gw, "one");
    const two = fresh(gw, "two");
    const locked = fresh(gw, "locked");
    for (const u of [one, two, locked]) gw.container(cname(u.id), { gone: true });
    gw.users.setResources(one.id, { ramGiB: 3, cpuPrio: "up", cpuMax: 1 }, null);
    gw.users.setResources(two.id, { ramGiB: 2, cpuPrio: "normal", cpuMax: null }, null);
    const a = asUser(gw, gw.users.createSession(admin.id));
    await gw.start();
    const action = (u, what) => a("POST", `/gw/admin/users/${u.id}/${what}`, {});

    const start = await action(one, "start");
    assert.equal(start.status, 200, start.text);
    assert.deepEqual(Object.keys(start.json), [...V.USER_FIELDS]);
    assert.equal(start.json.container.state, "running");
    assert.equal(creation(gw, one.id).length, 1, gw.calls().join("\n"));
    assert.ok(creation(gw, one.id)[0].includes(` --memory ${3 * G} --memory-swap ${6 * G} --cpu-shares ${S.up} --cpus 1 `), creation(gw, one.id)[0]);
    assert.deepEqual(start.json.actual, { ramBytes: 3 * G, cpuMax: 1, cpuWeight: null });
    const withoutLimit = await action(two, "start");
    assert.equal(withoutLimit.status, 200, withoutLimit.text);
    assert.ok(creation(gw, two.id)[0].includes(` --memory ${2 * G} --memory-swap ${4 * G} --cpu-shares ${S.normal} `), creation(gw, two.id)[0]);
    assert.ok(!creation(gw, two.id)[0].includes("--cpus"), "a re-creation without a limit does not set --cpus at all");

    const stop = await action(one, "stop");
    assert.equal(stop.status, 200, stop.text);
    assert.ok(gw.calls().includes(`stop -t 60 ${cname(one.id)}`), gw.calls().join("\n"));
    assert.deepEqual([stop.json.container.state, stop.json.consumption], ["stopped", null]);

    const prior = gw.calls().length;
    const again = await action(one, "restart");
    assert.equal(again.status, 200, again.text);
    const newer = gw.calls().slice(prior);
    const iStop = newer.indexOf(`stop -t 60 ${cname(one.id)}`);
    const iStart = newer.indexOf(`start ${cname(one.id)}`);
    assert.ok(iStop >= 0 && iStart > iStop, `first stop, then start: ${newer.join(" | ")}`);
    assert.equal(again.json.container.state, "running");

    assert.equal((await a("PATCH", `/gw/admin/users/${locked.id}`, { locked: true })).status, 200);
    for (const what of ["start", "restart"]) {
      const r = await action(locked, what);
      assert.equal(r.status, 409, `${what}: ${r.text}`);
      assert.match(r.json.error, /locked/);
    }
    assert.deepEqual(creation(gw, locked.id), [], "no container for a locked user");
    assert.equal((await action(one, "burst")).status, 404);
    assert.equal((await a("GET", `/gw/admin/users/${one.id}/start`)).status, 404);
  } finally { await gw.end(); }
});

test("create with all required fields (the row from the template), password, delete; /gw/env carries the own values — and stays reachable when docker does not answer (administration then says 502 instead of \"missing\")", async () => {
  const gw = await prepareSetup({ env: { GW_CONTAINER_MEM: "6g", GW_CONTAINER_CPU_SHARES: String(S.low) } });
  try {
    const admin = fresh(gw, "admin", "admin");
    const user = fresh(gw, "user");
    gw.container(cname(user.id), { mem: 4 * G, shares: S.low });
    gw.users.setResources(user.id, { ramGiB: 4, cpuPrio: "low", cpuMax: null }, null);
    const a = asUser(gw, gw.users.createSession(admin.id));
    const n = asUser(gw, gw.users.createSession(user.id));
    await gw.start();

    assert.match((await a("POST", "/gw/admin/users", { username: "fresh", password: "correct-123" })).json.error, /Required field missing: role/);
    assert.match((await a("POST", "/gw/admin/users", { username: "fresh", password: "correct-123", role: "user", quota: 1 })).json.error, /unknown field/);
    const created = await a("POST", "/gw/admin/users", { username: "fresh", password: "correct-123", role: "user" });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(Object.keys(created.json), [...V.USER_FIELDS]);
    assert.deepEqual(created.json.resources, { ramGiB: 6, cpuPrio: "low", cpuMax: null }, "the template from the unit");
    const id = created.json.id;
    assert.deepEqual(desired(gw)[id], { memory: 6 * G, nanoCpus: 0, cpuShares: S.low });
    assert.equal((await a("POST", "/gw/admin/users", { username: "fresh", password: "correct-123", role: "user" })).status, 400, "the name is taken");

    const pw = (body) => a("POST", `/gw/admin/users/${id}/password`, body);
    assert.match((await pw({})).json.error, /Required field missing: password/);
    assert.match((await pw({ password: "short" })).json.error, /at least 8/);
    assert.equal((await pw({ password: "new-password" })).status, 200);

    const res = await a("DELETE", `/gw/admin/users/${id}`);
    assert.deepEqual([res.status, res.json], [200, { ok: true, purged: false }]);
    assert.equal(desired(gw)[id], undefined);
    assert.equal(gw.users.getResources(id), null);

    const env = await n("GET", "/gw/env");
    assert.equal(env.status, 200, env.text);
    for (const k of ["state", "port", "startedAt", "activeStreams", ...V.ENV_ADDITION_FIELDS]) assert.ok(Object.hasOwn(env.json, k), `/gw/env without ${k}`);
    assert.deepEqual(env.json.resources, { ramGiB: 4, cpuPrio: "low", cpuMax: null });
    assert.deepEqual(env.json.actual, { ramBytes: 4 * G, cpuMax: null, cpuWeight: null });
    assert.deepEqual(env.json.consumption, { ramBytes: null, cpuThreads: null }, "running, but without a measurable id: null per field");

    gw.marker("inspect-fails");
    const blind = await n("GET", "/gw/env");
    assert.equal(blind.status, 200, "the old contract does not depend on the administration");
    assert.deepEqual([blind.json.actual, blind.json.consumption], [null, null]);
    assert.deepEqual(blind.json.resources, { ramGiB: 4, cpuPrio: "low", cpuMax: null });
    const list = await a("GET", "/gw/admin/administration");
    assert.equal(list.status, 502, "unknown is not \"missing\"");
    assert.match(list.json.error, /docker inspect/);
    // Resources without a measurable container: nothing stored (whether it lowers is unknown — no 500 with raw docker text).
    const blindPut = await a("PUT", `/gw/admin/users/${user.id}/resources`, { ramGiB: 2, cpuPrio: "up", cpuMax: null });
    assert.equal(blindPut.status, 502, blindPut.text);
    assert.match(blindPut.json.error, /^Not saved/);
    assert.deepEqual(gw.users.getResources(user.id), { ramGiB: 4, cpuPrio: "low", cpuMax: null });
    assert.deepEqual(updates(gw), []);
    // A change that does not depend on docker happens — only the response says the container cannot be measured right now.
    const blindPatch = await a("PATCH", `/gw/admin/users/${user.id}`, { role: "admin" });
    assert.equal(blindPatch.status, 502, blindPatch.text);
    assert.match(blindPatch.json.error, /^Done, but the container cannot be measured right now/);
    assert.equal(gw.users.getUser(user.id).role, "admin");
  } finally { await gw.end(); }
});
