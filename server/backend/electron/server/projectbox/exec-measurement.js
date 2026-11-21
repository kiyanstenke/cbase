// Count the exec processes of a project container as well.
//
// WHY. `docker stats` measures the cgroup of the project container. projectbox-entry.sh nests it like docker:dind (init to `/init`,
// `subtree_control` set) — so the root cgroup of the container is no leaf any more, and a `docker exec` from B (wrapper, services,
// terminals, CLI runs, Chromium) cannot join it: runc 1.1.5 in the user namespace of B silently ignores the EBUSY, and the process
// stays in the cgroup of B (`init.scope`). "Resources" therefore showed per instance only what runs in its cgroup: a native dev
// server with about 400 MB was missing, a Chromium with about 1 GB likewise. The cgroup variant (the wrapper enters a leaf cgroup
// under the container) is NOT built — `docker pause` of a copy would then freeze running turns, services and terminals. This is a
// pure display repair.
//
// HOW. B sees the processes of the container in ITS /proc (the PID namespace of B is the parent namespace). Counted only from files
// anyone may read — PID 1 of the container (tini) belongs to root, the backend runs as agent without capabilities, so `ns/pid` of
// PID 1 is closed to it:
//   1. `docker inspect` (through the seam docker.js, ONE call for all) gives per container PID 1 in B and the full id.
//   2. The parent of PID 1 is the containerd-shim of the container. It counts only if its command line carries the id of the
//      container (`containerd-shim-runc-v2 … -id <id>`) — otherwise nothing is added for this container (a foreign parent, say
//      PID 1 of B, would have the processes of OTHER projects under it).
//   3. The whole tree under the shim belongs to the container: PID 1 with everything below, every `docker exec` (a child of the
//      shim) and every orphan of an exec (the kernel attaches it to PID 1 of the container namespace — find_new_reaper crosses no
//      namespace boundary).
//   4. Of that, `docker stats` already counts everything whose cgroup carries the id of the container (`/docker/<id>/init`, the
//      inner containers `/docker/<id>/docker/…`). The rest is added: memory `Pss` from `smaps_rollup` (agent reads its own
//      processes), else `VmRSS` from `status` (readable for all); CPU from `utime + stime` of the two probes (`stat`). If the cgroup
//      of PID 1 does not carry the id either, it is unclear what `docker stats` counted — then nothing is added.
//   Measured (read-only, engine 20.10.24): the parent of PID 1 is `containerd-shim-runc-v2 -namespace moby -id <id> …`, the cgroup
//   of PID 1 `0::/docker/<id>/init`, the exec processes (`cbase-wrapper`, below it `npm`, `node`, `next-server`) lie under the shim
//   in `0::/init.scope` — in a main with a dev server 6 processes, VmRSS about 417 MB that `docker stats` did not see. Readable as
//   agent: cmdline, cgroup, stat, status, smaps_rollup of its own processes; `ns/pid` of PID 1 NOT (hence the tree, not the namespace).
//   The two probes: the first BEFORE the start of the bundled `docker stats`, the second after it (docker itself waits for two
//   probes) — so the measurement extends the 4-s status only by the reading of /proc. A process that arose only between the probes
//   counts with all its ticks; one that ended in between drops out.
//
// withExecProcesses(container[], measure) → Promise<Map container → { up, row }>
//   `measure()` starts today's measurement (services.js instanceStatsAll: `docker stats`) and returns the same Map; it is called
//   exactly once. This Map comes back, per container with `row.cpu`/`row.memBytes` plus the share of the exec processes. Without
//   /proc (the Mac — without an ops marker nobody calls it anyway), without a readable id/PID (the fake docker of the tests does not
//   know `State.Pid`), without a row, or on any unexpected error the Map stays as `measure` returned it — the display of before, never
//   no answer. If a process vanishes in the middle of reading (ENOENT, ESRCH), it drops out quietly.
//
// Seam for the tests: `CBASE_PROC_ROOT` (read at run time) is the directory that plays /proc.
// Guard: server/backend/test/project-instances-pill.test.js (7).
// Only the READING fs functions, one by one (projectbox-rm-in-b.test.js counts every import from node:fs/promises as a possible delete site).
import { readFile, readdir } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { docker } from "./docker.js";

const readFileValue = promisify(readFile);
const readFolder = promisify(readdir);

export const PROC_ROOT = "/proc";
const procRoot = () => process.env.CBASE_PROC_ROOT || PROC_ROOT;
// USER_HZ: the unit of utime/stime in /proc/<pid>/stat is fixed at 100 per second on Linux (sysconf(_SC_CLK_TCK)).
const TICKS_PER_S = 100;
// Like the bundled `docker stats` (services.js STATS_CAP_MS) — inspect runs in parallel with it.
const INSPECT_CAP_MS = 15_000;

// ONE message per container and reason per process life (the status is asked every 4 s while a view is open).
const reported = new Set();
function reportOnce(container, reason) {
  const k = `${container}\u0000${reason}`;
  if (reported.has(k)) return;
  reported.add(k);
  console.warn(`[resources] exec processes of ${container} not counted: ${reason} — docker stats only`);
}

