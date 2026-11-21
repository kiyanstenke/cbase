// cbase's share of the server (cbase-share.js).
//
// No server and no timers: a fake cgroup root in the temp directory (same file names as measured on the server, cgroup v2), a
// fake `docker` as a function (it filters `ps` by the label itself — a meter that forgets the filter gets the foreign container
// too), a clock the test sets.
//
// The promises and the sabotage that breaks each:
//  - Sum ONLY over the cbase containers (label cbase.gateway=1), RAM as working set (current - inactive_file).
//      Sabotage: drop `--filter label=...` from the `ps` => 4 tests red, among them "sum of the cbase containers only" (the
//      foreign one counted); `occupied: current` => 3 red (2400 expected, 3100 measured).
//  - CPU from a window between two measurements, never from one alone. Therefore `measure()` without a (fresh) base measurement
//    measures twice with a pause of CPU_WINDOW_MIN_MS in between (`wait`, injected here: it advances the fake clock and changes
//    the cgroup values — no timer); the FIRST answer carries a number. "Nothing runs" is 0 at once (no cbase container: 0
//    cores, measured — no window needed). A new container inside a running window stays null, once.
//      Tests: "base measurement ..." (the first answer carries a number), "... stale ..." (a base from an hour ago does not
//      count) and "... shared ..." (a running base measurement serves the concurrent query). Sabotage: drop the condition
//      `now - last.at >= CPU_WINDOW_MAX_MS` => "stale" red (0.1 instead of 2 — the hourly mean); drop the branch of the running
//      base measurement => "shared" red (the second null).
//  - Disk in the background: the first answer `null` although `docker system df` delivers at once — whoever waits in the request
//    would have the value already; a new kick at most every 10 min.
//      Sabotage: in measure() `await diskRun;` after the kick => "disk in the background" red; drop the interval condition
//      (`if (diskRun) return;`) => likewise red (second run within 10 min).
//  - Disk counts only cbase: volumes `cbase-u-<id>-home/-docker`, images `cbase-*` (per content once, shared layers once), the
//    write layer of the user containers — no foreign volume, no foreign image.
//      Sabotage: loosen the volume pattern to /^cbase-/ => "disk counts only cbase" red (cbase-foreign-cache counted); images
//      per tag instead of per id => likewise red (latest = cand-2 twice).
//  - Unreadable => null, never 0 (empty is not unknown).
//      Sabotage: a missing memory.current counts as 0 (`?? 0`) => "unreadable" red.
// In containers.test.js ("hostResources ..."): drop `cbase` from the answer of hostResources => red; the gateway's meter without
// the label filter => red.
// Run:  cd server/gateway && node --test --test-reporter=tap cbase-share.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CPU_WINDOW_MIN_MS, DISK_INTERVAL_MS, cgroupDirectory, sizeInBytes, meterFor, diskBytesFromDf,
} from "./cbase-share.js";

// The meter with the base-measurement pause WITHOUT a timer: `wait(ms)` advances the fake clock (see `clock` below). Whoever wants
// something to happen during the pause passes their own `wait`.
const meter = (o) => meterFor({ wait: async (ms) => { o.clock.now += ms; }, ...o });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-cbase-"));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

const id = (z) => z.repeat(64);
const A = id("a"); // cbase user container 1
const B = id("b"); // cbase user container 2
const C = id("c"); // foreign container on the same host (n8n, postgres ...)

