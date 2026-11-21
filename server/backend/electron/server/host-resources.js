// Resources of the machine THIS process runs on: RAM, swap, CPU load, disk.
//
// For the resources pill in the header: it used to show only what the running services CONSUME — not what the machine
// still has. In the local server that is the user's Mac. In the user container (Sysbox) `/proc/meminfo` shows the HOST, NOT
// the container's quota (same reading as workflows/storage-gate.js). The container's limits live in the cgroup:
// `quotaResources()` reads `memory.max` (used = `memory.current − inactive_file`, via storageSituation) and `cpu.max`
// (quota / period = number of CPUs), `max` means no limit; with no limit at all (the Mac) `null`. Both read under
// `CBASE_STORAGE_ROOT` (test seam of the storage gate, default empty = `/`). The host's numbers come alongside from the
// gateway (`GET /gw/host`, same shape, own copy in server/gateway/containers.js because gateway and backend are rolled out
// separately; the gateway runs on Linux only and does not need the macOS branch below).
//
// `/proc/meminfo` before `os.freemem()`: MemAvailable counts cache and buffers, which the kernel frees at any time —
// `MemFree` alone would read "almost nothing free" on a server with a page cache although everything is fine. Swap exists
// on Linux only.
//
// macOS: there is no `/proc/meminfo`, and `os.freemem()` counts ONLY the free pages. macOS keeps free memory small on
// purpose and fills it with file cache — measured on a 36 GB Mac: 86–88 % "used" from `os.freemem()` while `memory_pressure`
// reported 71 % free. The services pill colors by exactly this value (> 70 % yellow, > 90 % red) and therefore stood
// permanently yellow on the Mac without anything being scarce. With the calculation below: 63 % used at the same moment.
//
// The calculation is that of Activity Monitor ("Memory Used" = app memory + wired + compressed, app memory = anonymous pages −
// purgeable): available = total − used. This matches the statement of Linux's MemAvailable — file cache and purgeable memory
// are available, anonymous memory is not (freeing it would mean compressing or swapping). `memory_pressure` computes
// differently: its number equals (free + active + inactive + speculative) / total (69.6 % against a reported 71 %) — it also
// counts active anonymous memory as free because the compressor could take it. That is a measure of PRESSURE, not of occupancy.
// Rejected: (free + inactive + speculative + purgeable) — counts inactive ANONYMOUS pages as available and purgeable ones on
// the inactive list twice (measured 57 % used).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { storageSituation } from "./workflows/storage-gate.js";

// The root of the readings (test seam, see header) — read at run time, without a variable `/`.
const root = () => String(process.env.CBASE_STORAGE_ROOT || "").replace(/\/+$/, "");

// The four counters that make up the occupancy. If one is missing (a very old macOS without "Anonymous pages", a reworded
// output), there is NO number rather than a wrong one — the caller then falls back to `os.freemem()`.
const VM_STAT_COUNTER = ["Anonymous pages", "Pages purgeable", "Pages wired down", "Pages occupied by compressor"];

/**
 * Pure calculation over the output of `vm_stat` (macOS). The page size is in the header line ("page size of 16384 bytes" on
 * Apple Silicon, 4096 on Intel) and is read from there — a hard-coded size would be off by a factor of 4 on the other
 * architecture. `totalBytes` is the physical memory (`os.totalmem()` = hw.memsize); `vm_stat` does not give it.
 * Result `{ totalBytes, availableBytes }` or `null` if the output is not readable.
 */
export function vmStatStorage(text, totalBytes) {
  if (typeof text !== "string" || !(Number.isFinite(totalBytes) && totalBytes > 0)) return null;
  const header = /page size of (\d+) bytes/.exec(text);
  const page = header ? Number(header[1]) : 0;
  if (!(page > 0)) return null;
  const values = {};
  for (const row of text.split("\n")) {
    // "Pages free:                               291732." — some names are in quotes ("Translation faults":),
    // the trailing dot is part of the output.
    const m = /^\s*"?([^":]+?)"?:\s+(\d+)\.?\s*$/.exec(row);
    if (m) values[m[1]] = Number(m[2]);
  }
  if (VM_STAT_COUNTER.some((k) => !Number.isFinite(values[k]))) return null;
  const app = Math.max(0, values["Anonymous pages"] - values["Pages purgeable"]);
  const occupied = (app + values["Pages wired down"] + values["Pages occupied by compressor"]) * page;
  return { totalBytes, availableBytes: Math.min(totalBytes, Math.max(0, totalBytes - occupied)) };
}

