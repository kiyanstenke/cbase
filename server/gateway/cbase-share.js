// cbase's share of the server: `hostResources()` in containers.js carries `cbase: { memBytes, cpuCores, swapBytes, diskBytes, at,
// diskAt }` — the sum over ALL user containers (label `cbase.gateway=1`). Project containers run INSIDE (Sysbox, inner dockerd):
// their cgroups hang under the user container's (`…/docker-<id>.scope/docker/<inner id>`), so they are already in its numbers —
// only the top level is counted.
//
// Layout on the server (Docker, cgroup v2, systemd driver): a user container's files live under
// /sys/fs/cgroup/system.slice/docker-<full id>.scope/ (mode 0444 — the gateway user reads them; the unit runs in the same mount
// and cgroup namespace as a user shell).
//
//  RAM     Σ memory.current − inactive_file (memory.stat) — the "working set", like the backend's save gate
//          (server/backend/electron/server/workflows/storage-gate.js): the page cache the kernel can release at any time is not
//          consumption. If memory.stat or its line is missing, memory.current counts (as there); more cache than current ⇒ 0.
//  Swap    Σ memory.swap.current.
//  CPU     Cores in use = Σ growth of usage_usec (cpu.stat) / elapsed time, between two measurements. The meter remembers the
//          last one. If it is missing or older than CPU_WINDOW_MAX_MS (gateway start, a gap, nobody looked for a long time),
//          `measure()` takes a base measurement, waits CPU_WINDOW_MIN_MS and measures again — the answer then carries the value
//          of this fresh window, once ≈ 1 s later (otherwise the FIRST answer would be `null`, and a stale base from hours ago
//          would yield an average over hours). A base measurement in progress is shared by concurrent queries. If the last one
//          is less than CPU_WINDOW_MIN_MS old, the value of the last window stands and the last measurement stays (two pills in
//          the same tick do not ruin each other's window). A container without a value in the last measurement (just started)
//          makes the window unknown ⇒ null, once; one that has gone since drops out of the sum. If no cbase container runs, it is
//          0 cores — measured, without a window.
//  Disk    from `docker system df -v`: the volumes `cbase-u-<id>-home`/`-docker`, the images `cbase-*` (per content the
//          UniqueSize, plus the largest SharedSize ONCE — the shared layers of the candidate images lie on disk once; an
//          approximation) and the writable layer of the user containers. Expensive (the daemon walks every volume): NEVER in the
//          request. A response triggers at most one background measurement per DISK_INTERVAL_MS and returns the last state — `null`
//          until the first; `diskAt` is the time of the measurement. Whoever does not look costs nothing.
//
//  Per container (administration): `measure({ perContainer: true })` additionally carries `perContainer: { <full id>: { ramBytes,
//          cpuThreads } }` — the SAME probe and the SAME window as the sum (no second meter that would shift the first one's
//          window): RAM is the container's working set, CPU its growth of usage_usec in the sum's window. A container without a
//          value in the last measurement is `null` on its own (the others stay measured — unlike the sum, which is then entirely
//          unknown). Without the option the response stays byte-equal (/gw/host returns it unchanged). `cgroupCount(id, file)`
//          reads a number from ONE container's cgroup (cpu.weight for the administration's `actual`) via the same driver and root.
//
// Empty is not unknown: if something is missing or unreadable (not Linux, cgroup v1, unknown driver, a file of ONE container
// missing, docker not answering), the FIELD is `null` — never 0. 0 means: measured, and no cbase container runs.
//
// Seams for tests: `meterFor({ docker, read, clock, root, wait })` — `docker(args, {timeout})` returns stdout, `read(path)` the
// text of a file, `clock()` ms, `root()` the prefix before /sys/fs/cgroup, `wait(ms)` the base-measurement pause (default
// setTimeout). The gateway's meter (containers.js) takes the real ones and GW_CGROUP_ROOT as root (default empty = `/`, read at
// runtime — like CBASE_STORAGE_ROOT in the backend).
// Guard: cbase-share.test.js.
import fs from "node:fs";

export const LABEL = "cbase.gateway=1";
export const DISK_INTERVAL_MS = 10 * 60_000;
// Cap for one `docker system df` (takes ≈ 7 s on the server): if the daemon hangs, the measurement fails after two minutes (null).
export const DISK_CAP_MS = 120_000;
export const CPU_WINDOW_MIN_MS = 1000;
// Older than this, a last measurement is no basis any more — `measure()` takes a fresh window (see header, CPU). The pills ask
// every 15 s (web) or 20 s (iOS); whoever is looking never waits.
export const CPU_WINDOW_MAX_MS = 60_000;

