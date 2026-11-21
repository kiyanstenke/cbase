// Guard for the "limits" row of `./deploy status` (lib/limits.mjs), compared against the stored value PER user, and for the
// limits when a B is swapped.
//
//   (1) desiredFrom reads nproc, the environment line of the unit and, after the marker, the file resources-desired.json:
//       "present", "missing" or "unreadable" — a file that cannot be read is never "missing" (else the comparison would silently fall
//       back to the unit and report green for values nobody stored). Without readable threads everything is unknown (null).
//   (2) With the file: each container against ITS entry (label cbase.user); equality ok, each of the three limits deviating
//       alone => warn with name and path (administration); without label, without entry, unreadable => warn, never ok. Weight 0 is
//       "normal", --cpus <threads> is "no hard limit".
//   (3) Without the file: the old comparison against the unit, named as such.
//   (4) Binding to the gateway: what resources.js hands to docker on creation (`docker run`) and on applying (`docker update`) is,
//       for this row, exactly the stored value that desiredFileContent writes into the file — for every level, with and without
//       a hard limit. Two sides of the same calculation that only a human would connect when reading.
//   (5) Wiring: targets/status.mjs calls limitsCommand with the remote root path and passes the label through per container; the
//       command is read-only.
//
// COUNTER-PROOFS (each seen red once):
//   - in lib/limits.mjs `weightEffective` to `(s) => s` (weight 0 != normal) => (2) red;
//   - in fileFrom a JSON error as "missing" instead of "unreadable" => (1) and (2) red;
//   - "no hard limit" only with NanoCpus 0 (`cpuEffective` without the threads bound) => (2), (3) and (4) red;
//   - in server/gateway/resources.js argsForUpdate `?? threads` -> `?? 0` (the `--cpus 0` that lifts nothing on the server) =>
//     (4) red — because hostConfigFrom treats the 0 like Docker 28 (old value stays);
//   - in targets/status.mjs the label not passed through => (5) red.
//
// Plus the limits when a B is SWAPPED (lib/limits.mjs, ssh page lib/limits-swap.mjs):
//   (6)  valuesFromDesired (server/gateway/resources.js) is the inverse of desiredFileContent; with an entry the swap creates B with
//        argsForCreation, and the result is == stored for the status row. What the gateway does not write is no value.
//   (7)  Without an entry (file missing/unreadable, no label, no entry, host unreadable) the limits from inspect as before, with a
//        reason — but "no limit" (NanoCpus >= nproc) does not travel along as a hard limit.
//   (8)  specWithLimits replaces exactly the limits of the spec, read word by word; an unknown word throws.
//   (9)  At the wrong ssh (seam): before the swap ONE reading ssh, the stored value wins; after the swap adjust by `docker update`
//        BY ID with argsForUpdate; lowering only against memory.current + RAM_BUFFER_BYTES (cgroup path of the gateway), never
//        without a measurement; without file, with a failed update or without id: warning, never a throw.
//   (10) Wiring: deploy and rollback read per B immediately before swapContainer and check right after.
// COUNTER-PROOFS:
//   - targets/server.mjs `swapContainer(t.name, t.spec, …)` (spec from before the gate) => (10) red; without the check afterwards
//     => (10) red;
//   - targets/rollback.mjs `swapContainer(c, specs.get(c), …)` => (10) red;
//   - lib/limits.mjs swapLimits without the "desired" branch => (6) and (9) red; afterSwapRuling without
//     `if (reason) return …warn` => (9) red; limitsFromInspect without the threads bound => (7) red;
//   - lib/limits-swap.mjs `docker update … ${name}` instead of the id => (9) red;
//   - server/gateway/resources.js valuesFromDesired with `priorityFromShares` (the next level) => (6) red.
//
// Run:  node --test --test-reporter=tap tools/deploy/limits.ops.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LIMITS_ROW, DESIRED_MARKER, bytesFrom, limitsFromInspect, limitsCommand, limitsRow, desiredFrom, specWithLimits, swapLimits,
} from "./lib/limits.mjs";
import { limitsAfterSwap, limitsBeforeSwap } from "./lib/limits-swap.mjs";
import { argsForCreation, argsForUpdate, desiredFileContent, valuesFromDesired } from "../../server/gateway/resources.js";
import { CPU_PRIO, CPU_PRIO_SHARES } from "../../server/gateway/administration-contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = 1024 ** 3;
const UNIT = "GW_HOST=127.0.0.1 GW_PORT=7719 GW_DATA=/home/maintainer/cbase-server/data GW_IMAGE=cbase-backend GW_RUNTIME=sysbox-runc GW_CONTAINER_MEM=12g GW_CONTAINER_CPU_SHARES=1287 GW_APNS_TOPIC=dev.cbase.mobile";
const withoutFile = (header) => `${header}\n${DESIRED_MARKER}\nMISSING\n`;
const withFile = (d, threads = 4) => `${threads}\n${UNIT}\n${DESIRED_MARKER}\n${JSON.stringify(d, null, 2)}\n`;
const A = "0b0b0b0b-aaaa-4aaa-8aaa-000000000001";
const B = "0b0b0b0b-bbbb-4bbb-8bbb-000000000002";

