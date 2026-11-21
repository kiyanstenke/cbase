// The administration calculation without docker, without a database, without a server (resources.js). The paths through the
// real gateway are in administration.test.js.
//
// The promises and the sabotage that breaks each:
//  - "No limit" is `--cpus <threads>` on update and no `--cpus` at all on creation; swap = 2 x RAM.
//      Sabotage: in argsForUpdate `?? threads` -> `?? 0` => "arguments" red (`--cpus 0` lifts nothing on the server);
//      `2 * ram` -> `ram` => likewise red.
//  - A weight of 0 is "normal" — in the reverse mapping AND in the comparison; otherwise every never-touched container would
//    read "deviates" (the second user container on the server: 8 GiB, 2 CPUs, no weight).
//      Sabotage: in deviating `sharesEffective(...)` -> `Number(hostConfig.CpuShares) || 0` => "deviating" red; in priorityFromShares
//      drop the line `if (s <= 0) return "normal"` => "reverse mapping" and "template" red (0 would be closest to "low").
//  - A body carries EXACTLY its required fields; `cpuMax: null` is a statement, a missing cpuMax an error.
//      Sabotage: exactlyTheKey always returns null => "bodies" red (a foreign field went through, a missing cpuMax read
//      "cpuMax: null or ..." instead of "required field missing").
//  - The last ACTIVE admin: a locked one does not count.
//      Sabotage: in lastAdmin drop `&& !u.locked` => "last admin" red.
//  - Responses exactly in the contract's shape (keys AND order).
//      Sabotage: userView additionally carries `port` => "response shapes" red.
//  - No second knowledge about shares: 1287/2600/5220 live only in the contract.
//      Sabotage: in resources.js sharesEffective `CPU_PRIO_SHARES.normal` -> `2600` => "no second knowledge" red.
//
// Run:  node --test --test-reporter=tap server/gateway/resources.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as R from "./resources.js";
import * as V from "./administration-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = 1024 ** 3;
// A measured server: nproc 4, MemTotal 32753204 kB => at most 31 GiB.
const SPEC = Object.freeze({ threads: 4, ramTotalBytes: 32753204 * 1024 });

test("arguments: creation without a limit without --cpus, update with --cpus <threads>; swap 2 x RAM; a value >= threads is no limit", () => {
  const s = V.CPU_PRIO_SHARES;
  assert.deepEqual(R.argsForCreation({ ramGiB: 12, cpuPrio: "low", cpuMax: null }, 4),
    ["--memory", String(12 * G), "--memory-swap", String(24 * G), "--cpu-shares", String(s.low)]);
  assert.deepEqual(R.argsForCreation({ ramGiB: 8, cpuPrio: "normal", cpuMax: 2 }, 4),
    ["--memory", String(8 * G), "--memory-swap", String(16 * G), "--cpu-shares", String(s.normal), "--cpus", "2"]);
  assert.deepEqual(R.argsForCreation({ ramGiB: 8, cpuPrio: "up", cpuMax: 4 }, 4).includes("--cpus"), false, "4 of 4 limits nothing");
  assert.deepEqual(R.argsForUpdate({ ramGiB: 12, cpuPrio: "low", cpuMax: null }, 4),
    ["--memory", String(12 * G), "--memory-swap", String(24 * G), "--cpu-shares", String(s.low), "--cpus", "4"]);
  assert.deepEqual(R.argsForUpdate({ ramGiB: 2, cpuPrio: "up", cpuMax: 1 }, 4).slice(-2), ["--cpus", "1"]);
  for (const w of [{ ramGiB: 2, cpuPrio: "up", cpuMax: null }, { ramGiB: 2, cpuPrio: "up", cpuMax: 3 }]) {
    const args = R.argsForUpdate(w, 4);
    assert.notEqual(args[args.indexOf("--cpus") + 1], "0", "`--cpus 0` does not lift a limit (Docker 28)");
    assert.equal(args[args.indexOf("--cpu-shares") + 1] === "0", false, "`--cpu-shares 0` resets nothing");
  }
  for (const wrong of [null, { ramGiB: 2.5, cpuPrio: "up", cpuMax: null }, { ramGiB: 2, cpuPrio: "medium", cpuMax: null }, { ramGiB: 2, cpuPrio: "up", cpuMax: 0 }, { ramGiB: 2, cpuPrio: "up" }]) {
    assert.throws(() => R.argsForCreation(wrong, 4), /Invalid resources/, JSON.stringify(wrong));
  }
});