// A cgroup root with the files per container — shaped like on the server (systemd driver: system.slice/docker-<id>.scope).
function rootWith(state, { driver = "systemd" } = {}) {
  const w = fs.mkdtempSync(path.join(tmp, "w-"));
  for (const [cid, f] of Object.entries(state)) {
    const dir = driver === "systemd" ? path.join(w, "sys/fs/cgroup/system.slice", `docker-${cid}.scope`) : path.join(w, "sys/fs/cgroup/docker", cid);
    fs.mkdirSync(dir, { recursive: true });
    if (f.current !== undefined) fs.writeFileSync(path.join(dir, "memory.current"), `${f.current}\n`);
    if (f.inactive !== undefined) fs.writeFileSync(path.join(dir, "memory.stat"), `anon 1\nfile 2\ninactive_file ${f.inactive}\nactive_file 3\n`);
    if (f.swap !== undefined) fs.writeFileSync(path.join(dir, "memory.swap.current"), `${f.swap}\n`);
    if (f.usec !== undefined) fs.writeFileSync(path.join(dir, "cpu.stat"), `usage_usec ${f.usec}\nuser_usec 1\nsystem_usec 1\n`);
  }
  return w;
}
const setUsec = (w, cid, usec) =>
  fs.writeFileSync(path.join(w, "sys/fs/cgroup/system.slice", `docker-${cid}.scope`, "cpu.stat"), `usage_usec ${usec}\nuser_usec 1\n`);

// The fake docker: knows containers with labels, `info` and `system df`. `ps` filters by the label like the real one.
function fakeDocker({ container = { [A]: ["cbase.gateway=1"], [B]: ["cbase.gateway=1"], [C]: ["com.example=1"] }, info = "systemd 2", df = () => "{}" } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") {
      if (fn.psFails) throw new Error("Cannot connect to the Docker daemon");
      const i = args.indexOf("--filter");
      const label = i >= 0 ? String(args[i + 1]).replace(/^label=/, "") : null;
      return Object.entries(container).filter(([, l]) => !label || l.includes(label)).map(([cid]) => `${cid}\n`).join("");
    }
    if (args[0] === "info") return `${info}\n`;
    if (args[0] === "system" && args[1] === "df") return df();
    return "";
  };
  fn.calls = calls;
  return fn;
}
const clock = (start = 1_000_000) => { const u = () => u.now; u.now = start; return u; };

const STATE = {
  [A]: { current: 3000, inactive: 1000, swap: 10, usec: 1_000_000 },
  [B]: { current: 500, inactive: 100, swap: 0, usec: 2_000_000 },
  [C]: { current: 99_999, inactive: 0, swap: 77_777, usec: 9_000_000 },
};

test("sum of the cbase containers only: RAM as working set (current - inactive_file), swap — the foreign one does not count", async () => {
  const w = rootWith(STATE);
  const docker = fakeDocker();
  const m = meter({ docker, clock: clock(), root: () => w });
  const h = await m.measure();
  assert.equal(h.memBytes, (3000 - 1000) + (500 - 100), "RAM: working set of the two cbase containers");
  assert.equal(h.swapBytes, 10);
  assert.ok(docker.calls.some((a) => a === "ps -q --no-trunc --filter label=cbase.gateway=1"), `ps with label filter: ${docker.calls.join(" | ")}`);
  // More cache than current (happens when counting over two files): 0, never negative.
  const w2 = rootWith({ [A]: { current: 100, inactive: 500, swap: 0, usec: 1 } });
  const h2 = await meter({ docker: fakeDocker({ container: { [A]: ["cbase.gateway=1"] } }), clock: clock(), root: () => w2 }).measure();
  assert.equal(h2.memBytes, 0);
  // Without memory.stat, memory.current applies (like the memory gate) — never "off".
  const w3 = rootWith({ [A]: { current: 4096, swap: 0, usec: 1 } });
  const h3 = await meter({ docker: fakeDocker({ container: { [A]: ["cbase.gateway=1"] } }), clock: clock(), root: () => w3 }).measure();
  assert.equal(h3.memBytes, 4096);
});