test("(1) desiredFrom: threads, unit, file — da, missing, unreadable; unknown is never equal", () => {
  assert.deepEqual(desiredFrom(withoutFile(`4\n${UNIT}`)), { threads: 4, unit: { mem: "12g", cpus: "", cpuShares: 1287 }, file: { state: "missing" } });
  assert.deepEqual(desiredFrom(withoutFile("4\nGW_CONTAINER_MEM=8g GW_CONTAINER_CPUS=2")).unit, { mem: "8g", cpus: "2", cpuShares: 0 });
  assert.equal(desiredFrom(withoutFile("4\nGW_CONTAINER_MEM=8g GW_CONTAINER_MEM=12g")).unit.mem, "12g", "a drop-in overrides");
  for (const wrong of ["0", "1", "262145", "512k", "abc"]) {
    assert.equal(desiredFrom(withoutFile(`4\nGW_CONTAINER_CPU_SHARES=${wrong}`)).unit.cpuShares, 0, wrong);
  }
  assert.equal(desiredFrom(withoutFile("4\nX_GW_CONTAINER_MEM=4g")).unit.mem, "", "only the whole name counts");
  assert.equal(desiredFrom(withoutFile("4")).unit, null, "without a unit line the unit is unknown");

  const d = { [A]: { memory: 12 * G, nanoCpus: 0, cpuShares: 2600 } };
  assert.deepEqual(desiredFrom(withFile(d)).file, { state: "present", perUser: d });
  assert.deepEqual(desiredFrom(withFile({})).file, { state: "present", perUser: {} }, "an empty list is read, not unknown");
  for (const [why, rest] of [
    ["half written", '{ "a": { "memory": 1'],
    ["not an object", "[]"],
    ["entry without a field", JSON.stringify({ [A]: { memory: G, nanoCpus: 0 } })],
    ["entry with text", JSON.stringify({ [A]: { memory: "12g", nanoCpus: 0, cpuShares: 2600 } })],
    ["empty", ""],
  ]) {
    assert.deepEqual(desiredFrom(`4\n${UNIT}\n${DESIRED_MARKER}\n${rest}`).file, { state: "unreadable" }, why);
  }
  assert.deepEqual(desiredFrom(`4\n${UNIT}\n`).file, { state: "unreadable" }, "without the marker the output was cut off — not \"missing\"");

  assert.equal(desiredFrom(""), null);
  assert.equal(desiredFrom(`${DESIRED_MARKER}\nMISSING\n`), null, "without threads unknown");
  assert.equal(desiredFrom("Failed to connect to bus\n"), null);
  assert.equal(bytesFrom("12g"), 12 * G);
  assert.equal(bytesFrom("512m"), 512 * 1024 ** 2);
  assert.equal(bytesFrom("8589934592"), 8 * G);
  assert.equal(bytesFrom("12GiB"), 12 * G);
  assert.equal(bytesFrom("twelve"), null);
});