test("reverse mapping (initial fill): what the containers on the server carry, without changing anything on them", () => {
  // The first container: 12 GiB, no hard limit, weight 1287.
  assert.deepEqual(R.valuesFromInspect({ Memory: 12 * G, NanoCpus: 0, CpuShares: 1287 }, SPEC), { ramGiB: 12, cpuPrio: "low", cpuMax: null });
  // The second: 8 GiB, 2 CPUs, no weight.
  assert.deepEqual(R.valuesFromInspect({ Memory: 8 * G, NanoCpus: 2e9, CpuShares: 0 }, SPEC), { ramGiB: 8, cpuPrio: "normal", cpuMax: 2 });
  assert.equal(R.valuesFromInspect({ Memory: 8 * G, NanoCpus: 4e9 }, SPEC).cpuMax, null, "4 of 4 is no limit (after `docker update --cpus 4`)");
  assert.equal(R.valuesFromInspect({ NanoCpus: 1.5e9 }, SPEC).cpuMax, 2, "rounded to whole CPUs");
  assert.equal(R.valuesFromInspect({}, SPEC).ramGiB, 31, "without a limit: the whole machine, rounded down");
  assert.equal(R.valuesFromInspect({ Memory: G }, SPEC).ramGiB, V.RAM_MIN_GIB, "clamped into the range a PUT would accept");
  assert.equal(R.valuesFromInspect({ Memory: 64 * G }, SPEC).ramGiB, 31);
  assert.equal(R.valuesFromInspect({ Memory: 12.4 * G }, SPEC).ramGiB, 12);
  for (const [shares, stage] of [[0, "normal"], [undefined, "normal"], [2, "low"], [1024, "low"], [1287, "low"], [2600, "normal"], [4000, "up"], [5220, "up"], [262144, "up"]]) {
    assert.equal(R.priorityFromShares(shares), stage, `weight ${shares}`);
  }
  for (const p of V.CPU_PRIO) assert.equal(R.priorityFromShares(V.CPU_PRIO_SHARES[p]), p, "every level maps onto itself");
});

test("template from the unit: the same reverse mapping as a container the gateway would have created from it", () => {
  assert.deepEqual(R.templateFromEnvironment({ mem: "12g", cpus: "", cpuShares: "1287" }, SPEC), { ramGiB: 12, cpuPrio: "low", cpuMax: null });
  assert.deepEqual(R.templateFromEnvironment({ mem: "8g", cpus: "2", cpuShares: "" }, SPEC), { ramGiB: 8, cpuPrio: "normal", cpuMax: 2 });
  assert.deepEqual(R.templateFromEnvironment({}, SPEC), { ramGiB: 31, cpuPrio: "normal", cpuMax: null });
  assert.equal(R.templateFromEnvironment({ cpuShares: "512k" }, SPEC).cpuPrio, "normal", "a weight that limitsArgs discards is none");
  assert.equal(R.templateFromEnvironment({ mem: "6144m" }, SPEC).ramGiB, 6);
  assert.equal(R.bytesFromDocker("12g"), 12 * G);
  assert.equal(R.bytesFromDocker("8589934592"), 8 * G);
  assert.equal(R.bytesFromDocker(""), 0);
  assert.equal(R.bytesFromDocker("twelve"), null);
});