test("cgroup path from id and driver: systemd and cgroupfs under v2, otherwise null (v1, unknown driver, broken id)", async () => {
  assert.equal(cgroupDirectory(A, { driver: "systemd", version: "2" }, "/w"), `/w/sys/fs/cgroup/system.slice/docker-${A}.scope`);
  assert.equal(cgroupDirectory(A, { driver: "cgroupfs", version: "2" }, ""), `/sys/fs/cgroup/docker/${A}`);
  assert.equal(cgroupDirectory(A, { driver: "systemd", version: "1" }, ""), null);
  assert.equal(cgroupDirectory(A, { driver: "different", version: "2" }, ""), null);
  assert.equal(cgroupDirectory("../../etc", { driver: "systemd", version: "2" }, ""), null);
  // cgroupfs at the meter: the same sum from the other place.
  const w = rootWith(STATE, { driver: "cgroupfs" });
  const h = await meter({ docker: fakeDocker({ info: "cgroupfs 2" }), clock: clock(), root: () => w }).measure();
  assert.equal(h.memBytes, 2400);
  // cgroup v1: the files would have a different shape — no number rather than a wrong one.
  const v1 = await meter({ docker: fakeDocker({ info: "cgroupfs 1" }), clock: clock(), root: () => w }).measure();
  assert.deepEqual([v1.memBytes, v1.swapBytes, v1.cpuCores], [null, null, null]);
});

test("CPU: cores from the growth of usage_usec between two measurements — the first from the base measurement (two probes, pause), never from one alone", async () => {
  const w = rootWith(STATE);
  const u = clock();
  const m = meter({ docker: fakeDocker(), clock: u, root: () => w });
  // The first measurement is a base measurement with a pause (the clock advances 1 s, nothing works) => 0, not null.
  assert.equal((await m.measure()).cpuCores, 0, "first measurement: base measurement, fresh window");
  setUsec(w, A, 1_000_000 + 2_000_000);
  setUsec(w, B, 2_000_000 + 1_000_000);
  setUsec(w, C, 9_000_000 + 50_000_000); // the foreign one works a lot — does not count
  u.now += 2000;
  assert.equal((await m.measure()).cpuCores, 1.5, "3 s CPU in 2 s = 1.5 cores");
  // Window too short (two pills in the same tick): the value of the last window, the last measurement stays.
  setUsec(w, A, 3_000_000 + 400_000);
  u.now += CPU_WINDOW_MIN_MS - 1;
  assert.equal((await m.measure()).cpuCores, 1.5);
  u.now += 1; // now CPU_WINDOW_MIN_MS since the last valid measurement (2000 ms after start + 1000)
  assert.equal((await m.measure()).cpuCores, 0.4, "0.4 s CPU in 1 s");
  // Unreadable => null, and the window starts anew (no calculation across the gap).
  fs.rmSync(path.join(w, "sys/fs/cgroup/system.slice", `docker-${B}.scope`, "cpu.stat"));
  u.now += 5000;
  assert.equal((await m.measure()).cpuCores, null);
  setUsec(w, B, 3_000_000);
  u.now += 5000;
  assert.equal((await m.measure()).cpuCores, 0, "after the gap: base measurement, fresh window");
  u.now += 1000;
  assert.equal((await m.measure()).cpuCores, 0);
  // A new container without a value in the last measurement: the window is unknown — null, once.
  const D = id("d");
  const dDir = path.join(w, "sys/fs/cgroup/system.slice", `docker-${D}.scope`);
  fs.mkdirSync(dDir, { recursive: true });
  for (const [f, t] of [["memory.current", "1"], ["memory.swap.current", "0"], ["cpu.stat", "usage_usec 5\n"]]) fs.writeFileSync(path.join(dDir, f), t);
  const list = { [A]: ["cbase.gateway=1"] };
  const m2 = meter({ docker: fakeDocker({ container: list }), clock: u, root: () => w });
  assert.equal((await m2.measure()).cpuCores, 0, "a new meter: base measurement");
  u.now += 1000;
  assert.equal((await m2.measure()).cpuCores, 0);
  list[D] = ["cbase.gateway=1"];
  u.now += 1000;
  assert.equal((await m2.measure()).cpuCores, null, "new container: the start of its window is unknown");
  u.now += 1000;
  assert.equal((await m2.measure()).cpuCores, 0, "from the next window it counts");
  // A container that still ran in the last measurement and is gone now does not take the window with it.
  delete list[D];
  u.now += 1000;
  assert.equal((await m2.measure()).cpuCores, 0);
});