test("(2) with the file: each container against its entry; every deviation warns with name and path", () => {
  const desired = desiredFrom(withFile({
    [A]: { memory: 12 * G, nanoCpus: 0, cpuShares: CPU_PRIO_SHARES.low },
    [B]: { memory: 8 * G, nanoCpus: 2e9, cpuShares: CPU_PRIO_SHARES.normal },
  }));
  const equal = limitsRow({ Memory: 12 * G, NanoCpus: 0, CpuShares: CPU_PRIO_SHARES.low }, desired, A);
  assert.equal(equal[0], LIMITS_ROW);
  assert.equal(equal[2], "ok");
  assert.match(equal[1], /12 GiB · CPU without hard limit · weight 1287 — == stored$/);
  assert.equal(limitsRow({ Memory: 12 * G, NanoCpus: 4e9, CpuShares: 1287 }, desired, A)[2], "ok", "4 of 4 is no limit");
  assert.match(limitsRow({ Memory: 12 * G, NanoCpus: 4e9, CpuShares: 1287 }, desired, A)[1], /CPU 4 of 4 \(no limit\)/);
  assert.equal(limitsRow({ Memory: 8 * G, NanoCpus: 2e9, CpuShares: 0 }, desired, B)[2], "ok", "weight 0 is normal");
  assert.equal(limitsRow({ Memory: 8 * G, NanoCpus: 2e9, CpuShares: 2600 }, desired, B)[2], "ok");

  // The same container, measured against the OTHER user's entry, deviates — the row compares per user, not globally.
  const foreign = limitsRow({ Memory: 12 * G, NanoCpus: 0, CpuShares: 1287 }, desired, B);
  assert.equal(foreign[2], "warn");
  assert.match(foreign[1], /DEVIATES from the stored value: memory 12 GiB instead of 8 GiB, CPU none instead of hard 2, weight 1287 instead of 2600/);
  assert.match(foreign[1], /Settings → Administration/);
  assert.match(limitsRow({ Memory: 12 * G, NanoCpus: 2e9, CpuShares: 1287 }, desired, A)[1], /CPU hard 2 instead of none \(docker update --cpus 4\)/);
  assert.match(limitsRow({ Memory: 0, NanoCpus: 0, CpuShares: 1287 }, desired, A)[1], /memory none instead of 12 GiB/);
  assert.match(limitsRow({ Memory: 12 * G, NanoCpus: 0, CpuShares: 0 }, desired, A)[1], /weight default instead of 1287/);

  const withoutLabel = limitsRow({ Memory: 12 * G, CpuShares: 1287 }, desired, undefined);
  assert.equal(withoutLabel[2], "warn");
  assert.match(withoutLabel[1], /without label cbase\.user, not compared/);
  const withoutEntry = limitsRow({ Memory: 12 * G, CpuShares: 1287 }, desired, "0b0b0b0b-cccc-4ccc-8ccc-000000000003");
  assert.equal(withoutEntry[2], "warn");
  assert.match(withoutEntry[1], /no stored value for 0b0b0b0b-cccc/);
  const unreadable = limitsRow({ Memory: 12 * G, CpuShares: 1287 }, desiredFrom(`4\n${UNIT}\n${DESIRED_MARKER}\n{`), A);
  assert.equal(unreadable[2], "warn", "an unreadable file does NOT fall back to the unit");
  assert.match(unreadable[1], /resources-desired\.json unreadable, not compared/);
  assert.equal(limitsRow(undefined, desired, A)[2], "warn", "without inspect never ok");
  assert.equal(limitsRow({ Memory: 12 * G }, null, A)[2], "warn", "without host never ok");
  assert.match(limitsRow({ Memory: 12 * G }, null, A)[1], /host unreadable/);
});