test("deviating: RAM byte-exact, CPU limit and weight in their effect (0 = normal, >= threads = none); never without a value or container", () => {
  const desired = { ramGiB: 8, cpuPrio: "normal", cpuMax: 2 };
  assert.equal(R.deviating(desired, { Memory: 8 * G, NanoCpus: 2e9, CpuShares: 0 }, 4), false, "the second container on the server is equal");
  assert.equal(R.deviating(desired, { Memory: 8 * G, NanoCpus: 2e9, CpuShares: V.CPU_PRIO_SHARES.normal }, 4), false);
  assert.equal(R.deviating(desired, { Memory: 12 * G, NanoCpus: 2e9 }, 4), true, "RAM");
  assert.equal(R.deviating(desired, { Memory: 8 * G, NanoCpus: 0 }, 4), true, "CPU limit missing");
  assert.equal(R.deviating(desired, { Memory: 8 * G, NanoCpus: 2e9, CpuShares: V.CPU_PRIO_SHARES.low }, 4), true, "weight");
  const without = { ramGiB: 12, cpuPrio: "low", cpuMax: null };
  for (const nano of [0, 4e9, 8e9]) {
    assert.equal(R.deviating(without, { Memory: 12 * G, NanoCpus: nano, CpuShares: V.CPU_PRIO_SHARES.low }, 4), false, `NanoCpus ${nano}`);
  }
  assert.equal(R.deviating({ ...without, cpuMax: 4 }, { Memory: 12 * G, NanoCpus: 0, CpuShares: V.CPU_PRIO_SHARES.low }, 4), false, "4 of 4 stored = none");
  assert.equal(R.deviating(without, { Memory: 12 * G, NanoCpus: 3e9, CpuShares: V.CPU_PRIO_SHARES.low }, 4), true);
  assert.equal(R.deviating(null, { Memory: 1 }, 4), false);
  assert.equal(R.deviating(without, null, 4), false);
});

test("lowering: only against a measured consumption, with RAM_BUFFER_BYTES headroom; unknown is not \"little\"", () => {
  assert.equal(R.lowersRam({ ramGiB: 6 }, { Memory: 12 * G }), true);
  assert.equal(R.lowersRam({ ramGiB: 12 }, { Memory: 12 * G }), false, "equal does not lower");
  assert.equal(R.lowersRam({ ramGiB: 16 }, { Memory: 12 * G }), false);
  assert.equal(R.lowersRam({ ramGiB: 31 }, { Memory: 0 }), true, "every limit lies below \"none\"");
  assert.match(R.ramUnderConsumption({ ramGiB: 6 }, 6 * G), /currently occupies 6,0 GiB.*≥ 7 GiB/);
  assert.equal(R.ramUnderConsumption({ ramGiB: 7 }, 6 * G), null);
  assert.equal(R.ramUnderConsumption({ ramGiB: 7 }, 7 * G - V.RAM_BUFFER_BYTES), null, "exactly at the edge: allowed");
  assert.notEqual(R.ramUnderConsumption({ ramGiB: 7 }, 7 * G - V.RAM_BUFFER_BYTES + 1), null);
  for (const unknown of [null, undefined, NaN]) assert.match(R.ramUnderConsumption({ ramGiB: 30 }, unknown), /cannot be measured/);
});

