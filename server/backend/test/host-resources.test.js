import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";
import * as hostRes from "../electron/server/host-resources.js";

const { hostResources, vmStatStorage } = hostRes;

// ── macOS: "available" from vm_stat ──
//
// hostResources used to take `os.freemem()` on macOS - only the free pages. macOS fills free memory with file cache; the
// services pill thus stood at 86-88 % "occupied" while `memory_pressure` reported 71 % free (head comment of host-resources.js).
//
// Recorded on a Mac (Apple Silicon, hw.memsize 38654705664 = 36 GiB) with `vm_stat`, verbatim. At the same moment
// `memory_pressure` reported 71 % free.
//
// Counter-tests (which sabotage turns which test red): page size fixed 16384 instead of from the header line => "Intel"
// red; drop `- values["Pages purgeable"]` => "recorded" red; a missing counter as 0 instead of null => "without Anonymous
// pages" red; drop the darwin branch in hostResources (fallback os.freemem) => "hostResources on this Mac" red. Set
// `includeDisk` in `projects/routes.js` fixed to `true` (the server no longer reads `disk=0`) => "`disk=0` omits the folder size" red.
const VM_STAT_MAC = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   285613.
Pages active:                                 671477.
Pages inactive:                               671497.
Pages speculative:                             12899.
Pages throttled:                                   0.
Pages wired down:                             321170.
Pages purgeable:                               31096.
"Translation faults":                     2931595544.
Pages copy-on-write:                       168648432.
Pages zero filled:                        3922842116.
Pages reactivated:                          45321078.
Pages purged:                               21054179.
File-backed pages:                            496274.
Anonymous pages:                              859599.
Pages stored in compressor:                   766722.
Pages occupied by compressor:                 341312.
Decompressions:                             30256029.
Compressions:                               47002404.
Pageins:                                    53958484.
Pageouts:                                      11460.
Swapins:                                       65717.
Swapouts:                                     201140.
`;
const MEMSIZE = 38654705664;

test("vmStatStorage: recorded Mac output - occupied is app memory + wired + compressed, not everything except the free pages", () => {
  const m = vmStatStorage(VM_STAT_MAC, MEMSIZE);
  assert.ok(m, "the recorded output is not readable");
  assert.equal(m.totalBytes, MEMSIZE);
  // (Anonymous 859599 - purgeable 31096 + wired 321170 + compressor 341312) x 16384 = 24428298240 occupied.
  assert.equal(m.availableBytes, MEMSIZE - 24428298240);
  const occupied = 1 - m.availableBytes / m.totalBytes;
  const onlyFree = 1 - (285613 * 16384) / MEMSIZE;
  console.log(`  [vm_stat] occupied ${(occupied * 100).toFixed(1)} % (os.freemem would say ${(onlyFree * 100).toFixed(1)} %; memory_pressure at the same moment: 71 % free)`);
  assert.ok(Math.abs(occupied - 0.632) < 0.001, `occupied ${occupied}`);
  // The pill turns yellow from 70 %: the old reading (only free pages) was above, the new one below.
  assert.ok(onlyFree > 0.7 && occupied < 0.7);
});

test("vmStatStorage: the page size comes from the header line - 4096 on Intel, not fixed 16384", () => {
  const intel = VM_STAT_MAC.replace("page size of 16384 bytes", "page size of 4096 bytes");
  const total = 17179869184; // 16 GiB
  const m = vmStatStorage(intel, total);
  assert.ok(m, "the Intel output is not readable");
  assert.equal(m.availableBytes, total - 1490985 * 4096);
});

test("vmStatStorage: unreadable means null (fallback), never a number from missing counters", () => {
  assert.equal(vmStatStorage(VM_STAT_MAC.replace(/^Anonymous pages:.*\n/m, ""), MEMSIZE), null, "without Anonymous pages");
  assert.equal(vmStatStorage(VM_STAT_MAC.replace(/^Pages occupied by compressor:.*\n/m, ""), MEMSIZE), null, "without compressor");
  assert.equal(vmStatStorage(VM_STAT_MAC.replace(/^Mach Virtual.*\n/, ""), MEMSIZE), null, "without header line no page size");
  assert.equal(vmStatStorage("", MEMSIZE), null);
  assert.equal(vmStatStorage(null, MEMSIZE), null);
  assert.equal(vmStatStorage(VM_STAT_MAC, 0), null, "without total size no share");
  // More occupied than total (counter state between two queries): available 0, not negative.
  assert.equal(vmStatStorage(VM_STAT_MAC, 1024).availableBytes, 0);
});

test("hostResources on this Mac: available comes from vm_stat, not from os.freemem", () => {
  // On Linux hostResources reads /proc/meminfo; there the test below checks the shape. No skip: a skipped test counted red
  // in the gate.
  if (process.platform !== "darwin") {
    assert.ok(hostResources(process.cwd()).mem.totalBytes > 0);
    return;
  }
  const read = () => vmStatStorage(spawnSync("/usr/bin/vm_stat", [], { encoding: "utf8" }).stdout, os.totalmem());
  const prior = read();
  const h = hostResources(process.cwd());
  const after = read();
  assert.ok(prior && after, "vm_stat is not readable on this Mac");
  // Tolerance: memory moves between the queries, and hostResources caches for 3 s.
  const tol = Math.max(0.05 * h.mem.totalBytes, 2 ** 30);
  const lo = Math.min(prior.availableBytes, after.availableBytes) - tol;
  const hi = Math.max(prior.availableBytes, after.availableBytes) + tol;
  console.log(`  [vm_stat] hostResources ${(h.mem.availableBytes / 2 ** 30).toFixed(2)} GiB available · vm_stat ${(prior.availableBytes / 2 ** 30).toFixed(2)}-${(after.availableBytes / 2 ** 30).toFixed(2)} GiB · os.freemem ${(os.freemem() / 2 ** 30).toFixed(2)} GiB`);
  assert.ok(h.mem.availableBytes >= lo && h.mem.availableBytes <= hi,
    `hostResources reports ${h.mem.availableBytes} B available, vm_stat ${prior.availableBytes}...${after.availableBytes} - does the darwin branch still read vm_stat?`);
});

test("hostResources: fixed shape, disk at the named path, without a path no disk", () => {
  const h = hostResources(process.cwd());
  assert.ok(h.mem.totalBytes > 0 && h.mem.availableBytes >= 0 && h.mem.availableBytes <= h.mem.totalBytes);
  assert.ok(h.cpu.count >= 1 && Number.isFinite(h.cpu.load1) && Number.isFinite(h.cpu.load15));
  assert.ok(h.swap === null || (h.swap.totalBytes > 0 && h.swap.freeBytes <= h.swap.totalBytes));
  assert.ok(h.disk && h.disk.totalBytes > 0 && h.disk.freeBytes <= h.disk.totalBytes && h.disk.path === process.cwd());
  // An unreadable path costs only the disk, not the answer.
  assert.equal(hostResources("/exists/es/not").disk, null);
});

test("GET /api/project-resources carries `host` - and `disk=0` omits the folder size, without the parameter it is included as before", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { startServer } = await import("../electron/server/server.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-host-resources-"));
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "T", path: root }) })).json();
    const r = await (await fetch(`${base}/api/project-resources?workspaceId=${ws.id}&disk=0`)).json();
    assert.ok(Array.isArray(r.resources), "resources stays a list");
    assert.ok(r.host && r.host.mem.totalBytes > 0 && r.host.cpu.count >= 1, JSON.stringify(r.host));

    // `disk=0` skips the folder size: the services pill stands on EVERY page and asks closed with `disk=0` - the folder size
    // (`du` over every project folder) only shows in its menu. If the server no longer reads the parameter, the `du` would
    // silently run every minute; without it the server computes WITH it as before.
    // Empty folder on creating (a full one would trigger the services scan), the file afterwards.
    const projDir = path.join(root, "proj");
    const proj = await (await fetch(`${base}/api/workspaces/${ws.id}/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "P", path: projDir }) })).json();
    assert.ok(proj.id, JSON.stringify(proj));
    fs.writeFileSync(path.join(projDir, "data.bin"), Buffer.alloc(256 * 1024, 1));
    const without = await (await fetch(`${base}/api/project-resources?workspaceId=${ws.id}&disk=0`)).json();
    const rowWithout = without.resources.find((x) => x.projectId === proj.id);
    assert.equal(rowWithout?.diskBytes, null, `with disk=0 no folder size - ${JSON.stringify(rowWithout)}`);
    const including = await (await fetch(`${base}/api/project-resources?workspaceId=${ws.id}`)).json();
    const rowWith = including.resources.find((x) => x.projectId === proj.id);
    assert.ok(typeof rowWith?.diskBytes === "number" && rowWith.diskBytes >= 256 * 1024, `without the parameter WITH folder size as before - ${JSON.stringify(rowWith)}`);
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { console.warn("cleanup:", e.message); }
  }
});