test("nothing runs: RAM, swap and CPU 0 (measured — no container, no window needed); docker does not answer => null", async () => {
  const u = clock();
  const empty = meter({ docker: fakeDocker({ container: {} }), clock: u, root: () => tmp });
  const h = await empty.measure();
  assert.deepEqual([h.memBytes, h.swapBytes, h.cpuCores], [0, 0, 0], "0 at once");
  assert.equal(u.now, 1_000_000, "no pause without a container");
  u.now += 2000;
  assert.equal((await empty.measure()).cpuCores, 0);
  const docker = fakeDocker();
  docker.psFails = true;
  const tot = await meter({ docker, clock: clock(), root: () => tmp }).measure();
  assert.deepEqual([tot.memBytes, tot.swapBytes, tot.cpuCores], [null, null, null], "without a list nobody knows what cbase occupies");
});

test("unreadable => null, never 0: if memory.current or memory.swap.current of ONE container is missing, the field is null", async () => {
  const withoutCurrent = rootWith({ [A]: STATE[A], [B]: { inactive: 1, swap: 5, usec: 1 } });
  const h = await meter({ docker: fakeDocker(), clock: clock(), root: () => withoutCurrent }).measure();
  assert.equal(h.memBytes, null);
  assert.equal(h.swapBytes, 15, "the swap is readable and counts");
  const withoutSwap = rootWith({ [A]: STATE[A], [B]: { current: 500, inactive: 100, usec: 1 } });
  const h2 = await meter({ docker: fakeDocker(), clock: clock(), root: () => withoutSwap }).measure();
  assert.equal(h2.swapBytes, null);
  assert.equal(h2.memBytes, 2400);
  // Wrong root (not Linux, wrong place): all null.
  const h3 = await meter({ docker: fakeDocker(), clock: clock(), root: () => path.join(tmp, "exists-not") }).measure();
  assert.deepEqual([h3.memBytes, h3.swapBytes, h3.cpuCores], [null, null, null]);
});

// The output of `docker system df -v --format '{{json .}}'` in the shape measured on the server (Docker 28.4.0): ONE object with
// Images, Containers, Volumes, BuildCache; sizes as text in decimal units (go-units, powers of 1000).
const DF = {
  Images: [
    { Repository: "cbase-backend", Tag: "cand-1", ID: "sha256:1", Size: "3.49GB", SharedSize: "3.48GB", UniqueSize: "7.135MB" },
    { Repository: "cbase-backend", Tag: "cand-2", ID: "sha256:2", Size: "3.49GB", SharedSize: "3.48GB", UniqueSize: "7.137MB" },
    { Repository: "cbase-backend", Tag: "latest", ID: "sha256:2", Size: "3.49GB", SharedSize: "3.48GB", UniqueSize: "7.137MB" }, // same content, second tag
    { Repository: "cbase-projectbox", Tag: "cand-1", ID: "sha256:3", Size: "1.86GB", SharedSize: "1.75GB", UniqueSize: "104.8MB" },
    { Repository: "postgres", Tag: "16", ID: "sha256:9", Size: "450MB", SharedSize: "0B", UniqueSize: "450MB" },
  ],
  Containers: [
    { Names: `cbase-u-1`, Labels: "cbase.gateway=1,cbase.user=1", Size: "272kB" },
    { Names: `cbase-u-2`, Labels: "cbase.gateway=1,cbase.user=2", Size: "99.7kB" },
    { Names: "n8n", Labels: "com.example=1", Size: "1.2GB" },
  ],
  Volumes: [
    { Name: "cbase-u-1-home", Size: "16.58GB" },
    { Name: "cbase-u-1-docker", Size: "30.72GB" },
    { Name: "cbase-u-2-home", Size: "1.061GB" },
    { Name: "cbase-u-2-docker", Size: "1.859GB" },
    { Name: "cbase-foreign-cache", Size: "5GB" },
    { Name: "postgres-data", Size: "2GB" },
  ],
  BuildCache: [{ ID: "x", Size: "9GB" }],
};
const DF_CBASE = (7_135_000 + 7_137_000 + 104_800_000 + 3_480_000_000) // images: unique per content + the largest shared amount
  + (272_000 + 99_700) // write layer of the two user containers
  + (16_580_000_000 + 30_720_000_000 + 1_061_000_000 + 1_859_000_000); // the four volumes