test("bodies: exactly the required fields — missing or foreign is an error, `cpuMax: null` a statement", () => {
  const gut = { ramGiB: 4, cpuPrio: "up", cpuMax: null };
  assert.deepEqual(R.checkResources(gut, SPEC), { values: gut });
  assert.deepEqual(R.checkResources({ ...gut, cpuMax: 4 }, SPEC).values.cpuMax, 4);
  for (const f of V.RESOURCES_FIELDS) {
    const { [f]: _dropped, ...without } = gut;
    assert.match(R.checkResources(without, SPEC).error, new RegExp(`Required field missing: ${f}`), f);
  }
  assert.match(R.checkResources({ ...gut, ramGB: 4 }, SPEC).error, /unknown field: ramGB/);
  for (const [wrong, pattern] of [
    [{ ramGiB: 1 }, /ramGiB/], [{ ramGiB: 32 }, /ramGiB: whole number from 2 to 31/], [{ ramGiB: 2.5 }, /ramGiB/], [{ ramGiB: "4" }, /ramGiB/],
    [{ cpuPrio: "medium" }, /cpuPrio/], [{ cpuPrio: null }, /cpuPrio/],
    [{ cpuMax: 0 }, /cpuMax/], [{ cpuMax: 5 }, /cpuMax: null .* to 4/], [{ cpuMax: 1.5 }, /cpuMax/], [{ cpuMax: "2" }, /cpuMax/],
  ]) assert.match(R.checkResources({ ...gut, ...wrong }, SPEC).error, pattern, JSON.stringify(wrong));
  for (const no of [null, [], "x", 3]) assert.match(R.checkResources(no, SPEC).error, /JSON object|Required field/);

  assert.deepEqual(R.checkPatch({ role: "admin" }), { values: { role: "admin" } });
  assert.deepEqual(R.checkPatch({ locked: false }), { values: { locked: false } });
  for (const wrong of [{}, { role: "admin", locked: true }, { roles: "admin" }, { role: "boss" }, { locked: "yes" }, { locked: null }, null, []]) {
    assert.ok(R.checkPatch(wrong).error, JSON.stringify(wrong));
  }

  assert.deepEqual(R.checkCreate({ username: "a", password: "b", role: "user" }).values, { username: "a", password: "b", role: "user" });
  assert.match(R.checkCreate({ username: "a", password: "b" }).error, /Required field missing: role/, "no silent default \"user\"");
  assert.match(R.checkCreate({ username: "a", password: "b", role: "user", quota: 1 }).error, /unknown field/);
  assert.match(R.checkCreate({ username: "a", password: "b", role: "guest" }).error, /role/);
  assert.match(R.checkCreate({ username: 1, password: "b", role: "user" }).error, /text/);
  assert.deepEqual(R.checkPassword({ password: "new-12345" }).values, { password: "new-12345" });
  assert.match(R.checkPassword({}).error, /Required field missing: password/);
  assert.match(R.checkPassword({ password: "x", extra: "y" }).error, /unknown field/);
});

test("last admin: the only ACTIVE one — a locked admin does not count", () => {
  const a = { id: "a", role: "admin", locked: false };
  const b = { id: "b", role: "admin", locked: false };
  const u = { id: "u", role: "user", locked: false };
  assert.equal(R.lastAdmin([a, b, u], "a"), false);
  assert.equal(R.lastAdmin([a, u], "a"), true);
  assert.equal(R.lastAdmin([a, { ...b, locked: true }, u], "a"), true, "the locked one cannot log in");
  assert.equal(R.lastAdmin([a, u], "u"), false, "a user is never the last admin");
  assert.equal(R.lastAdmin([{ ...a, locked: true }, b], "a"), false, "a locked admin is not either");
});