// ── The quota of the user container ──
//
// In the user container (Sysbox) /proc/meminfo shows the HOST (the same reading as workflows/storage-gate.js) - the limit
// of the container (8 GiB, 2 CPUs) stands in the cgroup. `quota` is separate from `host` (`memory.max` with OCCUPIED =
// `memory.current - inactive_file`, `cpu.max` as a number of CPUs), `max` means no limit, and `memLimitBytes` of a relocated
// project (docker stats reports the limit of the machine when it has none of its own) never exceeds the quota. Root seam as
// in the storage gate: CBASE_STORAGE_ROOT.
// Counter-tests: `quotaResources` always returns null => "cgroup limit" red; the cap in `storageLimitInQuota` gone =>
// "memLimitBytes" red.
const GIB = 1024 ** 3;
function fakeRoot({ memMax = String(8 * GIB), current = String(3 * GIB), stat = `anon 1\ninactive_file ${GIB}\n`, cpuMax = "200000 100000" } = {}) {
  const fs = nodeFs;
  const path = nodePath;
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quota-"));
  fs.mkdirSync(path.join(w, "sys", "fs", "cgroup"), { recursive: true });
  fs.mkdirSync(path.join(w, "proc"), { recursive: true });
  const cg = (n, t) => fs.writeFileSync(path.join(w, "sys", "fs", "cgroup", n), `${t}\n`);
  cg("memory.max", memMax);
  cg("memory.current", current);
  cg("memory.stat", stat);
  cg("cpu.max", cpuMax);
  // The numbers of the HOST: 32 GiB, of which 20 available.
  fs.writeFileSync(path.join(w, "proc", "meminfo"), `MemTotal:       ${32 * 1024 * 1024} kB\nMemFree:        1 kB\nMemAvailable:   ${20 * 1024 * 1024} kB\nSwapTotal:      0 kB\nSwapFree:       0 kB\n`);
  return w;
}
async function withRoot(w, fn) {
  const saved = process.env.CBASE_STORAGE_ROOT;
  process.env.CBASE_STORAGE_ROOT = w;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.CBASE_STORAGE_ROOT; else process.env.CBASE_STORAGE_ROOT = saved;
  }
}