test("(3) without the file: against the unit as before the administration feature, named as such", () => {
  const desired = desiredFrom(withoutFile(`4\n${UNIT}`));
  const equal = limitsRow({ Memory: 12 * G, NanoCpus: 0, CpuShares: 1287 }, desired, A);
  assert.equal(equal[2], "ok");
  assert.match(equal[1], /12 GiB · CPU without hard limit · weight 1287 — == unit \(resources-desired\.json missing\)/);
  assert.equal(limitsRow({ Memory: 12 * G, NanoCpus: 4e9, CpuShares: 1287 }, desired, A)[2], "ok", "4 of 4 is no limit");

  const alt = limitsRow({ Memory: 8 * G, NanoCpus: 2e9, CpuShares: 0 }, desired, A);
  assert.equal(alt[2], "warn");
  assert.match(alt[1], /DEVIATES from the unit \(resources-desired\.json missing\)/);
  assert.match(alt[1], /memory 8 GiB instead of 12 GiB/);
  assert.match(alt[1], /CPU hard 2 instead of none \(docker update --cpus 4\)/);
  assert.match(alt[1], /weight default instead of 1287/);

  const hart = desiredFrom(withoutFile("4\nGW_CONTAINER_MEM=8g GW_CONTAINER_CPUS=2"));
  assert.equal(limitsRow({ Memory: 8 * G, NanoCpus: 2e9 }, hart, A)[2], "ok", "the old state equals the old unit");
  assert.match(limitsRow({ Memory: 8 * G, NanoCpus: 0 }, hart, A)[1], /CPU none instead of hard 2/);
  assert.equal(limitsRow({ Memory: 12 * G }, desiredFrom(withoutFile("4")), A)[2], "warn", "without a unit never ok");
  assert.match(limitsRow({ Memory: 12 * G }, desiredFrom(withoutFile("4")), A)[1], /missing and the unit unreadable/);
  assert.match(
    limitsRow({ Memory: 12 * G, CpuShares: 1287 }, desiredFrom(withoutFile("4\nGW_CONTAINER_MEM=twelve GW_CONTAINER_CPU_SHARES=1287")), A)[1],
    /GW_CONTAINER_MEM "twelve" unreadable/,
  );
});

/**
 * What docker writes from the arguments into HostConfig (only the three limits of this row) — with the measured quirk of
 * Docker 28: a 0 means "not given" and leaves the old value (`docker update --cpus 0` lifts no limit, `--cpu-shares 0`
 * resets nothing). Without it an update with `--cpus 0` would pass here but not on the server.
 */
function hostConfigFrom(args, prior = {}) {
  const hc = { Memory: 0, NanoCpus: 0, CpuShares: 0, ...prior };
  for (let i = 0; i < args.length; i += 2) {
    const n = Number(args[i + 1]);
    if (args[i] === "--memory" && n > 0) hc.Memory = n;
    else if (args[i] === "--cpus" && n > 0) hc.NanoCpus = Math.round(n * 1e9);
    else if (args[i] === "--cpu-shares" && n > 0) hc.CpuShares = n;
  }
  return hc;
}

test("(4) binding to the gateway: docker run/update with the stored value is == stored here", () => {
  const threads = 4;
  const list = [];
  let n = 0;
  for (const cpuPrio of CPU_PRIO) {
    for (const cpuMax of [null, 1, 3, threads, threads + 4]) {
      list.push({ userId: `0b0b0b0b-dddd-4ddd-8ddd-${String(++n).padStart(12, "0")}`, ramGiB: 2 + n, cpuPrio, cpuMax });
    }
  }
  const desired = desiredFrom(withFile(desiredFileContent(list, threads), threads));
  assert.equal(desired.file.state, "present");
  for (const w of list) {
    const creation = limitsRow(hostConfigFrom(argsForCreation(w, threads)), desired, w.userId);
    assert.equal(creation[2], "ok", `Creation ${JSON.stringify(w)}: ${creation[1]}`);
    // An update hits a container that stood differently before (hard limit 1, high weight): afterwards the stored value holds.
    const update = limitsRow(hostConfigFrom(argsForUpdate(w, threads), { Memory: G, NanoCpus: 1e9, CpuShares: 5220 }), desired, w.userId);
    assert.equal(update[2], "ok", `Update ${JSON.stringify(w)}: ${update[1]}`);
  }
  // And the other way round: another user's value is not "stored" — the binding checks something.
  const [x, y] = [list[0], list[list.length - 1]];
  assert.equal(limitsRow(hostConfigFrom(argsForCreation(y, threads)), desired, x.userId)[2], "warn");
});