test("response shapes: user, server, /gw/env addition and state exactly with the contract fields", () => {
  const user = { id: "u1", username: "maintainer", role: "admin", locked: false, createdAt: 1 };
  const values = { ramGiB: 12, cpuPrio: "low", cpuMax: null };
  const running = { state: "running", since: "2026-10-15T08:00:00Z", hostConfig: { Memory: 12 * G, CpuShares: 1287 }, cpuWeight: 50 };
  const n = R.userView({ user, selfId: "u1", values, situation: running, consumption: { ramBytes: 3 * G, cpuThreads: 0.4 }, threads: 4 });
  assert.deepEqual(Object.keys(n), [...V.USER_FIELDS]);
  assert.deepEqual(Object.keys(n.container), [...V.CONTAINER_FIELDS]);
  assert.deepEqual(Object.keys(n.resources), [...V.RESOURCES_FIELDS]);
  assert.deepEqual(Object.keys(n.actual), [...V.ACTUAL_FIELDS]);
  assert.deepEqual(Object.keys(n.consumption), [...V.CONSUMPTION_FIELDS]);
  assert.deepEqual(n.actual, { ramBytes: 12 * G, cpuMax: null, cpuWeight: 50 });
  assert.deepEqual([n.itself, n.deviating], [true, false]);
  assert.equal(R.userView({ user, selfId: "x", values, situation: running, consumption: null, threads: 4 }).itself, false);
  assert.deepEqual(R.userView({ user, selfId: "x", values, situation: running, consumption: null, threads: 4 }).consumption, { ramBytes: null, cpuThreads: null }, "running, not measured: null per field");
  const missing = R.userView({ user, selfId: "x", values: null, situation: { state: "missing", since: null, hostConfig: null, cpuWeight: null }, consumption: null, threads: 4 });
  assert.deepEqual([missing.actual, missing.consumption, missing.resources, missing.deviating], [null, null, null, false]);
  const stopped = R.userView({ user, selfId: "x", values, situation: { state: "stopped", since: null, hostConfig: { Memory: 8 * G }, cpuWeight: null }, consumption: null, threads: 4 });
  assert.deepEqual([stopped.consumption, stopped.deviating, stopped.actual.ramBytes], [null, true, 8 * G], "stopped: no consumption, but an actual");

  const s = R.serverView(SPEC, [{ ramGiB: 12 }, { ramGiB: 8 }]);
  assert.deepEqual(Object.keys(s), [...V.SERVER_FIELDS]);
  assert.deepEqual(s, { threads: 4, ramTotalBytes: SPEC.ramTotalBytes, ramAllocatedBytes: 20 * G, reserveBytes: V.HOST_RESERVE_GIB * G, overcommitted: false });
  const limit = SPEC.ramTotalBytes - V.HOST_RESERVE_GIB * G;
  assert.equal(R.serverView({ threads: 4, ramTotalBytes: 30 * G }, [{ ramGiB: 24 }]).overcommitted, false, "exactly at the reserve: not overcommitted");
  assert.equal(R.serverView({ threads: 4, ramTotalBytes: 30 * G }, [{ ramGiB: 24 }, { ramGiB: 1 }]).overcommitted, true);
  assert.ok(limit > 0);

  const env = R.resourcesFields({ values, situation: running, consumption: { ramBytes: 1, cpuThreads: 0 }, threads: 4 });
  assert.deepEqual(Object.keys(env), [...V.ENV_ADDITION_FIELDS]);
  assert.deepEqual(R.resourcesFields({ values, situation: null, consumption: null, threads: 4 }), { resources: values, actual: null, consumption: null }, "docker does not answer: unknown");

  for (const info of [null, { State: { Running: true, StartedAt: "2026-10-15T08:00:00Z" } }, { State: { Running: false, FinishedAt: "0001-01-01T00:00:00Z" } }]) {
    const z = R.stateFrom(info);
    assert.deepEqual(Object.keys(z), [...V.CONTAINER_FIELDS]);
    assert.ok(V.CONTAINER_STATES.includes(z.state), z.state);
  }
  assert.deepEqual(R.stateFrom({ State: { Running: false, FinishedAt: "0001-01-01T00:00:00Z" } }), { state: "stopped", since: null }, "never finished does not mean \"since the year 1\"");
  assert.deepEqual(R.actualOf({ Memory: 0, NanoCpus: 2.5e9 }, 4, 50.5), { ramBytes: null, cpuMax: 2.5, cpuWeight: null });
});