const CBASE_VOLUME = /^cbase-u-.+-(home|docker)$/;
const CBASE_IMAGE = /^cbase-/;
// go-units HumanSizeWithPrecision (the format of `docker system df`): decimal units, powers of 1000.
const UNIT = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, EB: 1e18 };

/** "3.49GB" → 3 490 000 000; "N/A", binary units, empty or negative values ⇒ null. */
export function sizeInBytes(text) {
  const m = /^\s*(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(B|kB|KB|MB|GB|TB|PB|EB)\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const n = Number(m[1]) * UNIT[m[2]];
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** A container's cgroup directory from its full id and the daemon's driver — only under cgroup v2, otherwise null. */
export function cgroupDirectory(id, kind, root = "") {
  if (!kind || String(kind.version) !== "2" || !/^[0-9a-f]{64}$/.test(String(id))) return null;
  if (kind.driver === "systemd") return `${root}/sys/fs/cgroup/system.slice/docker-${id}.scope`;
  if (kind.driver === "cgroupfs") return `${root}/sys/fs/cgroup/docker/${id}`;
  return null;
}

function text(read2, path) {
  try {
    const t = read2(path);
    return typeof t === "string" ? t : null;
  } catch { return null; }
}
// An integer ≥ 0 from a cgroup file; "max", empty or broken ⇒ null.
function count(t) {
  const s = String(t ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}
// A field "name 1234" from memory.stat or cpu.stat; the line must match COMPLETELY (`total_inactive_file` is a different field).
function field(t, name) {
  const m = new RegExp(`^${name} (\\d+)$`, "m").exec(String(t ?? ""));
  return m ? Number(m[1]) : null;
}

/** What a container currently occupies: `{ occupied, swap, usec }` in bytes resp. µs — each field null if its file is missing. */
export function containerState(dir, read2) {
  const current = count(text(read2, `${dir}/memory.current`));
  const inactive = current === null ? null : field(text(read2, `${dir}/memory.stat`), "inactive_file");
  return {
    occupied: current === null ? null : inactive === null ? current : Math.max(0, current - inactive),
    swap: count(text(read2, `${dir}/memory.swap.current`)),
    usec: field(text(read2, `${dir}/cpu.stat`), "usage_usec"),
  };
}

/** cbase's bytes from `docker system df -v --format '{{json .}}'` (one object); unreadable or a size "N/A" ⇒ null. */
export function diskBytesFromDf(stdout) {
  let d;
  try { d = JSON.parse(String(stdout ?? "").trim()); } catch { return null; }
  if (!d || !Array.isArray(d.Images) || !Array.isArray(d.Volumes) || !Array.isArray(d.Containers)) return null;
  // Images per CONTENT (the same id under two tags is one image).
  const images = new Map();
  for (const i of d.Images) if (CBASE_IMAGE.test(String(i?.Repository ?? ""))) images.set(String(i.ID), i);
  let sum = 0;
  let shared = 0;
  for (const i of images.values()) {
    const own = sizeInBytes(i.UniqueSize);
    const including = sizeInBytes(i.SharedSize);
    if (own === null || including === null) return null;
    sum += own;
    shared = Math.max(shared, including);
  }
  sum += shared;
  for (const v of d.Volumes) {
    if (!CBASE_VOLUME.test(String(v?.Name ?? ""))) continue;
    const g = sizeInBytes(v.Size);
    if (g === null) return null;
    sum += g;
  }
  for (const c of d.Containers) {
    if (!String(c?.Labels ?? "").split(",").includes(LABEL)) continue;
    const g = sizeInBytes(c.Size);
    if (g === null) return null;
    sum += g;
  }
  return sum;
}

const read = (p) => fs.readFileSync(p, "utf8");
const environmentRoot = () => String(process.env.GW_CGROUP_ROOT || "").replace(/\/+$/, "");

/** A meter with its own memory (last CPU measurement, last disk state). `measure()` never throws. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function meterFor({ docker, read: read2 = read, clock = Date.now, root = environmentRoot, wait = sleep } = {}) {
  let cgroup = null; // { driver, version } after the first readable `docker info`
  let last = null; // { at, usec: Map<id, µs> }
  let lastCores = null;
  let lastPer = new Map(); // id → threads in the last window (or null)
  let reason = null; // the running pause of a base measurement (shared)
  let disk = { bytes: null, at: null };
  let diskAttempt = null;
  let diskRun = null;

  async function cgroupKind() {
    if (cgroup) return cgroup;
    const [driver, version] = String(await docker(["info", "--format", "{{.CgroupDriver}} {{.CgroupVersion}}"])).trim().split(/\s+/);
    if (driver && version) cgroup = { driver, version };
    return cgroup;
  }

  function kickDiskOn(now) {
    if (diskRun || (diskAttempt !== null && now - diskAttempt < DISK_INTERVAL_MS)) return;
    diskAttempt = now;
    diskRun = (async () => {
      let bytes = null;
      try { bytes = diskBytesFromDf(await docker(["system", "df", "-v", "--format", "{{json .}}"], { timeout: DISK_CAP_MS })); }
      catch { bytes = null; }
      disk = { bytes, at: bytes === null ? null : clock() };
    })().finally(() => { diskRun = null; });
  }

  const round = (x) => Math.round(x * 100) / 100;
  function cores(now, usec, { fresh = false } = {}) {
    if (usec === null) { last = null; lastCores = null; lastPer = new Map(); return null; }
    // `fresh`: the base measurement's window — it counts even if the pause was a hair shorter than CPU_WINDOW_MIN_MS.
    if (!fresh && last && now - last.at < CPU_WINDOW_MIN_MS) return lastCores;
    let k = usec.size === 0 ? 0 : null; // no cbase container: 0 cores, measured
    const byKey = new Map();
    if (last && usec.size && now > last.at) {
      const window = (now - last.at) * 1000;
      let sum = 0;
      let known = true;
      for (const [cid, u] of usec) {
        const prior = last.usec.get(cid);
        if (prior === undefined || u < prior) { known = false; byKey.set(cid, null); continue; }
        sum += u - prior;
        byKey.set(cid, round((u - prior) / window));
      }
      if (known) k = round(sum / window);
    }
    last = { at: now, usec };
    lastCores = k;
    lastPer = byKey;
    return k;
  }

  // One probe of the cgroup files: `{ mem, swap, usec, occupied }` over the containers `ids` (see header; an unreadable field ⇒ null);
  // `occupied` per container (id → working set or null) for `perContainer`.
  function probe(ids, kind, w) {
    let mem = 0;
    let swap = 0;
    let usec = new Map();
    const occupied = new Map();
    for (const cid of ids) {
      const dir = cgroupDirectory(cid, kind, w);
      const st = dir ? containerState(dir, read2) : { occupied: null, swap: null, usec: null };
      occupied.set(cid, st.occupied);
      mem = mem === null || st.occupied === null ? null : mem + st.occupied;
      swap = swap === null || st.swap === null ? null : swap + st.swap;
      if (usec && st.usec !== null) usec.set(cid, st.usec);
      else usec = null;
    }
    return { mem, swap, usec, occupied };
  }

  async function measure({ perContainer = false } = {}) {
    let now = clock();
    kickDiskOn(now);
    const result = { memBytes: null, cpuCores: null, swapBytes: null, diskBytes: disk.bytes, at: now, diskAt: disk.at };
    let ids;
    try {
      ids = String(await docker(["ps", "-q", "--no-trunc", "--filter", `label=${LABEL}`])).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch { return perContainer ? { ...result, perContainer: null } : result; }
    let kind = null;
    if (ids.length) { try { kind = await cgroupKind(); } catch { kind = null; } }
    const w = root();
    let p = probe(ids, kind, w);
    let fresh = false;
    if (p.usec && p.usec.size && reason) {
      // A base measurement is running (gateway start and the first pill at once): its window applies here too.
      await reason;
      now = clock();
      result.at = now;
      p = probe(ids, kind, w);
    } else if (p.usec && p.usec.size && (!last || now - last.at >= CPU_WINDOW_MAX_MS)) {
      // Base measurement: without a (fresh) last one there would be no window — open one and wait (see header, CPU).
      last = { at: now, usec: p.usec };
      lastCores = null;
      const pause = Promise.resolve().then(() => wait(CPU_WINDOW_MIN_MS)).catch(() => {});
      reason = pause;
      try { await pause; } finally { if (reason === pause) reason = null; }
      now = clock();
      result.at = now;
      p = probe(ids, kind, w);
      fresh = true;
    }
    result.memBytes = p.mem;
    result.swapBytes = p.swap;
    result.cpuCores = cores(now, p.usec, { fresh });
    if (!perContainer) return result;
    const byKey = {};
    for (const cid of ids) byKey[cid] = { ramBytes: p.occupied.get(cid) ?? null, cpuThreads: lastPer.get(cid) ?? null };
    return { ...result, perContainer: byKey };
  }

  async function cgroupCount(cid, file) {
    let kind;
    try { kind = await cgroupKind(); } catch { return null; }
    const dir = cgroupDirectory(cid, kind, root());
    return dir ? count(text(read2, `${dir}/${file}`)) : null;
  }

  // For the test: the running background measurement (or a resolved promise) — so it waits for the event, not for time.
  const diskFinished = () => diskRun ?? Promise.resolve();

  return { measure, diskFinished, cgroupCount };
}