test("(5) wiring: status.mjs queries read-only and passes the label through per container", () => {
  const status = fs.readFileSync(path.join(HERE, "targets", "status.mjs"), "utf8");
  assert.match(status, /desiredFrom\(\(await sshProbe\(limitsCommand\(config\.remote\.root\)/);
  assert.match(status, /limitsRow\(c\.insp\?\.HostConfig, limitsDesired, c\.insp\?\.Config\?\.Labels\?\.\["cbase\.user"\]\)/);
  const command = limitsCommand("/home/maintainer/cbase-server");
  assert.doesNotMatch(command, /\b(set-property|set-environment|edit|restart|daemon-reload|update|rm|mv|tee)\b|>/, "read-only");
  assert.match(command, /\/home\/maintainer\/cbase-server\/gateway\/data\}\/resources-desired\.json/, "without GW_DATA the gateway's default");
  assert.ok(command.includes(`echo '${DESIRED_MARKER}'`), "the marker separates unit and file");
});

// ── the limits when a B is SWAPPED (see the head of lib/limits.mjs) ─────────────────

test("(6) valuesFromDesired is the inverse of desiredFileContent — and a swap with the entry creates a B that is == stored", () => {
  const threads = 4;
  const list = [];
  let n = 0;
  for (const cpuPrio of CPU_PRIO) {
    for (const cpuMax of [null, 1, 3, threads, threads + 4]) {
      list.push({ userId: `0b0b0b0b-eeee-4eee-8eee-${String(++n).padStart(12, "0")}`, ramGiB: 2 + n, cpuPrio, cpuMax });
    }
  }
  const file = desiredFileContent(list, threads);
  const desired = desiredFrom(withFile(file, threads));
  for (const w of list) {
    // cpuMax >= threads the gateway writes as "no limit" (nanoCpus 0) — the same effect comes back.
    assert.deepEqual(valuesFromDesired(file[w.userId]), { ramGiB: w.ramGiB, cpuPrio: w.cpuPrio, cpuMax: w.cpuMax >= threads ? null : w.cpuMax });
    const g = swapLimits({ Memory: G, NanoCpus: 1e9, CpuShares: 5220 }, desired, w.userId); // the old B stood quite differently
    assert.equal(g.source, "desired");
    assert.deepEqual(g.args, argsForCreation(g.values, threads), "the SAME calculation as the creation in the gateway");
    assert.equal(limitsRow(hostConfigFrom(g.args), desired, w.userId)[2], "ok", `new B ${JSON.stringify(w)}`);
  }
  // What the gateway does not write that way is no stored instruction — never "the next level".
  for (const wrong of [
    { memory: 0, nanoCpus: 0, cpuShares: 2600 }, { memory: 1.5 * G, nanoCpus: 0, cpuShares: 2600 }, { memory: G, nanoCpus: 0, cpuShares: 2600 },
    { memory: 4 * G, nanoCpus: 0, cpuShares: 2500 }, { memory: 4 * G, nanoCpus: 0, cpuShares: 0 }, { memory: 4 * G, nanoCpus: 1.5e9, cpuShares: 2600 },
    null, "4g",
  ]) assert.equal(valuesFromDesired(wrong), null, JSON.stringify(wrong));
  const broken = desiredFrom(withFile({ [A]: { memory: 4 * G, nanoCpus: 0, cpuShares: 2500 } }));
  const g = swapLimits({ Memory: 8 * G, NanoCpus: 0, CpuShares: 2600 }, broken, A);
  assert.equal(g.source, "inspect");
  assert.match(g.reason, /is not one the gateway writes/);
});

test("(7) without a stored value the limits from inspect as before, with reason — \"no limit\" (NanoCpus >= threads) does NOT travel along as a hard limit", () => {
  const hc = { Memory: 8 * G, NanoCpus: 4e9, CpuShares: 2600 }; // "no limit" of 4 threads, after a save
  const cases = [
    [desiredFrom(withoutFile(`4\n${UNIT}`)), A, /resources-desired\.json missing/],
    [desiredFrom(`4\n${UNIT}\n${DESIRED_MARKER}\n{`), A, /resources-desired\.json unreadable/],
    [desiredFrom(withFile({ [B]: { memory: 4 * G, nanoCpus: 0, cpuShares: 2600 } })), A, /no stored value for 0b0b0b0b-aaaa/],
    [desiredFrom(withFile({ [A]: { memory: 4 * G, nanoCpus: 0, cpuShares: 2600 } })), null, /without label cbase\.user/],
  ];
  for (const [desired, uid, reason] of cases) {
    const g = swapLimits(hc, desired, uid);
    assert.equal(g.source, "inspect");
    assert.match(g.reason, reason);
    assert.deepEqual(g.args, ["--memory", String(8 * G), "--cpu-shares", "2600"], "4 of 4 threads is no limit — no --cpus");
  }
  // On a host with 8 threads the same number is a real hard limit (it then does not come from "none") and stays.
  assert.deepEqual(swapLimits(hc, desiredFrom(withoutFile(`8\n${UNIT}`)), A).args, ["--memory", String(8 * G), "--cpus", "4", "--cpu-shares", "2600"]);
  assert.deepEqual(limitsFromInspect({ NanoCpus: 2e9 }, 4), ["--cpus", "2"], "a real hard limit stays");
  // Host unreadable: as before, with --cpus (the threads are unknown — unknown is not equality).
  const blind = swapLimits(hc, desiredFrom("Failed to connect to bus\n"), A);
  assert.deepEqual([blind.source, blind.reason, blind.args], ["inspect", "host unreadable (nproc)", ["--memory", String(8 * G), "--cpus", "4", "--cpu-shares", "2600"]]);
  assert.deepEqual(limitsFromInspect({ Memory: 0, NanoCpus: 0, CpuShares: 0 }, 4), [], "never set drops out");
});

test("(8) specWithLimits: replaces exactly the limits of the spec, in place; a value that looks like a switch stays a value; unknown raises", () => {
  const spec = ["-d", "--init", "--stop-timeout", "60", "--name", "cbase-u-a", "--label", "cbase.user=a", "-e", "--cpus",
    "-p", "127.0.0.1:0:7718", "-v", "h:/home/agent", "--runtime", "sysbox-runc", "--memory", "4294967296", "--cpus", "4",
    "--cpu-shares", "2600", "--restart", "unless-stopped", "--network", "n"];
  const fresh = ["--memory", String(6 * G), "--memory-swap", String(12 * G), "--cpu-shares", "5220"];
  const out = specWithLimits(spec, fresh);
  assert.deepEqual(out, [...spec.slice(0, 16), ...fresh, "--restart", "unless-stopped", "--network", "n"]);
  assert.deepEqual(specWithLimits(out, fresh), out, "applied twice = once (--memory-swap drops too)");
  assert.deepEqual(specWithLimits(["-d", "--name", "x", "--restart", "no"], ["--memory", "1"]), ["-d", "--name", "x", "--memory", "1", "--restart", "no"]);
  assert.deepEqual(specWithLimits(["-d", "--name", "x"], ["--memory", "1"]), ["-d", "--name", "x", "--memory", "1"]);
  assert.throws(() => specWithLimits(["-d", "--privileged", "--name", "x"], []), /unexpected word in the spec: --privileged/);
  assert.throws(() => specWithLimits(["-d", "--name"], []), /unexpected word/);
});

// A seam for lib/limits-swap.mjs: `probe` answers the read commands (desired file, docker info, memory.current) from `welt`,
// `act` records the writes, `inspect` returns the NEW B. `desired` is the content of resources-desired.json (or null = missing).
const ID = "f".repeat(64);
function welt({ desired, hostConfig, memCurrent = null, threads = 4, updateFails = false, id = ID }) {
  const probes = [];
  const akte = [];
  return {
    probes, akte,
    seam: {
      root: "/srv/hx",
      probe: async (cmd) => {
        probes.push(cmd);
        if (cmd === limitsCommand("/srv/hx")) return { code: 0, stdout: desired === null ? withoutFile(`${threads}\n${UNIT}`) : withFile(desired, threads) };
        if (cmd.startsWith("docker info")) return { code: 0, stdout: "systemd 2\n" };
        if (cmd === `cat /sys/fs/cgroup/system.slice/docker-${id}.scope/memory.current`) {
          return memCurrent === null ? { code: 1, stdout: "", stderr: "No such file" } : { code: 0, stdout: `${memCurrent}\n` };
        }
        throw new Error(`unexpected command: ${cmd}`);
      },
      act: async (cmd) => { akte.push(cmd); return updateFails ? { code: 1, stderr: "Error response from daemon: broken\n" } : { code: 0, stdout: "" }; },
      inspect: async (name) => ({ Id: id, Name: `/${name}`, Config: { Labels: { "cbase.user": A } }, HostConfig: hostConfig }),
    },
  };
}
const entry = (ramGiB, cpuPrio = "normal", cpuMax = null, threads = 4) => desiredFileContent([{ userId: A, ramGiB, cpuPrio, cpuMax }], threads)[A];

test("(9) at the swap: ONE read of the desired file before the swap (the value stored since the gate wins); afterwards adjust by id — lowering only against memory.current + buffer", async () => {
  const altB = { Name: "/cbase-u-a", Config: { Labels: { "cbase.user": A } }, HostConfig: { Memory: 4 * G, NanoCpus: 0, CpuShares: 2600 } };

  // Before: inspect (before the gate) says 4 GiB, stored by now is 6 GiB/up — the swap takes 6 GiB/up.
  const v = welt({ desired: { [A]: entry(6, "up") }, hostConfig: null });
  const g = await limitsBeforeSwap(altB, v.seam);
  assert.deepEqual(v.probes, [limitsCommand("/srv/hx")], "exactly ONE ssh, read-only");
  assert.deepEqual([g.source, g.args], ["desired", argsForCreation({ ramGiB: 6, cpuPrio: "up", cpuMax: null }, 4)]);
  // Without the file: from inspect as before — named as the reason.
  const without = await limitsBeforeSwap(altB, welt({ desired: null, hostConfig: null }).seam);
  assert.deepEqual([without.source, without.args], ["inspect", ["--memory", String(4 * G), "--cpu-shares", "2600"]]);
  assert.match(without.reason, /resources-desired\.json missing/);

  // Afterwards == stored: nothing to do.
  const equal = welt({ desired: { [A]: entry(6, "up") }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 5220 } });
  const r1 = await limitsAfterSwap("cbase-u-a", equal.seam);
  assert.deepEqual([r1.action, r1.row[2], equal.akte], ["equal", "ok", []]);

  // A save DURING the swap (8 GiB, hard limit 2) hit the old B — the new one carries 6 GiB: adjust, by id,
  // with the arguments of saving in the gateway (argsForUpdate).
  const higher = welt({ desired: { [A]: entry(8, "up", 2) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 5220 } });
  const r2 = await limitsAfterSwap("cbase-u-a", higher.seam);
  assert.equal(r2.action, "update");
  assert.deepEqual(higher.akte, [`docker update ${argsForUpdate({ ramGiB: 8, cpuPrio: "up", cpuMax: 2 }, 4).join(" ")} ${ID} >/dev/null`]);
  assert.ok(!higher.probes.some((c) => c.includes("memory.current")), "raising does not measure");

  // "No limit" stored, the new B carries a hard 2: adjust with --cpus <threads> (--cpus 0 lifts nothing).
  const withoutLimit = welt({ desired: { [A]: entry(6, "up") }, hostConfig: { Memory: 6 * G, NanoCpus: 2e9, CpuShares: 5220 } });
  await limitsAfterSwap("cbase-u-a", withoutLimit.seam);
  assert.match(withoutLimit.akte[0], new RegExp(`--cpus 4 ${ID} >/dev/null$`));

  // Lowering to 2 GiB: memory.current 1.6 GiB + 0.5 GiB buffer > 2 GiB => warn, touch nothing.
  const tight = welt({ desired: { [A]: entry(2) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 2600 }, memCurrent: Math.round(1.6 * G) });
  const r3 = await limitsAfterSwap("cbase-u-a", tight.seam);
  assert.deepEqual([r3.action, r3.row[2], tight.akte], ["warn", "warn", []]);
  assert.match(r3.row[1], /DEVIATES from 2 GiB .* not lowered: The container currently occupies 1,6 GiB/);
  assert.ok(tight.probes.includes(`cat /sys/fs/cgroup/system.slice/docker-${ID}.scope/memory.current`), "measured at the cgroup path of the gateway");
  // ...with 1 GiB occupied: lower.
  const clearance = welt({ desired: { [A]: entry(2) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 2600 }, memCurrent: G });
  assert.equal((await limitsAfterSwap("cbase-u-a", clearance.seam)).action, "update");
  assert.match(clearance.akte[0], new RegExp(`^docker update --memory ${2 * G} --memory-swap ${4 * G} `));
  // ...not measurable: do not lower (lowering only against a measurement).
  const blind = welt({ desired: { [A]: entry(2) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 2600 }, memCurrent: null });
  const r4 = await limitsAfterSwap("cbase-u-a", blind.seam);
  assert.deepEqual([r4.action, blind.akte], ["warn", []]);
  assert.match(r4.row[1], /cannot be measured/);

  // Without file: not checked (warning), nothing touched; a failed update: warning, no throw.
  const no = welt({ desired: null, hostConfig: { Memory: 6 * G } });
  const r5 = await limitsAfterSwap("cbase-u-a", no.seam);
  assert.deepEqual([r5.action, r5.row[2], no.akte], ["unchecked", "warn", []]);
  const broken = welt({ desired: { [A]: entry(8) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 2600 }, updateFails: true });
  const r6 = await limitsAfterSwap("cbase-u-a", broken.seam);
  assert.deepEqual([r6.action, r6.row[2]], ["warn", "warn"]);
  assert.match(r6.row[1], /docker update failed: Error response from daemon: broken/);
  // An id that is none: never fall back to the name.
  const withoutId = welt({ desired: { [A]: entry(8) }, hostConfig: { Memory: 6 * G, NanoCpus: 0, CpuShares: 2600 }, id: "cbase-u-a" });
  assert.deepEqual([(await limitsAfterSwap("cbase-u-a", withoutId.seam)).action, withoutId.akte], ["warn", []]);
});

test("(10) wiring: deploy and rollback read the limits immediately BEFORE each swap and adjust afterwards", () => {
  const server = fs.readFileSync(path.join(HERE, "targets", "server.mjs"), "utf8");
  const rollback = fs.readFileSync(path.join(HERE, "targets", "rollback.mjs"), "utf8");
  // Deploy: in the swap loop, after the idle check per B, directly before swapContainer — and right after (not in a dry run).
  assert.match(server, /const limits = await limitsBeforeSwap\(t\.insp\);\n\s*await swapContainer\(t\.name, specWithLimits\(t\.spec, limits\.args\), newDigest\);\n\s*if \(isDryRun\(\)\) continue;\n(?:\s*\/\/.*\n)*\s*const limitsAfterwards = await limitsAfterSwap\(t\.name\);/);
  assert.ok(server.indexOf("const before = await idleBeforeSwap(t.name") < server.indexOf("await limitsBeforeSwap(t.insp)"), "after the idle check per B");
  assert.doesNotMatch(server, /swapContainer\(t\.name, t\.spec,/, "no swap with the limits from before the gate");
  // Rollback: the same per B.
  assert.match(rollback, /const limits = await limitsBeforeSwap\(insps\.get\(c\)\);\n\s*const r = await swapContainer\(c, specWithLimits\(specs\.get\(c\), limits\.args\),/);
  assert.match(rollback, /swapped\.push\(c\);\n(?:\s*\/\/.*\n)*\s*if \(!isDryRun\(\)\) await limitsAfterSwap\(c\);/);
  assert.doesNotMatch(rollback, /swapContainer\(c, specs\.get\(c\),/);
});