test("disk counts only cbase: volumes cbase-u-<id>-home/-docker, images cbase-* (shared layers once), write layer of the user containers", () => {
  assert.equal(diskBytesFromDf(`${JSON.stringify(DF)}\n`), DF_CBASE);
  // Unreadable => null: a size "N/A", broken JSON, an output without the three lists.
  const na = structuredClone(DF);
  na.Volumes[0].Size = "N/A";
  assert.equal(diskBytesFromDf(JSON.stringify(na)), null);
  assert.equal(diskBytesFromDf("Error response from daemon"), null);
  assert.equal(diskBytesFromDf("{}"), null);
  assert.equal(diskBytesFromDf(""), null);
  // No cbase trace on the host: 0 — measured, nothing there.
  assert.equal(diskBytesFromDf(JSON.stringify({ Images: [], Containers: [], Volumes: [{ Name: "postgres-data", Size: "2GB" }], BuildCache: [] })), 0);
});

test("sizes from docker system df: decimal units (go-units), everything else null", () => {
  assert.equal(sizeInBytes("3.49GB"), 3_490_000_000);
  assert.equal(sizeInBytes("272kB"), 272_000);
  assert.equal(sizeInBytes("7.135MB"), 7_135_000);
  assert.equal(sizeInBytes("0B"), 0);
  assert.equal(sizeInBytes("1.2TB"), 1_200_000_000_000);
  for (const broken of ["N/A", "", null, undefined, "1.2GiB", "-1GB", "12", "GB"]) assert.equal(sizeInBytes(broken), null, String(broken));
});

test("disk in the background: the first answer null although docker delivers at once; then the value; a new kick at most every 10 min", async () => {
  const u = clock();
  let dfRuns = 0;
  const docker = fakeDocker({ df: () => { dfRuns++; return JSON.stringify(DF); } });
  const m = meter({ docker, clock: u, root: () => tmp });
  const first = await m.measure();
  assert.equal(first.diskBytes, null, "the first answer does not wait for docker system df");
  assert.equal(first.diskAt, null);
  assert.equal(dfRuns, 1, "but it is kicked off");
  await m.diskFinished();
  u.now += 1000;
  const second = await m.measure();
  assert.equal(second.diskBytes, DF_CBASE);
  assert.equal(second.diskAt, 1_000_000, "time of the measurement, not of the answer");
  assert.equal(dfRuns, 1, "no second run within 10 min");
  u.now = 1_000_000 + DISK_INTERVAL_MS - 1;
  await m.measure();
  await m.diskFinished();
  assert.equal(dfRuns, 1);
  u.now = 1_000_000 + DISK_INTERVAL_MS;
  const third = await m.measure();
  assert.equal(third.diskBytes, DF_CBASE, "until the new measurement is there, the last one applies");
  await m.diskFinished();
  assert.equal(dfRuns, 2, "after 10 min the next run");
  assert.ok(docker.calls.includes("system df -v --format {{json .}}"), docker.calls.join(" | "));
  // If the measurement fails, the value is unknown (null) — not the old one and not 0.
  const broken = fakeDocker({ df: () => { throw new Error("daemon gone"); } });
  const m2 = meter({ docker: broken, clock: u, root: () => tmp });
  await m2.measure();
  await m2.diskFinished();
  assert.equal((await m2.measure()).diskBytes, null);
});