test("cgroup limit (memory.max, cpu.max) as `quota` separate from the host - `max` means no limit", async () => {
  const w = fakeRoot();
  const without = fakeRoot({ memMax: "max", cpuMax: "max 100000" });
  try {
    await withRoot(w, () => {
      const h = hostResources(w);
      assert.deepEqual(h.mem, { totalBytes: 32 * GIB, availableBytes: 20 * GIB }, "host stays the host (/proc/meminfo)");
      assert.equal(typeof hostRes.quotaResources, "function", "quotaResources is missing");
      assert.deepEqual(hostRes.quotaResources(), {
        mem: { totalBytes: 8 * GIB, usedBytes: 2 * GIB, availableBytes: 6 * GIB },
        cpu: { count: 2 },
      });
    });
    // Only the CPU limited, or only the memory: the other part is null.
    fs_write(w, "sys/fs/cgroup/cpu.max", "max 100000");
    await withRoot(w, () => assert.deepEqual(hostRes.quotaResources().cpu, null));
    await withRoot(without, () => {
      assert.equal(hostRes.quotaResources(), null, "without a cgroup limit no quota");
      assert.equal(hostResources(without).mem.totalBytes, 32 * GIB, "only host");
    });
  } finally {
    for (const d of [w, without]) nodeFs.rmSync(d, { recursive: true, force: true });
  }
});
const fs_write = (w, rel, t) => nodeFs.writeFileSync(nodePath.join(w, rel), `${t}\n`);

test("memLimitBytes of a relocated project (and per instance) never exceeds the quota; without quota or without instance unchanged", () => {
  assert.equal(typeof hostRes.storageLimitInQuota, "function", "storageLimitInQuota is missing");
  const k = { mem: { totalBytes: 8 * GIB, usedBytes: 0, availableBytes: 8 * GIB }, cpu: null };
  const row = { projectId: "p1", memBytes: GIB, memLimitBytes: 31 * GIB, instances: [{ identifier: "p1/main", memLimitBytes: 31 * GIB }, { identifier: "p1/copy-k1", memLimitBytes: 0 }] };
  assert.deepEqual(hostRes.storageLimitInQuota(row, k, true), {
    ...row, memLimitBytes: 8 * GIB, instances: [{ identifier: "p1/main", memLimitBytes: 8 * GIB }, { identifier: "p1/copy-k1", memLimitBytes: 0 }],
  });
  assert.equal(hostRes.storageLimitInQuota(row, null, true), row, "without quota the same row");
  assert.equal(hostRes.storageLimitInQuota(row, k, false), row, "without instance the same row");
  const small = { projectId: "p2", memLimitBytes: 2 * GIB };
  assert.deepEqual(hostRes.storageLimitInQuota(small, k, true), small, "a smaller limit stays");
});

test("GET /api/project-resources carries `quota` next to `host`", async () => {
  const fs = nodeFs;
  const path = nodePath;
  const { startServer } = await import("../electron/server/server.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-quota-route-"));
  const w = fakeRoot();
  let server;
  try {
    server = await startServer({ port: 0, dataRoot: path.join(root, "data"), webDir: path.join(root, "web"), pickDirectory: null, notify: null });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ws = await (await fetch(`${base}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "T", path: root }) })).json();
    const r = await withRoot(w, async () => (await fetch(`${base}/api/project-resources?workspaceId=${ws.id}&disk=0`)).json());
    assert.deepEqual(r.quota, { mem: { totalBytes: 8 * GIB, usedBytes: 2 * GIB, availableBytes: 6 * GIB }, cpu: { count: 2 } }, JSON.stringify(r));
    assert.equal(r.host.mem.totalBytes, 32 * GIB, "host is the host");
    // Without a root on this machine (the Mac, no /sys/fs/cgroup): no quota.
    if (process.platform === "darwin") {
      const m = await (await fetch(`${base}/api/project-resources?workspaceId=${ws.id}&disk=0`)).json();
      assert.equal(m.quota, null);
    }
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    for (const d of [root, w]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.warn("cleanup:", e.message); } }
  }
});