test("valuesFromDesired is the inverse of desiredFileContent; what the gateway does not write that way is no stored instruction", () => {
  const threads = 4;
  const list = [];
  let n = 0;
  for (const cpuPrio of V.CPU_PRIO) {
    for (const cpuMax of [null, 1, 3, threads, threads + 4]) {
      list.push({ userId: `0b0b0b0b-eeee-4eee-8eee-${String(++n).padStart(12, "0")}`, ramGiB: 2 + n, cpuPrio, cpuMax });
    }
  }
  const file = R.desiredFileContent(list, threads);
  for (const w of list) {
    // cpuMax >= threads is written as "no limit" (nanoCpus 0) — the same effect comes back.
    assert.deepEqual(R.valuesFromDesired(file[w.userId]), { ramGiB: w.ramGiB, cpuPrio: w.cpuPrio, cpuMax: w.cpuMax >= threads ? null : w.cpuMax });
  }
  // Never "the next level": a value the gateway does not write that way reads as null.
  for (const wrong of [
    { memory: 0, nanoCpus: 0, cpuShares: 2600 }, { memory: 1.5 * G, nanoCpus: 0, cpuShares: 2600 }, { memory: G, nanoCpus: 0, cpuShares: 2600 },
    { memory: 4 * G, nanoCpus: 0, cpuShares: 2500 }, { memory: 4 * G, nanoCpus: 0, cpuShares: 0 }, { memory: 4 * G, nanoCpus: 1.5e9, cpuShares: 2600 },
    null, "4g",
  ]) assert.equal(R.valuesFromDesired(wrong), null, JSON.stringify(wrong));
});

test("resources-desired.json: values in the language of inspect, written atomically, \"normal\" explicit", () => {
  const list = [
    { userId: "a", ramGiB: 12, cpuPrio: "low", cpuMax: null },
    { userId: "b", ramGiB: 8, cpuPrio: "normal", cpuMax: 2 },
    { userId: "c", ramGiB: 2, cpuPrio: "up", cpuMax: 4 },
  ];
  const desired = R.desiredFileContent(list, 4);
  assert.deepEqual(desired, {
    a: { memory: 12 * G, nanoCpus: 0, cpuShares: V.CPU_PRIO_SHARES.low },
    b: { memory: 8 * G, nanoCpus: 2e9, cpuShares: V.CPU_PRIO_SHARES.normal },
    c: { memory: 2 * G, nanoCpus: 0, cpuShares: V.CPU_PRIO_SHARES.up },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-desired-"));
  try {
    fs.writeFileSync(path.join(dir, R.DESIRED_FILE), "old, half written");
    const target = R.writeDesiredFile(dir, list, 4);
    assert.equal(target, path.join(dir, R.DESIRED_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), desired);
    assert.deepEqual(fs.readdirSync(dir), [R.DESIRED_FILE], "no neighbor file stays behind");
    R.writeDesiredFile(dir, [], 4);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const source = fs.readFileSync(path.join(HERE, "resources.js"), "utf8");
  const write = source.slice(source.indexOf("export function writeDesiredFile"));
  assert.ok(write.indexOf("fs.writeFileSync(fresh") >= 0 && write.indexOf("fs.writeFileSync(fresh") < write.indexOf("fs.renameSync(fresh, target)"),
    "first the neighbor file, then rename — never directly into the target");
});

test("no second knowledge about shares: 1287/2600/5220 and the level list live only in the contract", () => {
  for (const file of ["resources.js", "containers.js", "index.js", "users.js"]) {
    const code = fs.readFileSync(path.join(HERE, file), "utf8").split("\n").filter((z) => !z.trim().startsWith("//")).join("\n");
    for (const z of Object.values(V.CPU_PRIO_SHARES)) assert.doesNotMatch(code, new RegExp(`\\b${z}\\b`), `${file}: ${z} in the code (not in a comment)`);
    assert.doesNotMatch(code, /\[\s*["']low["']\s*,/, `${file}: its own level list`);
  }
});