// ── base measurement ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The pause in which "work" happens: it advances the clock by `ms` and lets every cbase container consume `cores` cores in that
// time (usage_usec grows by cores x ms x 1000). No timer.
function work(u, w, state, cores) {
  const calls = [];
  const fn = async (ms) => {
    calls.push(ms);
    for (const cid of [A, B]) { state[cid] += Math.round(cores * ms * 1000); setUsec(w, cid, state[cid]); }
    u.now += ms;
  };
  fn.calls = calls;
  return fn;
}

test("base measurement: the FIRST answer carries cores — two probes with a CPU_WINDOW_MIN_MS pause in between, RAM from the second", async () => {
  const w = rootWith(STATE);
  const u = clock();
  const state = { [A]: STATE[A].usec, [B]: STATE[B].usec };
  const wait = work(u, w, state, 0.75); // 0.75 cores per container => 1.5
  const m = meterFor({ docker: fakeDocker(), clock: u, root: () => w, wait });
  const h = await m.measure();
  assert.equal(h.cpuCores, 1.5, `first answer: ${JSON.stringify(h)}`);
  assert.deepEqual(wait.calls, [CPU_WINDOW_MIN_MS], "exactly one pause of CPU_WINDOW_MIN_MS");
  assert.equal(h.at, 1_000_000 + CPU_WINDOW_MIN_MS, "`at` is the time of the second probe");
  assert.equal(h.memBytes, 2400);
  // The next query on schedule (20 s) measures without a pause over the window since the last one.
  state[A] += 10_000_000;
  setUsec(w, A, state[A]);
  u.now += 20_000;
  assert.equal((await m.measure()).cpuCores, 0.5, "10 s CPU in 20 s");
  assert.equal(wait.calls.length, 1, "no pause on schedule");
});

test("base measurement stale: after more than CPU_WINDOW_MAX_MS without a query a fresh 1-s window counts, not the mean since then", async () => {
  const w = rootWith(STATE);
  const u = clock();
  const state = { [A]: STATE[A].usec, [B]: STATE[B].usec };
  let cores = 0.05;
  const wait = async (ms) => { await work(u, w, state, cores)(ms); };
  const m = meterFor({ docker: fakeDocker(), clock: u, root: () => w, wait });
  assert.equal((await m.measure()).cpuCores, 0.1);
  // For an hour 0.05 cores per container (mean 0.1) — nobody asks. Then both work with 1 core each.
  const HOUR = 3_600_000;
  for (const cid of [A, B]) { state[cid] += Math.round(0.05 * HOUR * 1000); setUsec(w, cid, state[cid]); }
  u.now += HOUR;
  cores = 1;
  assert.equal((await m.measure()).cpuCores, 2, "the value of the fresh window, not the hourly mean 0.1");
});

test("base measurement shared: two concurrent queries (gateway start and first pill) — one pause, both with cores", async () => {
  const w = rootWith(STATE);
  const u = clock();
  const state = { [A]: STATE[A].usec, [B]: STATE[B].usec };
  let enter;
  const inside = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  let pauses = 0;
  const wait = async (ms) => { pauses++; enter(); await gate; await work(u, w, state, 0.5)(ms); };
  const m = meterFor({ docker: fakeDocker(), clock: u, root: () => w, wait });
  const first = m.measure();
  await Promise.race([inside, first]); // the first stands in its pause (or finishes without one — then the test turns red, it does not hang)
  const second = m.measure();
  // The second runs only through microtasks (the fake docker answers at once): after a setImmediate it stands at the running
  // base measurement — only then does the gate open. No duration, just "all microtasks are through".
  await new Promise((r) => setImmediate(r));
  open();
  const [h1, h2] = await Promise.all([first, second]);
  assert.deepEqual([h1.cpuCores, h2.cpuCores, pauses], [1, 1, 1], `${JSON.stringify(h1)} · ${JSON.stringify(h2)}`);
});