// "pid (comm) S ppid … utime stime … starttime …" — comm may carry spaces and parentheses, counted from the LAST ")".
function statFrom(text) {
  const closed = String(text).lastIndexOf(")");
  if (closed < 0) return null;
  const f = String(text).slice(closed + 2).trim().split(/\s+/);
  const ppid = Number(f[1]);
  const ticks = Number(f[11]) + Number(f[12]);
  if (!Number.isInteger(ppid)) return null;
  return { ppid, ticks: Number.isFinite(ticks) ? ticks : 0, start: f[19] || "" };
}

const read = (root, pid, file) => readFileValue(path.join(root, String(pid), file), "utf8");

// One probe: pid → { ppid, ticks, start } for every process in /proc; null without /proc.
async function probe(root) {
  let names;
  try { names = await readFolder(root); } catch { return null; }
  const map = new Map();
  await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    try { const s = statFrom(await read(root, n, "stat")); if (s) map.set(Number(n), s); } catch { /* gone (ENOENT/ESRCH) */ }
  }));
  return map;
}

// PID 1 (in B) and full id per container — ONE `docker inspect`. If a container is missing, docker ends with exit ≠ 0 but still
// prints the others: they are in stdout of the error.
async function initsOf(container) {
  let stdout = "";
  try {
    stdout = (await docker(["inspect", "--type", "container", "--format", "{{.Name}} {{.State.Pid}} {{.Id}}", ...container],
      { capMs: INSPECT_CAP_MS })).stdout;
  } catch (e) {
    stdout = typeof e?.code === "number" ? e.stdout || "" : "";
  }
  const map = new Map();
  for (const z of String(stdout).split("\n")) {
    const [name, pid, id] = z.trim().split(/\s+/);
    const n = Number(pid);
    if (!name || !Number.isInteger(n) || n <= 0 || !/^[0-9a-f]{64}$/.test(String(id || ""))) continue;
    map.set(name.replace(/^\//, ""), { pid: n, id });
  }
  return map;
}

async function storageBytes(root, pid) {
  try {
    const m = (await read(root, pid, "smaps_rollup")).match(/^Pss:\s+(\d+)\s*kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch { /* not readable (foreign user) or gone — VmRSS */ }
  try {
    const m = (await read(root, pid, "status")).match(/^VmRSS:\s+(\d+)\s*kB/m);
    return m ? Number(m[1]) * 1024 : 0;
  } catch { return 0; }
}

// The share of ONE container: { cpu, memBytes, processes } or null (add nothing).
async function share(root, container, init, prior, after, children, durationS) {
  const one = after.get(init.pid);
  if (!one) return null;
  let cmdline = "";
  try { cmdline = await read(root, one.ppid, "cmdline"); } catch { /* gone */ }
  if (!cmdline.split("\u0000").includes(init.id)) {
    reportOnce(container, `parent process ${one.ppid} of PID 1 is not its containerd-shim`);
    return null;
  }
  let cg = "";
  try { cg = await read(root, init.pid, "cgroup"); } catch { /* gone */ }
  if (!cg.includes(init.id)) {
    reportOnce(container, "the cgroup of PID 1 does not carry the id of the container");
    return null;
  }
  // The tree under the shim (without it). `seen` guards against a cycle from a probe in which a PID was reassigned in the middle
  // of reading.
  const seen = new Set([one.ppid]);
  const tree = [];
  for (const open = [...(children.get(one.ppid) || [])]; open.length;) {
    const p = open.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    tree.push(p);
    open.push(...(children.get(p) || []));
  }
  const byKey = await Promise.all(tree.map(async (p) => {
    let pcg;
    try { pcg = await read(root, p, "cgroup"); } catch { return null; }
    if (pcg.includes(init.id)) return null; // docker stats counts it
    const now = after.get(p);
    const old = prior.get(p);
    return { ticks: Math.max(0, now.ticks - (old && old.start === now.start ? old.ticks : 0)), memBytes: await storageBytes(root, p) };
  }));
  let ticks = 0;
  let memBytes = 0;
  let processes = 0;
  for (const x of byKey) {
    if (!x) continue;
    ticks += x.ticks;
    memBytes += x.memBytes;
    processes += 1;
  }
  return { cpu: durationS > 0 ? (ticks / TICKS_PER_S / durationS) * 100 : 0, memBytes, processes };
}

export async function withExecProcesses(container, measure) {
  const root = procRoot();
  const t1 = performance.now();
  const prior = container.length ? await probe(root).catch(() => null) : null;
  const measured = measure();
  if (!prior) return measured;
  const [map, inits] = await Promise.all([measured, initsOf(container)]);
  try {
    const t2 = performance.now();
    const after = await probe(root);
    if (!after || !(map instanceof Map)) return map;
    const children = new Map();
    for (const [pid, s] of after) {
      if (!children.has(s.ppid)) children.set(s.ppid, []);
      children.get(s.ppid).push(pid);
    }
    const out = new Map(map);
    await Promise.all(container.map(async (c) => {
      const r = map.get(c);
      const init = inits.get(c);
      if (!r?.row || !init) return;
      const a = await share(root, c, init, prior, after, children, (t2 - t1) / 1000);
      if (a?.processes) out.set(c, { ...r, row: { ...r.row, cpu: (Number(r.row.cpu) || 0) + a.cpu, memBytes: (Number(r.row.memBytes) || 0) + a.memBytes } });
    }));
    return out;
  } catch (e) {
    console.warn(`[resources] exec processes not counted: ${e?.message || e} — docker stats only`);
    return map;
  }
}