// `vm_stat` costs a process start (≈ 5 ms). The pill asks every 15 s per client, several windows and the gateway path add
// up — hence a short cache. The deadline bounds a hanging call; if it fails, the fallback applies (not the old value: a
// number from a minute ago under the clock time of now would be a false statement).
const MAC_CACHE_MS = 3000;
let macCache = { at: 0, mem: null };
function macStorage() {
  const now = Date.now();
  if (now - macCache.at < MAC_CACHE_MS) return macCache.mem;
  let mem = null;
  try {
    const r = spawnSync("/usr/bin/vm_stat", [], { encoding: "utf8", timeout: 1500 });
    if (r.status === 0) mem = vmStatStorage(r.stdout, os.totalmem());
  } catch {
    /* no vm_stat — fall back to os.freemem */
  }
  macCache = { at: now, mem };
  return mem;
}

export function hostResources(diskPath = "/") {
  let mem = null;
  let swap = null;
  try {
    const info = fs.readFileSync(`${root()}/proc/meminfo`, "utf8");
    const kb = (key) => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal"), avail = kb("MemAvailable"), swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
    if (total != null && avail != null) mem = { totalBytes: total, availableBytes: avail };
    if (swapTotal != null && swapFree != null && swapTotal > 0) swap = { totalBytes: swapTotal, freeBytes: swapFree };
  } catch {
    /* not Linux — below macOS or os.totalmem/os.freemem */
  }
  if (!mem && process.platform === "darwin") mem = macStorage();
  // Last fallback (neither /proc/meminfo nor vm_stat readable): only the free pages — too pessimistic, but a number the
  // operating system reports as such.
  if (!mem) mem = { totalBytes: os.totalmem(), availableBytes: os.freemem() };
  let disk = null;
  try {
    const s = fs.statfsSync(diskPath);
    disk = { path: diskPath, totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
  } catch {
    /* path not readable — then without disk */
  }
  const [load1, load5, load15] = os.loadavg();
  const count = os.cpus().length || 1;
  return { at: Date.now(), cpu: { count, load1, load5, load15 }, mem, swap, disk };
}

// `cpu.max` (cgroup v2): "<quota> <period>" in µs — "200000 100000" = 2 CPUs; "max …", empty, broken ⇒ null.
function cpuQuota(text) {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const quota = Number(m[1]);
  const period = Number(m[2]);
  return quota > 0 && period > 0 ? Math.round((quota / period) * 100) / 100 : null;
}

/**
 * The quota of THIS container (see header): `{ mem: { totalBytes, usedBytes, availableBytes } | null,
 * cpu: { count } | null }` — `null` if neither memory nor CPU is limited (the Mac, a container without a limit).
 * `read` replaces the reading (like storageSituation).
 */
export function quotaResources({ read } = {}) {
  const situation = storageSituation(read ? { read } : {});
  const c = situation.container;
  const mem = c ? { totalBytes: c.max, usedBytes: c.occupied, availableBytes: Math.max(0, c.max - c.occupied) } : null;
  let cpuText = null;
  try { cpuText = (read || ((p) => fs.readFileSync(p, "utf8")))(`${root()}/sys/fs/cgroup/cpu.max`); } catch { /* no cgroup */ }
  const count = cpuQuota(cpuText);
  const cpu = count ? { count } : null;
  return mem || cpu ? { mem, cpu } : null;
}

/**
 * `memLimitBytes` of a row of /api/project-resources (and its `instances`) never above the quota: `docker stats` reports
 * the machine's limit for a container without a limit of its own — in the user container, though, ITS limit applies. Only for
 * a converted project (`converted`) and only with a memory quota; otherwise the same row. A 0 ("unknown") stays.
 */
export function storageLimitInQuota(row, quota, converted) {
  const limit = quota?.mem?.totalBytes;
  if (!converted || !(limit > 0) || !row) return row;
  const cap = (n) => (Number(n) > limit ? limit : n);
  return {
    ...row,
    memLimitBytes: cap(row.memLimitBytes),
    ...(Array.isArray(row.instances) ? { instances: row.instances.map((i) => ({ ...i, memLimitBytes: cap(i.memLimitBytes) })) } : {}),
  };
}