// ── per container (administration) ───────────────────────────────────────────────────────────────────────────────────────────
// The administration shows the consumption PER user container — from the SAME probe and the SAME window as the sum (no second
// meter that would shift the window of the first), and /gw/host stays byte-equal.
// Sabotage: measure() ALWAYS appends `perContainer` => "... byte-equal" red (and administration.test.js "list" via /gw/host);
//   in cores() `byKey.set(cid, null); continue;` -> `break` (like the sum) => "a new container ..." red (the old one lost its value)
//   — only because the new one precedes the old one in the list; behind it this sabotage stays green;
//   the early return for a window that is too short sets `lastPer = new Map()` => "... byte-equal" red (per container null
//   instead of 1).
test("per container: the same probe and window as the sum — without the option the answer stays byte-equal (/gw/host)", async () => {
  const w = rootWith(STATE);
  const u = clock();
  const m = meter({ docker: fakeDocker(), clock: u, root: () => w });
  const without = await m.measure();
  assert.deepEqual(Object.keys(without), ["memBytes", "cpuCores", "swapBytes", "diskBytes", "at", "diskAt"], "no new field without the option");
  setUsec(w, A, STATE[A].usec + 2_000_000);
  setUsec(w, B, STATE[B].usec + 1_000_000);
  u.now += 2000;
  const including = await m.measure({ perContainer: true });
  assert.deepEqual(Object.keys(including), [...Object.keys(without), "perContainer"]);
  assert.deepEqual(including.perContainer, {
    [A]: { ramBytes: 3000 - 1000, cpuThreads: 1 },
    [B]: { ramBytes: 500 - 100, cpuThreads: 0.5 },
  }, "the foreign container is missing, RAM is the working set, CPU the growth in the sum's window");
  assert.equal(including.memBytes, 2400);
  assert.equal(including.cpuCores, 1.5, "the sum is the same as without the option");
  // Window too short (two queries in the same tick): per container the value of the last window, like the sum.
  setUsec(w, A, STATE[A].usec + 9_000_000);
  u.now += CPU_WINDOW_MIN_MS - 1;
  const short = await m.measure({ perContainer: true });
  assert.deepEqual([short.cpuCores, short.perContainer[A].cpuThreads, short.perContainer[B].cpuThreads], [1.5, 1, 0.5]);
});

test("per container: a new container is null by itself, the others stay measured; docker does not answer => perContainer null; cgroupCount reads cpu.weight", async () => {
  const D = id("d");
  const w = rootWith({ ...STATE, [D]: { current: 700, inactive: 0, swap: 0, usec: 5 } });
  fs.writeFileSync(path.join(w, "sys/fs/cgroup/system.slice", `docker-${A}.scope`, "cpu.weight"), "50\n");
  const u = clock();
  const list = { [A]: ["cbase.gateway=1"] };
  const m = meter({ docker: fakeDocker({ container: list }), clock: u, root: () => w });
  await m.measure();
  // The new one precedes the old one in the list: breaking the loop at the first unknown (like the sum) would take the old one's
  // value — standing behind it, this error would stay invisible.
  delete list[A];
  list[D] = ["cbase.gateway=1"];
  list[A] = ["cbase.gateway=1"];
  setUsec(w, A, STATE[A].usec + 500_000);
  u.now += 1000;
  const h = await m.measure({ perContainer: true });
  assert.equal(h.cpuCores, null, "the sum does not know the new one's window");
  assert.deepEqual(h.perContainer, { [A]: { ramBytes: 2000, cpuThreads: 0.5 }, [D]: { ramBytes: 700, cpuThreads: null } });
  const docker = fakeDocker();
  docker.psFails = true;
  assert.equal((await meter({ docker, clock: clock(), root: () => w }).measure({ perContainer: true })).perContainer, null, "unknown, not empty");
  assert.equal(await m.cgroupCount(A, "cpu.weight"), 50);
  assert.equal(await m.cgroupCount(B, "cpu.weight"), null, "file missing: null");
  assert.equal(await meter({ docker: fakeDocker({ info: "cgroupfs 1" }), clock: clock(), root: () => w }).cgroupCount(A, "cpu.weight"), null, "cgroup v1: not readable");
});
