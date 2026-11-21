// Start/stop of project services from the persistent Electron main process.
//
// Two start paths (see projects/routes.js, serviceProjectRoutes):
//  - "simple": the start command is run here directly as a detached child process.
//  - "agent":  a Claude agent brings the service up (env/dependencies/port check); this module then only remembers the run
//              (port) for status & stop.
//
// Why a login shell? GUI apps get a minimal PATH on macOS — `zsh -lc` loads the user profile and with it the same PATH
// (nvm/pyenv/homebrew) as a terminal.
// Why detached? The service should survive the response/an app restart; we remember the process group PID to end it
// precisely (by group).
// Why stop by port as well? Agent starts (nohup) and runs from before an app restart can only be collected via the port (lsof).
// The services of a RELOCATED project run in the project container — section "Services in the project container" below;
// without an instance row and ops marker every path here is the plain one.

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkPort } from "./ports.js";
import { T } from "./i18n.js";
import { inProject } from "./runtime/inProject.js";
import { realRoots, removeInArea, createFolderInArea, openFileWithoutReference } from "./runtime/real-path.js";
import { projectboxOps } from "./projectbox/ops.js";
import { DockerError, docker, dockerIn } from "./projectbox/docker.js";
import { isFrozen } from "./projectbox/docker.js"; // the monitor reports no outage during the pause
import { execIn, isPausedError, waitForThaw } from "./projectbox/docker.js"; // exec and stop behind the barrier
import { MAIN, copyNameOf } from "./projectbox/creation.js";
import { startTimeFromStat } from "./projectbox/network-marker.js"; // the start time of PID 1 for the boot marker
import { withExecProcesses } from "./projectbox/exec-measurement.js"; // exec processes in the resources per instance
import { PS_TEMPLATE, containerFromPs, matchContainers } from "./service-container.js"; // template, ps rows, matching
export { PS_TEMPLATE, containerFromPs, labelsFromPs, matchContainers } from "./service-container.js";

// The log file of a service: `(projectId, serviceId, instance) => path`, set from server.js (runs/runtime-location.js
// serviceLogFile — the project container per instance in the project's runtime folder, otherwise flat as before).
// This leaf does not know the store.
let logFileFn = null;
let RUNS_FILE = null;
let EVENTS_FILE = null;
let eventFn = null; // (event) => void — e.g. global SSE stream for mobile push delivery
// (event) => { category, push, pushTitle, pushSubtitle } — the push verdict. It needs chat and settings, i.e. the database;
// this module does not know it, and neither does the gateway. So server.js passes it in and the stamp travels with the event.
let pushGateFn = null;
const RUNS = new Map(); // key -> run

// The key of a run: for the main — and every run in B — unchanged `<projectId>:<serviceId>`, for a copy
// `<projectId>:<serviceId>@copy-<name>`. The same service id thus runs in main and copy side by side without one overwriting the
// other's entry; a rollback to a release without copies reads the main's entries unchanged. An instance outside the form
// (creation.js copyNameOf) THROWS.
const key = (projectId, serviceId, instance = MAIN) => (copyNameOf(instance) === null ? `${projectId}:${serviceId}` : `${projectId}:${serviceId}@${instance}`);
// The instance of an entry from its identifier `<projectId>/<instance>` (`run.instance`); a run in B carries none — the main.
const instanceOfRun = (run) => {
  const k = String(run?.instance || "");
  const i = k.lastIndexOf("/");
  return i > 0 && i < k.length - 1 ? k.slice(i + 1) : MAIN;
};
// The name of a copy for bell and messages — "" for the main.
const copyAddition = (instance) => {
  const name = copyNameOf(instance);
  return name === null ? "" : T`copy ${name}`;
};

export function initServices({ dataDir, logFile = null, logAnchor = null, projectPath = null, onEvent = null, pushGate = null }) {
  logFileFn = typeof logFile === "function" ? logFile : null;
  logAnchorFn = typeof logAnchor === "function" ? logAnchor : null;
  projectPathFn = typeof projectPath === "function" ? projectPath : null;
  RUNS_FILE = path.join(dataDir, "service-runs.json");
  EVENTS_FILE = path.join(dataDir, "service-events.json");
  eventFn = typeof onEvent === "function" ? onEvent : null;
  pushGateFn = typeof pushGate === "function" ? pushGate : null;
  try {
    for (const r of JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"))) RUNS.set(r.key, r);
  } catch {
    /* no runs stored yet */
  }
  // Load the notification history (survives app restarts) and continue the counter.
  // The counter stands EXPLICITLY next to the list and is not derived from it: it assigns an identity, the list is a ring buffer
  // that "Delete all" empties. Derived, it fell back to 0 after every emptying — and the gateway's push bridge, whose cursor is
  // monotonic, then silently discarded EVERY new notification (notes 1..53 against cursor 192: days without a single delivery).
  try {
    const saved = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
    const list = Array.isArray(saved) ? saved : (Array.isArray(saved?.events) ? saved.events : null);
    if (list) {
      // Empty first: a second call (test, re-initialization) would otherwise append the history a second time — the bell
      // then showed every row twice.
      monEvents.length = 0;
      monEvents.push(...list);
      // Existing files carry only the bare list — then deriving stays the best estimate.
      const fromList = list.reduce((m, e) => Math.max(m, e.id || 0), 0);
      eventSeq = Math.max(Number(saved?.seq) || 0, fromList);
    }
  } catch {
    /* no notifications stored yet */
  }
}

function persist() {
  try {
    fs.writeFileSync(RUNS_FILE, JSON.stringify([...RUNS.values()], null, 2));
  } catch {
    /* persistence is best effort */
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, but belongs to someone else
  }
}

// ── The identity of a process group in B ───────────────────────────────────────────────────────────────
// RUNS survives every restart of B, the processes do not: after the user container is swapped the pid counter starts anew, and
// a stored number then belongs to anyone (`kill -0` only says "it exists") — the relocation once sent TERM and KILL to a foreign
// group (a PTY shell, a git run), and the way back restarted the "service". So EVERY simple start in B remembers the START TIME
// of its group (`pidStart`: Linux `/proc/<pid>/stat` field 22, ticks since boot; without /proc — macOS — `ps -o lstart=`), with
// or without the ops marker: service-runs.json survives a reboot of the Mac, the processes do not, and a reused pid would block
// the start permanently (409 "already running") while the recommended stop would hit a foreign group. Start guard, status and
// stop ask ONE function, `groupOfTheEntry` (own · foreign · dead): a foreign start time means dead for the status and NO group
// signal in the stop, and a group whose leader has ended lives through its members (a pgid is not reassigned while the group
// exists) — otherwise a service whose start command went to the background and exited counted as dead, and the member ran on
// unrecorded. An entry without a stored start time (from before this field — every swap of B has ended its groups) counts as
// foreign. The relocation path (`ownGroupAlive`) asks the same function. Test seam: `setProcessStartSeam(fn)`.
// THE BOOT MARKER: "a pgid is not reassigned while the group exists" holds only within ONE boot or container start. After a
// restart of the Mac or a swap of B a stored pid is any number — also the pgid of a FOREIGN group whose leader has already ended
// (the usual daemon pattern: setsid/setpgrp, fork, the leader ends). Without a leader there is no start time to compare, and
// such a group used to count as "own": the status said "running", the start guard 409, the stop sent TERM/KILL to it. So a simple
// start in B also records `bootMarker` (`bootMarker()`: macOS the boot time `kern.boottime`, Linux `btime` from /proc/stat plus
// the start time of PID 1 — the same evidence for "this container start" as the network-disconnect marker,
// projectbox/network-marker.js), and a group without a leader counts as own only if the entry carries start time AND boot marker
// and the marker is the current one; otherwise "foreign" (an entry without a marker likewise). With a leader the start-time
// comparison decides. Residual risk (named): within the same boot, AFTER the own group has ended entirely and before a status
// cleared the entry, a counter wraparound (macOS after 99,999) can give the same number to a foreign group without a leader —
// no marker helps against that.
// THE VERDICT APPLIES TO TERM AND KILL: decided ONCE, before the first signal. A second look before the KILL would ask the
// leader, which has often been reaped after the TERM while a member that ignores TERM lives on: without the KILL it stayed, and
// the stop reported success anyway.
let processStartSeam = null;
export function setProcessStartSeam(fn) { processStartSeam = typeof fn === "function" ? fn : null; }
let procStatExists = null;
/** The start time of process `pid` as a comparable marker, `null` = unknown (it does not live, or it is not readable). */
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (processStartSeam) return processStartSeam(pid);
  if (procStatExists ??= fs.existsSync("/proc/self/stat")) {
    try {
      const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = t.slice(t.lastIndexOf(")") + 2).split(" "); // from field 3 on (the name in field 2 can contain spaces)
      return /^\d+$/.test(fields[19] || "") ? `proc:${fields[19]}` : null;
    } catch { return null; }
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
  const s = String(r.stdout || "").trim();
  return r.status === 0 && s ? `ps:${s}` : null;
}
// The boot marker (see above): who is this machine or this start of the user container? `null` = unknown — then no group without
// a leader counts as own (empty is not unknown). Only a read value is remembered: it does not change while this process lives; a
// failure (cap under load) is retried the next time.
let bootMarkerValue = null;
const SYSCTL = fs.existsSync("/usr/sbin/sysctl") ? "/usr/sbin/sysctl" : "sysctl";
/** The boot marker as a comparable string (`darwin:<sec>.<usec>` or `linux:<btime>:<start time of PID 1>`), `null` = unknown. */
export function bootMarker() {
  if (bootMarkerValue !== null) return bootMarkerValue;
  if (procStatExists ??= fs.existsSync("/proc/self/stat")) {
    try {
      const btime = /^btime\s+(\d+)\s*$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1];
      const pid1 = startTimeFromStat(fs.readFileSync("/proc/1/stat", "utf8"));
      bootMarkerValue = btime && pid1 ? `linux:${btime}:${pid1}` : null;
    } catch { bootMarkerValue = null; }
    return bootMarkerValue;
  }
  const r = spawnSync(SYSCTL, ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
  const m = /sec = (\d+), usec = (\d+)/.exec(String(r.stdout || ""));
  bootMarkerValue = r.status === 0 && m ? `darwin:${m[1]}.${m[2]}` : null;
  return bootMarkerValue;
}
const withIdentity = () => projectboxOps();
/** Relocation path (the start guard asks `startGroupAlive`): does group `run.pid` live — and is it (with the ops marker) still THE
 *  entry's? An entry from the container never. With the ops marker the same verdict as status, start guard and stop
 *  (`groupOfTheEntry`) — it also demands a stored start time (an entry without one is foreign after every swap of B). It used to
 *  ask only the leader: a service with an ended leader and a living member "ran" for status and start guard but was missing in
 *  nativeRuns — the tick took the project for service-free, the relocation reported the member as a foreign process or let it run
 *  on in B, and "clear RUNS" deleted the entry. Without the ops marker (the local server knows no relocation): the leader lives,
 *  as before. */
function ownGroupAlive(run) {
  if (!run?.pid || run.instance) return false;
  if (!withIdentity()) return pidAlive(run.pid);
  return run.pidStart != null && groupOfTheEntry(run) === "own";
}
/**
 * Whose is the group `run.pid` of an entry in B?
 *   "own"     the leader lives and its start time is the entry's (without a stored start time — existing entry — it counts as own);
 *             OR the leader has ended, but the GROUP lives (a member, e.g. `sh -c 'x & exit'`), and the entry carries a start time
 *             and the boot marker OF NOW: within one boot a pgid is not reassigned while the group exists — so it is still the
 *             entry's.
 *   "foreign"   the leader lives but carries another start time (the pid belongs to someone else after a restart); OR the leader
 *             has ended, a group of that number lives, but its identity is not proven (boot marker missing, unknown or another
 *             — the foreign group of a daemon after a restart of the Mac or a swap of B).
 *   "dead"     neither leader nor group, or no pid, or an entry from the container (`instance` — there is no pid in B).
 * All callers only ask `=== "own"`.
 */
function groupOfTheEntry(run) {
  if (!run?.pid || run.instance) return "dead";
  if (pidAlive(run.pid)) return run.pidStart == null || processStart(run.pid) === run.pidStart ? "own" : "foreign";
  if (!groupAlive(run.pid)) return "dead";
  if (run.pidStart == null || run.bootMarker == null) return "foreign";
  const now = bootMarker();
  return now !== null && now === run.bootMarker ? "own" : "foreign";
}
/** Start guard and status: is group `run.pid` still the entry's — in EVERY mode via the start time (also with an ended leader).
 *  An entry without `pidStart` (existing entry from before the change) holds nothing up. */
function startGroupAlive(run) {
  if (!run?.pid || run.instance || run.pidStart == null) return false;
  return groupOfTheEntry(run) === "own";
}
/** Does any member of process group `pgid` live (not just its leader)? */
function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Our own process and its ancestors up to before pid 1: no signal ever goes to them from the stop of a service. The stop at the
// port hit EVERY listener — a service on 7718 ended the app itself with its stop. `ps` only if anybody listens at the port at all;
// if it fails, our own process and its parent remain.
function ownLine() {
  const line = new Set([process.pid, process.ppid]);
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], { timeout: 5000 }, (err, stdout) => {
      if (!err) {
        const parent = new Map();
        for (const row of String(stdout || "").split("\n")) {
          const [pid, ppid] = row.trim().split(/\s+/).map(Number);
          if (Number.isInteger(pid) && Number.isInteger(ppid)) parent.set(pid, ppid);
        }
        for (let p = parent.get(process.ppid); Number.isInteger(p) && p > 1 && !line.has(p); p = parent.get(p)) line.add(p);
      }
      resolve(line);
    });
  });
}
// The listeners at the port a stop may hit: without pid 1 and without our own line (ownLine).
async function foreignListener(port) {
  const pids = (await pidsOnPort(port)).filter((pid) => pid > 1);
  if (!pids.length) return pids;
  const line = await ownLine();
  return pids.filter((pid) => !line.has(pid));
}

// PIDs that LISTEN on a port (macOS/lsof). Empty array if nothing listens.
function pidsOnPort(port) {
  return new Promise((resolve) => {
    execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (_err, stdout) => {
      resolve(
        String(stdout || "")
          .split("\n")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      );
    });
  });
}

// ── Docker ────────────────────────────────────────────────────────────────────
// Containers without a host port mapping (Redis/Postgres in the compose network) are invisible to a TCP connect — status/stop go
// through docker for them. A short cache keeps the 5 s status polling from calling `docker ps` for every service. The cache alone
// is not enough: it is filled only AFTER the answer, so all checks started at the same time see a cold cache and each start a
// `docker ps` of its own. With 23 services with a container entry that was 23 child processes in one pass — enough event-loop
// stall to drive parallel port checks past the deadline. The running call is therefore shared.
//
// The status comes WITH LABELS (`docker ps -a --format PS_TEMPLATE`), and a service only hits containers of ITS project
// (matchContainers). The match used to compare names only: service `db` of project A hit `b-db-1` of project B, and its stop
// halted B too. `-a`, because the log (tailLogAny) also needs stopped containers; "running" is a field (`running`), not a call of
// its own. A change (stopService) forgets the status together with the running call (`forgetDockerStatus`) — a `ps` started before
// the stop writes nothing into the cache afterwards (generation). The template (`PS_TEMPLATE`), reading the rows and the match
// live in service-container.js.

// The LOCAL docker: the ONE call of the docker CLI in this leaf that does not go through projectbox/docker.js. It carries what
// must run without the ops marker — the local server against the Mac's Docker, and in server mode the NOT relocated projects
// against the user container's daemon (the seam rejects without a marker, and the Mac's container-services display would
// break). A relocated project never takes it: status, stop, log and resources go there through the seam into the project
// container (section "Services in the project container" below). Arguments and options are passed through unchanged by the four
// callers (status `ps`, resources `stats`, stop `stop`, log `logs`) — they are named in DOCKER_CALLS_ALLOWED
// (projectbox-ops.test.js).
function localDocker(args, opts, cb) {
  return execFile("docker", args, opts, cb);
}

let dockerCache = { at: 0, list: null };
let dockerInFlight = null;
let dockerGeneration = 0;
function dockerContainer() {
  if (Date.now() - dockerCache.at < 4000) return Promise.resolve(dockerCache.list);
  if (dockerInFlight) return dockerInFlight;
  const generation = dockerGeneration;
  const running = new Promise((resolve) => {
    localDocker(["ps", "-a", "--format", PS_TEMPLATE], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const list = err ? null : containerFromPs(stdout); // null = docker not available/not started
      if (generation === dockerGeneration) {
        dockerCache = { at: Date.now(), list };
        dockerInFlight = null;
      }
      resolve(list);
    });
  });
  dockerInFlight = running;
  return running;
}

/** Forget the container status (after a stop; in tests between two fakes). */
export function forgetDockerStatus() {
  dockerGeneration++;
  dockerCache = { at: 0, list: null };
  dockerInFlight = null;
  // The statuses per project container too (inner daemon, container start, resources).
  insideStatus.clear();
  startState.clear();
  instanceStatsStatus.clear();
}

// The ids of the superseded containers of a project (`project_superseded`), set from server.js — this leaf does not know the
// store. Without a setter or without a project: none.
let supersededSource = null;
export function setSupersededSource(fn) { supersededSource = typeof fn === "function" ? fn : null; }
const supersededOf = (projectId) => {
  if (!projectId || !supersededSource) return null;
  try { return supersededSource(String(projectId)) || null; } catch { return null; }
};

// The project folder of a project, set from server.js (initServices) — this leaf does not know the store.
let projectPathFn = null;
const projectPathOf = (projectId, projectPath) => {
  if (projectPath) return projectPath;
  if (!projectId || !projectPathFn) return "";
  try { return projectPathFn(projectId) || ""; } catch { return ""; }
};
const runningNames = (hits) => hits.filter((c) => c.running).map((c) => c.name);
// The match of a service — its project (folder, superseded containers) and its `dir`. ONE path for status, stop, log and
// resources so none forgets the narrowing.
const serviceHits = (list, container, { projectId = null, projectPath = "", dir = "" } = {}) =>
  matchContainers(list, container, projectPathOf(projectId, projectPath), { dir, exempt: supersededOf(projectId) });

// ── Resources (CPU/RAM per container, disk per project folder) ──────────────────
// `docker stats --no-stream` delivers a snapshot of all running containers. A short cache keeps every resource polling from
// triggering a (costly) stats call.
const B = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
function parseBytes(s) {
  const m = String(s || "").trim().match(/^([\d.]+)\s*([kmgt]?i?)b?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = m[2].toLowerCase()[0] || "";
  return Math.round(n * (B[u] || 1));
}
// Share the running call here too (see dockerContainer): `docker stats --no-stream` is much costlier than `docker ps`, and several
// polling clients hit the same cold cache at the same time.
let statsCache = { at: 0, map: null };
let statsInFlight = null;
// The template and its reader — shared by the local call and the project container's (instanceStatsAll).
const STATS_TEMPLATE = "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}";
function statsFrom(stdout) {
  const map = new Map();
  for (const line of String(stdout || "").split("\n")) {
    const [name, cpu, mem] = line.split("\t");
    if (!name) continue;
    const [used, limit] = String(mem || "").split("/");
    map.set(name.trim(), {
      cpu: parseFloat(String(cpu || "").replace("%", "")) || 0,
      memBytes: parseBytes(used), memLimitBytes: parseBytes(limit),
    });
  }
  return map;
}
function dockerStats() {
  if (Date.now() - statsCache.at < 4000) return Promise.resolve(statsCache.map);
  if (statsInFlight) return statsInFlight;
  statsInFlight = new Promise((resolve) => {
    localDocker(["stats", "--no-stream", "--format", STATS_TEMPLATE],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        const map = err ? null : statsFrom(stdout);
        statsCache = { at: Date.now(), map }; // null = docker off/not available
        statsInFlight = null;
        resolve(map);
      });
  });
  return statsInFlight;
}

// Folder size (disk) per project — `du` is costly, hence cached longer (60 s) per path.
const duCache = new Map(); // path -> { at, bytes }
function dirSize(dir) {
  const c = duCache.get(dir);
  if (c && Date.now() - c.at < 60_000) return Promise.resolve(c.bytes);
  return new Promise((resolve) => {
    execFile("du", ["-sk", dir], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const kb = err ? 0 : parseInt(String(stdout || "").trim().split(/\s+/)[0], 10) || 0;
      const bytes = kb * 1024;
      duCache.set(dir, { at: Date.now(), bytes });
      resolve(bytes);
    });
  });
}

// Combine the resources of several containers. For unlimited containers `docker stats` reports the same shared Docker/host RAM
// capacity for EVERY container. The usages are added, but this capacity is counted only once (as the maximum) — 11 containers
// with "15.5 GiB limit" each do not mean 170.5 GiB of RAM available.
export function aggregateContainerStats(rows) {
  let cpu = 0, memBytes = 0, memLimitBytes = 0;
  for (const s of rows || []) {
    cpu += Number(s?.cpu) || 0;
    memBytes += Number(s?.memBytes) || 0;
    memLimitBytes = Math.max(memLimitBytes, Number(s?.memLimitBytes) || 0);
  }
  return {
    cpu: Math.round(cpu * 10) / 10,
    memBytes,
    memLimitBytes,
    containers: Array.isArray(rows) ? rows.length : 0,
  };
}

// Resources per project: sums CPU/RAM usage of all running containers of its services + the size of the project folder.
// projects: [{ id, path, name, services: [{ container }] }]. includeDisk optional (du can take a while) — the caller can switch
// it on/off depending on the display.
export async function projectResources(projects, { includeDisk = true } = {}) {
  // The labels come from `docker ps` (stats only knows names): the match per service is the same as for status and stop —
  // otherwise project A would count the load of a same-named service of B.
  // A relocated project counts as ONE container — its project container (`docker stats --no-stream cbase-p-<id>` through the
  // seam): its cgroup carries the inner containers, but NOT what `docker exec` starts in it (wrapper, native services, terminals,
  // runs, browsers — they stay in B's cgroup); projectbox/exec-measurement.js adds those from /proc. The local docker is only
  // asked by whoever has a project WITHOUT an instance (otherwise a call would bypass the project's daemon).
  // If a relocated project has copies (seam `copies`), their containers count toward the project, and `instances` names its
  // numbers per instance (main first). Without a copy the field is absent — the plain answer.
  // Perf ("about a minute until the values" in the app): the project containers and copies of ALL projects are collected first
  // and measured in ONE `docker stats` (instanceStatsAll), the folder sizes are started in parallel — before, one call per
  // container ran one after the other (≈ 2 s each, 11 containers ≈ 22 s, so the 4 s status per container was always cold). The
  // loop below only reads.
  const targets = new Map(projects.map((p) => [p, targetOf(p.id)]));
  const localUsed = [...targets.values()].some((z) => !z);
  const copiesPer = new Map();
  const allTargets = [];
  for (const [p, target] of targets) {
    if (!target) continue;
    const copies = copiesTargets(p.id);
    copiesPer.set(p, copies);
    allTargets.push(target, ...copies);
  }
  const folder = new Map(projects.map((p) => [p, includeDisk && p.path ? dirSize(p.path).catch(() => null) : Promise.resolve(null)]));
  const [[stats, list], measured] = await Promise.all([
    localUsed ? Promise.all([dockerStats(), dockerContainer()]) : [null, null],
    instanceStatsAll(allTargets),
  ]);
  const measurement = (z) => measured.get(z.container) || { up: false, row: null };
  const dockerUp = stats !== null;
  const out = [];
  for (const p of projects) {
    const resourceRows = [];
    const target = targets.get(p);
    let dockerHere = dockerUp;
    let instances = null;
    if (target) {
      const r = measurement(target);
      dockerHere = r.up;
      if (r.row) resourceRows.push(r.row);
      const copies = copiesPer.get(p) || [];
      if (copies.length) {
        instances = [{ identifier: target.identifier, dockerUp: r.up, ...aggregateContainerStats(r.row ? [r.row] : []) }];
        for (const kz of copies) {
          const rk = measurement(kz);
          if (rk.row) resourceRows.push(rk.row);
          instances.push({ identifier: kz.identifier, dockerUp: rk.up, ...aggregateContainerStats(rk.row ? [rk.row] : []) });
        }
      }
    } else if (dockerUp) {
      const seen = new Set();
      for (const svc of p.services || []) {
        for (const name of runningNames(serviceHits(list, svc.container, { projectId: p.id, projectPath: p.path, dir: svc.dir }))) {
          if (seen.has(name)) continue;
          seen.add(name);
          const s = stats.get(name);
          if (s) resourceRows.push(s);
        }
      }
    }
    const totals = aggregateContainerStats(resourceRows);
    const diskBytes = await folder.get(p);
    out.push({ projectId: p.id, name: p.name, dockerUp: dockerHere, ...totals, memLimitShared: true, diskBytes, ...(instances ? { instances } : {}) });
  }
  return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The log file of a service (see logFileFn). Without a setter there is none: a call before initServices throws instead of
// silently writing somewhere.
// With the instance of the network target (`target.instance`), without it `main` or flat — as before.
// In the runtime folder: the anchor itself is a folder of B (`<data>/projects/<id>`, a mount point in the project container that
// it cannot replace), the log folder below it is created through it; if a link stands in its place, B never touches the file
// anyway (every access goes through the descriptor) — reported, not thrown.
function newLogFile(projectId, serviceId, instance) {
  if (!logFileFn) throw new Error("services: initServices without logFile — no place for service logs");
  const file = logFileFn(projectId, serviceId, instance);
  const anchor = anchorOf(file);
  if (!anchor) fs.mkdirSync(path.dirname(file), { recursive: true });
  else {
    fs.mkdirSync(anchor, { recursive: true });
    try { createFolderInArea(path.dirname(file), limitOf(file)); } catch (e) {
      console.warn(`[services] log folder ${path.dirname(file)} not created — B writes nothing there: ${e?.message || e}`);
    }
  }
  return file;
}

// Per instance — a copy reads its entry and its file (`copy-<name>_<svc>.log`), the main as before.
function logFileFor(projectId, serviceId, instance = MAIN) {
  const run = RUNS.get(key(projectId, serviceId, instance));
  if (run?.logFile) return run.logFile;
  return copyNameOf(instance) === null ? newLogFile(projectId, serviceId) : newLogFile(projectId, serviceId, instance);
}

function stamp(kindLabel, cmd) {
  const t = new Date().toISOString();
  return `\n===== ${t} · ${kindLabel} · ${cmd || "(no command)"} =====\n`;
}

// ── The files of the services in the runtime folder ─────────────────────────────────────────────────────────────────────
// Service log, pgid and exit file of a relocated project live in its runtime folder `<data>/projects/<id>/`, and the project
// container mounts that rw: a link in their place (`service-logs/main_7.log → ~/.bashrc`) would have B read the target's file
// (log route, bell "start failed") and write to it (stamp of the start with the start command, which the container may set by
// PATCH). If a file lies by its WORDING in a runtime folder (`logAnchor`, from server.js: runs/runtime-location.js
// runtimeFolderOf), B accesses it only through the descriptor: the parent folder checked via the anchor, the file
// O_NOFOLLOW|O_NONBLOCK, only a regular file (runtime/real-path.js openFileWithoutReference) — otherwise it counts as not
// there, not readable, not writable. Without an anchor (flat place, every non-relocated project, the local server) the plain
// calls, byte-equal. Guard: projectbox-services.test.js (15).
let logAnchorFn = null;
const O = fs.constants;
const anchorOf = (file) => (file && logAnchorFn ? logAnchorFn(file) : null);
function limitOf(file) {
  const anchor = anchorOf(file);
  return anchor ? realRoots([path.dirname(path.resolve(file))], [anchor]) : null;
}
function withServiceFile(file, w, opts, fn) {
  const fd = openFileWithoutReference(file, w, opts);
  try { return fn(fd); } finally { fs.closeSync(fd); }
}
/** Read — throws like readFileSync. */
function readServiceFile(file) {
  const w = limitOf(file);
  return w ? withServiceFile(file, w, {}, (fd) => fs.readFileSync(fd, "utf8")) : fs.readFileSync(file, "utf8");
}
/** Append — throws like appendFileSync. */
function attachToServiceFile(file, text) {
  const w = limitOf(file);
  if (!w) { fs.appendFileSync(file, text); return; }
  withServiceFile(file, w, { flags: O.O_WRONLY | O.O_APPEND, create: true }, (fd) => { fs.writeSync(fd, text); });
}
/** Does the file exist — in the runtime folder only as a regular file, never as a link? */
function serviceFileExists(file) {
  const w = limitOf(file);
  if (!w) return fs.existsSync(file);
  try { fs.closeSync(openFileWithoutReference(file, w)); return true; } catch { return false; }
}
/** Open the log file for appending → fd (the caller closes). */
function openLogToAppend(file) {
  const w = limitOf(file);
  return w ? openFileWithoutReference(file, w, { flags: O.O_WRONLY | O.O_APPEND, create: true }) : fs.openSync(file, "a");
}
/** Remove — a link falls itself, never its target; a missing file is no error. */
function removeServiceFile(file) {
  const w = limitOf(file);
  if (!w) { fs.rmSync(file, { force: true }); return; }
  try { removeInArea(file, w); } catch (e) { if (e?.code !== "ENOENT") throw e; }
}

/** The log of a service that falls with a layout change (projectbox/layout/procedure.js step 17) — removed like every service
 *  file (in the runtime folder through the descriptor, a link falls itself). → whether removed. */
export function removeServiceLog(projectId, serviceId, { instance = MAIN } = {}) {
  if (!logFileFn) return false;
  const file = copyNameOf(instance) === null ? logFileFn(projectId, serviceId) : logFileFn(projectId, serviceId, instance);
  try { removeServiceFile(file); return true; } catch (e) {
    console.warn(`[services] log ${file} not removed: ${e?.message || e}`);
    return false;
  }
}

// Pure reachability check (without registry side effects): Docker container (also covers compose-internal ports) > port open.
// Used by the status endpoint and the monitor.
// `projectId` or `projectPath`: a container only counts if it belongs to THIS project (matchContainers).
// `instance`: the instance of the project that is asked — without it the main (the plain path).
// `dir`: the folder of the service (`project_services.dir`) — a compose container only hits on its own line (matchContainers).
export async function probeStatus({ port = null, container = "", projectId = null, projectPath = "", instance = MAIN, dir = "" } = {}) {
  // A relocated project — the same precedence, asked in the project container (inner daemon, port on the IP).
  const target = targetOf(projectId, instance);
  if (target) return probeInInstance(target, { port, container, projectId, projectPath, dir });
  if (container) {
    const list = await dockerContainer();
    // Does the container run? Then done (also covers compose-internal ports without a host port).
    if (list !== null && runningNames(serviceHits(list, container, { projectId, projectPath, dir })).length > 0) return true;
    // No matching container (Docker off OR running, but without this container): the service can still run natively — e.g. the
    // frontend via `npm run dev` instead of as a compose container. Then the open host port is the decisive "running" evidence.
    return port != null ? checkPort(port) : false;
  }
  if (port != null) return checkPort(port);
  return false;
}

// Does the registered container run — true, false or null (the daemon's state is unknown). Unlike probeStatus "unknown" does not
// mean "does not run" here: freezing a copy decides by it which service runs natively, and an unreadable inner daemon would
// otherwise count every container service with an open port as native. `fresh` bypasses the 4 s status (once per computation is enough).
export async function containerRunning({ container, projectId = null, projectPath = "", instance = MAIN, fresh = false, dir = "" } = {}) {
  const target = targetOf(projectId, instance);
  if (target && fresh) forgetInsideStatus(target);
  const list = await (target ? innerState(target) : dockerContainer());
  if (list === null) return null;
  return runningNames(serviceHits(list, container, { projectId, projectPath, dir })).length > 0;
}

// Does service `s` (row of the data layer: `id`, `port`, `container`) run? For lists that do not go through serviceStatus
// (/api/project-services of the apps page and the probe per instance there): with port or container like probeStatus, PORTLESS the
// rule of serviceStatus — a run in the container asks instanceRunAlive (like startHeld), one in B its group (groupOfTheEntry).
// probeStatus alone knew only "no" without port and container: a running portless service stood there as stopped, with
// `holdsStart` beside it. Unlike serviceStatus it clears no entry.
export async function serviceRunning(projectId, s, { instance = MAIN, projectPath = "" } = {}) {
  if (s?.container || s?.port != null) return probeStatus({ port: s.port ?? null, container: s.container || "", projectId, projectPath, instance, dir: s.dir || "" });
  const run = RUNS.get(key(projectId, s?.id, instance));
  if (!run) return false;
  if (run.instance) return (await instanceRunAlive(run)) === true;
  return groupOfTheEntry(run) === "own";
}

// Running status of a service. Priority: Docker container (also covers compose-internal ports) > port open > remembered PID
// lives. Clears orphaned registry entries when nothing runs any more.
// `instance`: status, entry and log of THIS instance; without it the main.
export async function serviceStatus(projectId, serviceId, { port = null, container = "", projectPath = "", instance = MAIN, dir = "" } = {}) {
  const k = key(projectId, serviceId, instance);
  const run = RUNS.get(k);
  // A run in the project container (entry with `instance`, without pid) — whether it lives only the container knows; asked at most
  // once (true, false or null = unknown, see instanceRunAlive).
  let aliveIn;
  const inContainerAlive = async () => (aliveIn === undefined ? (aliveIn = await instanceRunAlive(run)) : aliveIn);
  let running;
  if (container || port != null) running = await probeStatus({ port, container, projectId, projectPath, instance, dir });
  else running = run ? (run.instance ? (await inContainerAlive()) === true : groupOfTheEntry(run) === "own") : false;

  if (run && !running) {
    // Only remove if really dead (port closed AND group gone) — otherwise a slowly starting service could wrongly be forgotten as
    // ended. A pid that demonstrably belongs to someone else (stored start time does not match) counts like a dead one: the entry
    // would otherwise stay, and a stop would hit the foreign group. A group whose leader has ended lives through its members —
    // only with the boot marker of now (otherwise it is foreign, and the entry falls like a dead one).
    const pidDead = run.instance ? (await inContainerAlive()) === false : groupOfTheEntry(run) !== "own";
    // Remove only THE entry that was checked — a start that has occupied the same key anew during the probe (await) stays recorded.
    if (pidDead && RUNS.get(k) === run) {
      RUNS.delete(k);
      persist();
    }
  }
  // `holdsStart`: the start guard holds a start up although the port shows nothing — the group lives but does not (yet) listen on
  // the registered port. Status and start guard thus give the same answer: the clients offer "Stop" at `running || holdsStart`,
  // otherwise the start would end in 409 "stop first" without a stop button. Computed only beside `running:false` (beside it the
  // client offers "Stop" anyway; the start time costs a `ps` on macOS).
  const holdsStart = !running && runHoldsStart(RUNS.get(k), targetOf(projectId, instance));
  return {
    running,
    holdsStart,
    mode: run?.mode ?? null,
    pid: run?.pid ?? null,
    since: run?.startedAt ?? null,
    chatId: run?.chatId ?? null,
    hasLog: serviceFileExists(logFileFor(projectId, serviceId, instance)),
  };
}

// Simple start: start command directly as a detached child process (login shell).
// Do NOT hard-wire the shell: there is no zsh in the container (SHELL=/bin/bash in the image) — a fixed /bin/zsh spawn dies
// there silently with ENOENT.
const loginShell = () => process.env.SHELL || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");

// Pure syntax check WITHOUT execution (`bash -n -c`): null = ok, otherwise a compact error text.
// Catches the typical scan-agent accidents (prose in the command → "syntax error near '('") BEFORE a broken command is stored —
// the agent gets the error as the answer and can correct. ALWAYS bash on purpose (not loginShell): zsh -n waves practically
// everything through (empirically — it even accepts unbalanced parentheses), bash is strict, present everywhere and the execution
// shell in the container anyway.
// An error text ONLY if bash answered (exit ≠ 0). If the CHECK itself fails — `spawnSync` then does not throw, it returns `r.error`
// (ETIMEDOUT after 5 s under load, EAGAIN, E2BIG) or a signal instead of an exit code —, the verdict is unknown, and unknown is
// not wrong: null (until then the scan emptied valid commands, PATCH/POST answered 400). A NUL byte runs no shell (spawn throws
// at the argument): that is an answer.
export function checkCommandSyntax(cmd) {
  const c = String(cmd || "").trim();
  if (!c) return null;
  if (c.includes("\0")) return T("Command contains a NUL byte");
  const bash = fs.existsSync("/bin/bash") ? "/bin/bash" : "/usr/bin/bash";
  const r = spawnSync(bash, ["-nc", c], { timeout: 5000, encoding: "utf8" });
  if (r.error || r.status === null || r.status === 0) return null;
  return String(r.stderr || T("Syntax error")).trim().split("\n").slice(-2).join(" ").slice(0, 300);
}

// Repair attempt for scan commands: check first, only on error remove known prose appendages ("(folder/)" at the end,
// "; Browser: http://…") and check again. What cannot be repaired is emptied (an honest "no start command" instead of a
// guaranteed failed start).
export function sanitizeStartCommand(cmd) {
  const c = String(cmd || "").trim();
  if (!c || !checkCommandSyntax(c)) return { cmd: c, dropped: false };
  const stripped = c.replace(/\s*;?\s*Browser:.*$/i, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
  if (stripped && !checkCommandSyntax(stripped)) return { cmd: stripped, dropped: false };
  return { cmd: "", dropped: true };
}

// ── The start guard ─────────────────────────────────────────────────────────────────────────────────────────────────────
// "Already running?" is answered by the route at the registered PORT (serviceStatus): a service that listens elsewhere (or is
// still booting) counts as stopped and got a second start — `RUNS.set` overwrote pid and pidStart of the LIVING run, the
// duplicate died of EADDRINUSE, failNotice deleted the entry, and the real process was recorded nowhere any more (no stop, no
// relocation step 4). So startSimple asks itself before it creates anything: if the existing entry holds a living group, it is NOT
// overwritten but ServiceRunningError is thrown (the route answers 409, startDesiredServices counts it as "already running", the
// way back of the relocation as started). A restart stops first (stopService deletes the entry).
//   in B        startGroupAlive: the leader lives AND its start time is still the entry's — with and without ops marker (after
//               a restart of the Mac the stored pid belongs to anyone, and liveness alone blocked the start permanently); an
//               entry without a start time (existing entry) holds nothing up.
//   container   a simple run OF THE CURRENT instance that has not ended (no `ended`, no exit file of the wrapper) — synchronous,
//               from the entry's files. The verdict "orphaned" (container restarted) does not fall here: both callers ask
//               instanceRunAlive first (serviceStatus clears a dead entry, startDesiredServices asks itself). An instance entry
//               without a matching target (way back of the relocation: row no longer relocated, container removed) holds nothing up.
//   agent start without a group (`pid: null`) never — there the port decides (route).
// The guard also applies in the OPPOSITE direction: an agent start replaced a living simple run (`recordAgentRun`, `RUNS.set` with
// `pid: null`) — the route asks `checkStartFree` BEFORE the agent chat, recordAgentRun once more as a second safeguard. The status
// reports the same verdict as `holdsStart` (serviceStatus).
export class ServiceRunningError extends Error {
  constructor(service, run) {
    const who = run.instance ? T`in project container ${run.instance}` : T`process group ${run.pid}`;
    super(T`"${service.name}" is already running (${who}) — stop it before starting it again.`);
    this.name = "ServiceRunningError";
    this.code = "SERVICE_RUNNING";
    this.status = 409;
  }
}
function runHoldsStart(run, target) {
  if (!run) return false;
  if (!run.instance) return startGroupAlive(run);
  if (run.mode !== "simple" || !target || target.identifier !== run.instance) return false;
  if (run.ended !== undefined && run.ended !== null) return false;
  return !(run.exitFile && serviceFileExists(run.exitFile));
}
/** Throws ServiceRunningError if the existing entry of `service` holds a start up — for the route before EVERY start (simple AND
 *  agent) and for recordAgentRun. Per instance: only the entry of THIS instance holds up — a living run in the main does not hold
 *  up the start of the same service in the copy and vice versa. */
export function checkStartFree(projectId, service, { instance = MAIN } = {}) {
  const existing = RUNS.get(key(projectId, service.id, instance));
  if (runHoldsStart(existing, targetOf(projectId, instance))) throw new ServiceRunningError(service, existing);
}
/** The `holdsStart` state for lists that do not go through serviceStatus (/api/project-services of the apps page): as there asked only
 *  beside a closed port; a container run the container no longer knows (orphaned) holds nothing up. */
export async function startHeld(projectId, service, { instance = MAIN } = {}) {
  const run = RUNS.get(key(projectId, service.id, instance));
  if (!runHoldsStart(run, targetOf(projectId, instance))) return false;
  if (run.instance && (await instanceRunAlive(run)) === false) return false;
  return RUNS.get(run.key) === run;
}

// The start goes through `inProject` (runtime/inProject.js): without an instance that is EXACTLY today's `spawn` (login shell,
// own process group, stdout/stderr to the log file). For a relocated project it starts in the project container, detached
// (`docker exec -d … cbase-wrapper --pgid-file … --log <log file> --exit … -- sh -lc <start command>`, the start command
// unchanged); the entry then carries `instance` and (as soon as the wrapper wrote it) `pgid`, never `pid` — details in the
// section "Services in the project container".
// `instance`: a copy starts in ITS container (`cbase-k-…`), under its key and with its log; if it cannot be resolved, targetOf
// throws — never a start in the main. Without it the main.
export function startSimple({ projectId, service, cwd, projectName = "", workspaceId = null, instance = MAIN }) {
  const target = targetOf(projectId, instance);
  const existing = RUNS.get(key(projectId, service.id, instance));
  if (runHoldsStart(existing, target)) throw new ServiceRunningError(service, existing); // never overwrite
  const logFile = newLogFile(projectId, service.id, target?.instance);
  // In the project container the wrapper appends to the log file itself (it lies in the runtime folder, at the same path there); B only
  // puts the stamp before it — through the descriptor, a link in its place gets none, the start goes on.
  let fd = null;
  if (target) {
    try { attachToServiceFile(logFile, stamp(T("simple start"), service.startCommand)); } catch (e) {
      console.warn(`[services] stamp not written — ${logFile} is not a regular file in the runtime folder: ${e?.message || e}`);
    }
  } else {
    fd = openLogToAppend(logFile);
    fs.writeSync(fd, stamp(T("simple start"), service.startCommand));
  }
  const call = target
    ? { cmd: "sh", args: ["-lc", service.startCommand], opts: { cwd, env: process.env, stdio: ["ignore", "ignore", "pipe"], service: { log: logFile } } }
    : { cmd: loginShell(), args: ["-lc", service.startCommand], opts: {
      cwd,
      detached: true, // own process group → can be ended as a whole via -pid
      stdio: ["ignore", fd, fd],
      env: process.env,
    } };
  const child = inProject(target, call.cmd, call.args, call.opts);
  child.unref();
  if (!target) fs.closeSync(fd);
  const run = target ? {
    key: key(projectId, service.id, instance),
    projectId,
    serviceId: service.id,
    instance: target.identifier,
    pgid: null,
    pgidFile: child.inProject.pgidFile,
    exitFile: child.inProject.exitFile,
    port: service.port ?? null,
    mode: "simple",
    logFile,
    startCommand: service.startCommand,
    startedAt: Date.now(),
  } : {
    key: key(projectId, service.id),
    projectId,
    serviceId: service.id,
    pid: child.pid,
    // The start time of the group (see processStart) — for the relocation path (with ops marker) and for start guard and status in
    // EVERY mode.
    pidStart: processStart(child.pid),
    // The boot marker of this start — without it a group whose leader has ended does not count as own (groupOfTheEntry).
    bootMarker: bootMarker(),
    port: service.port ?? null,
    mode: "simple",
    logFile,
    startCommand: service.startCommand,
    startedAt: Date.now(),
  };
  RUNS.set(run.key, run);
  persist();

  // Make failed starts VISIBLE (bell) instead of silently dissolving in the log. Deliberate stopping (stopService removes the RUNS
  // entry or kills by signal) reports nothing.
  const failNotice = (why) => {
    if (RUNS.get(run.key) !== run) return; // stopped/replaced → no failure
    RUNS.delete(run.key);
    persist();
    let tail = "";
    try {
      tail = readServiceFile(logFile).trimEnd().split("\n").slice(-5)
        .filter((l) => !l.startsWith("=====")).join("\n").slice(-400);
    } catch { /* log not readable */ }
    // A failed start in a copy reports like one in the main, with the name of the copy.
    const copy = copyAddition(instance);
    recordNotice({
      kind: "down",
      title: copy ? T`Start failed: ${service.name} (${copy})`
        : T`Start failed: ${service.name}`,
      body: [projectName, why, tail].filter(Boolean).join("\n"),
      projectId, projectName, workspaceId,
      ...(copy ? { instance } : {}),
    });
  };
  // The end of the start command: in B the `exit` of the child, in the project container the wrapper's exit file (observeService).
  const afterTheEnd = (code, signal) => {
    if (signal) return; // ended by signal = stopped, no failed start
    if (code !== 0) {
      failNotice(T`The start command exited with code ${code}.`);
      return;
    }
    // Exit 0 can be legitimate (e.g. `docker compose up -d` ends at once) — but then the service must be reachable shortly after.
    // Without a probe (no port/container) report nothing.
    if (service.port == null && !service.container) return;
    const probeTimer = setTimeout(async () => {
      if (RUNS.get(run.key) !== run) return;
      const up = await probeStatus({ port: service.port, container: service.container, projectId, instance, dir: service.dir || "" }).catch(() => false);
      if (!up) failNotice(T("The start command completed, but the service is not reachable."));
    }, 8000);
    probeTimer.unref?.();
  };
  if (target) {
    // The remembered container state may date from when the container was stopped: the new run is measured against a freshly
    // read one.
    startState.delete(target.container);
    observeService(run, child, { afterTheEnd, failNotice });
    desiredSet(projectId, service.id, true, instance);
    return run;
  }
  // Spawn error (missing shell, missing cwd) — without a handler additionally an uncaught exception.
  child.on("error", (e) => {
    try { attachToServiceFile(logFile, T`[cbase] Start failed: ${e.message}\n`); } catch { /* log gone */ }
    failNotice(e.message);
  });
  child.on("exit", afterTheEnd);
  return run;
}

// Agent start: the agent has brought the service up (detached) — we only remember the run so that status & stop work via the port.
export function recordAgentRun({ projectId, service, chatId, instance = MAIN }) {
  // The agent of a relocated project starts through doRun in the project container — the entry carries the instance so that status
  // and stop (via the port) ask there.
  // Never over a living simple run (the route asks beforehand; this is the second safeguard).
  checkStartFree(projectId, service, { instance });
  const target = targetOf(projectId, instance);
  const run = {
    key: key(projectId, service.id, instance),
    projectId,
    serviceId: service.id,
    ...(target ? { instance: target.identifier } : {}),
    pid: null,
    port: service.port ?? null,
    mode: "agent",
    chatId,
    logFile: newLogFile(projectId, service.id, target?.instance),
    startCommand: service.startCommand,
    startedAt: Date.now(),
  };
  RUNS.set(run.key, run);
  persist();
  return run;
}

// Stop. Docker containers are ended with `docker stop` (a port/PID kill would only hit the docker proxy or nothing); native
// processes via the remembered process group AND everything that listens on the port (SIGTERM, after a grace period SIGKILL).
// `instance`: the stop hits only THIS instance — its entry, its container, its `desired`; without it the main.
export async function stopService({ projectId, serviceId, port, container = "", projectPath = "", instance = MAIN, dir = "" }) {
  const k = key(projectId, serviceId, instance);
  const run = RUNS.get(k);
  const p = port ?? run?.port ?? null;
  const killed = new Set();
  // A relocated project stops in the project container (inner daemon, process group and port there).
  const target = targetOf(projectId, instance);
  if (target) return stopInInstance(target, { k, run, projectId, serviceId, p, container, projectPath, instance, dir });

  if (container) {
    // Only containers of THIS project: the stop of `db` in A used to halt `b-db-1` of B too.
    const choice = { projectId, projectPath, dir };
    const targets = runningNames(serviceHits(await dockerContainer(), container, choice));
    // Only the Docker way if the container really runs as a container. If the service runs natively instead (e.g. frontend via `npm
    // run dev`), it falls through to the port/PID stop below — otherwise `docker stop` would grab nothing and the native process would
    // stay alive (and the status "running" again).
    if (targets.length > 0) {
      await Promise.all(
        targets.map(
          (n) =>
            new Promise((resolve) => {
              localDocker(["stop", n], { timeout: 30_000 }, () => resolve());
            }),
        ),
      );
      forgetDockerStatus(); // invalidate the cache — the status should see the stop at once
      RUNS.delete(k);
      persist();
      const stillRunning = runningNames(serviceHits(await dockerContainer(), container, choice)).length > 0;
      return { killed: targets, stopped: !stillRunning };
    }
    // otherwise: native case — end it below via process group/port
  }

  // The guard: an entry from the project container (`instance`) carries no `pid` — and if it does (by hand, broken), it never
  // reaches `process.kill(-pid)` here: the number would be a group in the container, a foreign one in B.
  // The group is fixed ONCE, before the first signal, and applies to TERM and KILL (a second look before the KILL left a member
  // standing that ignores TERM). The group signal goes only to an OWN group (`groupOfTheEntry`) — a pid that belongs to someone else
  // after a restart (start time does not match) gets none; a group whose leader has already ended only if the entry carries the
  // boot marker of now (otherwise it is the foreign group of a daemon that carries the same number after the restart).
  const group = run?.pid && !run.instance && groupOfTheEntry(run) === "own" ? run.pid : null;
  const killGroup = (sig) => {
    if (group) {
      try {
        process.kill(-group, sig);
        killed.add(group);
      } catch {
        /* group already gone */
      }
    }
  };

  killGroup("SIGTERM");
  // Never our own process and none of its ancestors (foreignListener).
  if (p != null) {
    for (const pid of await foreignListener(p)) {
      try {
        process.kill(pid, "SIGTERM");
        killed.add(pid);
      } catch {
        /* already gone */
      }
    }
  }

  await delay(1500);

  // Hard-kill the survivors.
  killGroup("SIGKILL");
  if (p != null) {
    for (const pid of await foreignListener(p)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  RUNS.delete(k);
  persist();
  const stillOpen = p != null ? await checkPort(p) : group ? pidAlive(group) : false; // a foreign pid is not "our service still runs"
  return { killed: [...killed], stopped: !stillOpen };
}

// A stop purely via the port is gone: no path in the product called it, and it hit every listener without exception. The port part
// of the stop lives in stopService/stopInInstance.

// Last lines of the service log (for the UI).
export function tailLog(projectId, serviceId, maxLines = 300, { instance = MAIN } = {}) {
  const file = logFileFor(projectId, serviceId, instance);
  try {
    const lines = readServiceFile(file).split("\n");
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

// Service log incl. container services: first the file of the simple start; if that is empty and the service has a container,
// `docker logs` of the matching containers (also stopped ones — their last lines are the most valuable when debugging).
// From the same state as status and stop (`docker ps -a` with labels, shared and briefly cached) — and only the containers of THIS
// project: the log of `db` in A used to show `b-db-1` too.
// `instance`: file and inner daemon of THIS instance; without it the main.
export async function tailLogAny(projectId, serviceId, { container = "", projectPath = "", instance = MAIN, dir = "" } = {}, maxLines = 300) {
  // Resolve a copy first: if it does not exist (any more), targetOf throws here — never a log in its place. The main asks as before
  // only when the file is empty.
  if (copyNameOf(instance) !== null) targetOf(projectId, instance);
  const own = tailLog(projectId, serviceId, maxLines, { instance });
  if (own.trim() || !container) return own;
  // The containers of a relocated project stand in the inner daemon (`docker exec … docker logs`).
  const target = targetOf(projectId, instance);
  const matched = serviceHits(await (target ? innerState(target) : dockerContainer()), container, { projectId, projectPath, dir }).map((c) => c.name);
  if (!matched.length) return own;
  const parts = await Promise.all(matched.map((n) => (target
    ? dockerIn(target.container, ["logs", "--tail", String(maxLines), n], { capMs: INSTANCE_CAP_MS }).then((r) => `${r.stdout || ""}${r.stderr || ""}`, () => "")
    : new Promise((resolve) => {
      // docker logs writes container stdout to stdout and stderr to stderr — collect both.
      localDocker(["logs", "--tail", String(maxLines), n], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => resolve(err ? "" : `${stdout || ""}${stderr || ""}`));
    }))));
  return matched
    .map((n, i) => (matched.length > 1 ? `── ${n} ──\n` : "") + parts[i].split("\n").slice(-maxLines).join("\n"))
    .join("\n")
    .trim();
}

// ── Services in the project container ───────────────────────────────────────────────────────────────────────────────
// A relocated project (instance row marked relocated AND ops marker) has its services IN the project container: start, status,
// stop, log and resources go through its daemon or through `docker exec` into it (projectbox/docker.js). Without an instance — the
// local server, every non-relocated project — every path is the plain one.
//
// THE SEAM (`setServicesSeam`, set in server.js from projectbox/services.js — this leaf does not know the store):
//   instanceFor(projectId)   the network target `{ identifier, projectId, instance, ip, container }` or null (= the plain path).
//                            Throws if the instance is not readable — the route then answers 500, not "in B".
//   updateDesired(projectId, svcId, running)  the instance's desired services, on every simple start (true) and every stop (false)
//                            through cbase of a relocated project — never when cleaning up a dead run.
//   projectServices(projectId)  name, workspace, path and service rows with working folder — for startDesiredServices.
//   copies(projectId)        the instances `copy-<name>` of a relocated project that should run (row marked relocated) — for
//                            monitor and resources. Without a copy `[]`, without a seam none.
// Unset there is no instance (unit tests without a server): the plain path.
//
// PER INSTANCE. Start, status, stop, log, desired state and resources of a service apply per (instance, service): every function above
// takes `instance` (without it the main — every call as before is byte-equal), the entry's key carries it for a copy
// (`…@copy-<name>`), the log file is `copy-<name>_<svc>.log`, and `instanceFor(projectId, instance)` returns the copy's target. If a
// copy cannot be resolved (no row, no operation, a seam that returns another target), targetOf THROWS (`ServiceInstanceError`, 404) —
// never a fallback to the main: a start of the copy in the main would be a second run on its data. The monitor checks every service
// additionally in every copy (key `project:<id>@copy-<name>`), and the bell names the copy.
//
// START (startSimple). `inProject(target, "sh", ["-lc", <command>], { service: { log } })` ⇒ `docker exec -d -u agent -w <cwd>
// <container> cbase-wrapper --pgid-file <processes>/<id>.pgid --log <log file> --exit <processes>/<id>.exit -- sh -lc <command>`; the
// command runs unchanged, as leader of its own session — a killed `docker exec` does not end it. Because `-d` delivers no exit event,
// the backend WATCHES the exit file's folder: `fs.watch` plus a query on a beat (`CBASE_SERVICE_QUERY_MS`, default 1 s). Whether
// fs.watch on the idmapped home reports writes from the project container is open — then the query alone carries
// (`CBASE_SERVICE_FSWATCH=0` switches the watcher off). The exit file does what the child's `exit` does in B (afterTheEnd): ≠ 0 ⇒
// failNotice, 128+n (the wrapper reports a signal like a shell) ⇒ nothing, 0 ⇒ the reachability probe. The pgid file sets `pgid` on
// the entry; the observer removes both files as soon as the exit file came — also after a stop (the pgid stays in the entry: a
// command that leaves children in the background ends with 0, and its group lives on). If the `docker exec -d` itself fails
// (container stopped, wrapper missing), that is a failed start with its first stderr row.
//
// THE ENTRY in service-runs.json carries `instance` (identifier), `pgid`, `pgidFile`, `exitFile`, `ended` — NEVER `pid`: an old state
// after a rollback finds nothing for `process.kill(-pid)`, and the stop here has a guard before it.
//
// VALID an entry is only for the run of the container in which it arose: a pgid is a number in the project container's pid
// namespace, and after its restart (recreate, restore, restart of B) the same number may belong to a foreign group — a chat run, say.
// So every look and every stop compares the entry's `startedAt` with the container's `State.StartedAt` (`docker inspect`): if the
// container started later than the service, the entry is orphaned — no kill, status "not running", the entry falls (runValid). The
// container state is remembered for 4 s, but the verdict "orphaned" never falls from what is remembered (it is asked fresh), and
// startSimple forgets it: otherwise a remembered "container stopped" from before the restart would turn a freshly started run into an
// orphan. startDesiredServices counts a living run as "already running", even if its port is still closed.
//
// STATUS. probeStatus asks in the container: container services via `docker ps -a` of the inner daemon (valid 4 s per instance, a
// running call shared — the dockerContainer pattern), ports with `checkPort` on the instance's IP; a run without port and container
// via `kill -0 -- -<pgid>` in the container (instanceRunAlive). The monitor and the route's start check (portOccupied) take the same
// path. STOP: `kill -TERM -- -<pgid>`, after 1.5 s `-KILL` (as in B), plus whatever listens on the port (`lsof` in the container);
// container services via `docker stop` of the inner daemon. LOG from the file (it lies in the runtime folder, B reads it directly) or
// `docker exec … docker logs`. RESOURCES: ONE `docker stats --no-stream cbase-p-<id> cbase-k-… …` in B through the seam for all
// projects of a query (projectResources, instanceStatsAll), plus the exec processes per container from /proc
// (projectbox/exec-measurement.js).
//
// Guard: server/backend/test/projectbox-services.test.js; the start place is held by server/backend/test/in-project-start-places.test.js.
let instanceForFn = null;
let desiredFn = null;
let projectServicesFn = null;
let copiesFn = null;

/** Sets the seam of the services in the project container (server.js, from projectbox/services.js servicesSeam). Empty takes it back. */
export function setServicesSeam({ instanceFor = null, updateDesired = null, projectServices = null, copies = null } = {}) {
  instanceForFn = typeof instanceFor === "function" ? instanceFor : null;
  desiredFn = typeof updateDesired === "function" ? updateDesired : null;
  projectServicesFn = typeof projectServices === "function" ? projectServices : null;
  copiesFn = typeof copies === "function" ? copies : null;
}

/** A copy whose target cannot be resolved — the route answers 404, no path falls back to the main. `code` is the one of the code tab's
 *  instance choice (`UNKNOWN_INSTANCE`), `identifier` the copy's: a view with `afterError` (web/src/lib/code-instance.ts) visibly falls
 *  back to the main by it. */
export class ServiceInstanceError extends Error {
  constructor(projectId, instance, reason = "") {
    super(T`Instance ${projectId}/${instance} is not reachable${reason ? ` (${reason})` : ""} — no service call in the main instance instead.`);
    this.name = "ServiceInstanceError";
    this.code = "UNKNOWN_INSTANCE";
    this.identifier = `${projectId}/${instance}`;
    this.status = 404;
  }
}

// The network target of an instance NOW. The main: null without project, without seam, without relocation (the plain path), the seam
// with ONE argument as before. A copy: its target or a throw (ServiceInstanceError) — also without a seam and when the seam returns
// another target. Throws like the seam; an instance outside the form throws (copyNameOf).
function targetOf(projectId, instance = MAIN) {
  if (copyNameOf(instance) === null) {
    if (!projectId || !instanceForFn) return null;
    return instanceForFn(String(projectId)) || null;
  }
  if (!projectId) throw new ServiceInstanceError(projectId, instance, T("no project"));
  const target = instanceForFn ? instanceForFn(String(projectId), instance) : null;
  if (!target) throw new ServiceInstanceError(projectId, instance, T("no instance row or no server mode"));
  if (target.instance !== instance || String(target.projectId) !== String(projectId)) throw new ServiceInstanceError(projectId, instance, T`the seam returned ${target.identifier}`);
  return target;
}

// The targets of the copies of a project (monitor, resources). One that cannot be resolved drops out for this look, with a message.
function copiesTargets(projectId) {
  if (!copiesFn || !projectId) return [];
  let names;
  try { names = copiesFn(String(projectId)) || []; } catch (e) {
    console.warn(`[services] copies of project ${projectId} not readable — only the main: ${e?.message || e}`);
    return [];
  }
  const targets = [];
  for (const instance of names) {
    try { targets.push(targetOf(projectId, instance)); } catch (e) { console.warn(`[services] ${e?.message || e}`); }
  }
  return targets;
}

function desiredSet(projectId, serviceId, running, instance = MAIN) {
  if (!desiredFn) return;
  try {
    if (copyNameOf(instance) === null) desiredFn(String(projectId), serviceId, running);
    else desiredFn(String(projectId), serviceId, running, { instance });
  } catch (e) {
    console.error(`[services] desired state of project ${projectId}${copyNameOf(instance) === null ? "" : `/${instance}`} not updated (${running ? "start" : "stop"} of service ${serviceId}) — the restore sees the old state: ${e?.message || e}`);
  }
}

// Product cap per docker call — the same estimate as ports.js (`cat`/`lsof` measured under 0.5 s); the seam reports it as a cap.
const INSTANCE_CAP_MS = 10_000;

// A command in the project container as `agent` (like every exec in projectbox/ and runtime/inProject.js): `{ code, stdout }` — `code`
// is the command's exit (or 1 if docker does not find the container or it does not run), null if docker itself did not answer (cap,
// no operation): unknown.
// THE PAUSE: the call goes through execIn, i.e. behind the pause barrier — in a frozen container it waits for the thaw and THEN
// delivers its result (its cap counts only from there). Before, it ran raw: the daemon answered "is paused" with exit 1, and that became
// "dead" (instanceRunAlive), a deleted entry (serviceStatus) and a stop that killed nothing and reported `stopped:true`. If "is paused"
// arrives anyway (a pause cbase does not hold, or the barrier's cap), that is `code: null` with `paused: true` — unknown, never an exit.
async function inInstance(target, command, capMs = INSTANCE_CAP_MS) {
  try {
    const r = await execIn(target.container, command, { capMs });
    return { code: 0, stdout: r.stdout };
  } catch (e) {
    if (isPausedError(e)) {
      console.warn(`[services] ${command[0]} in ${target.identifier}: project container frozen — no verdict (${e?.message || e})`);
      return { code: null, stdout: "", paused: true };
    }
    if (e instanceof DockerError && typeof e.code === "number") return { code: e.code, stdout: e.stdout || "" };
    console.warn(`[services] ${command[0]} in ${target.identifier}: ${e?.message || e}`);
    return { code: null, stdout: "" };
  }
}

// Does the container run, and since when (`State.StartedAt`, ms)? Valid 4 s, a running call shared; `fresh` asks anew (before a kill,
// and before every verdict "orphaned" — instanceRunAlive). `null` = unknown; a container docker does not know does not run. Only a test
// raises the validity (`CBASE_SERVICE_STATUS_MS`): a guard against a verdict from the cache must not depend on the test being faster
// than 4 s.
const startState = new Map(); // container → { at, value, running }
const startStateMs = () => {
  const n = Number(process.env.CBASE_SERVICE_STATUS_MS);
  return Number.isInteger(n) && n > 0 ? n : 4000;
};
function containerStart(target, { fresh = false } = {}) {
  const old = startState.get(target.container);
  if (old && !fresh) {
    if (old.running) return old.running;
    if (Date.now() - old.at < startStateMs()) return Promise.resolve(old.value);
  }
  const e = { at: 0, value: null, running: null };
  e.running = docker(["inspect", "--format", "{{.State.Running}} {{.State.StartedAt}}", target.container], { capMs: INSTANCE_CAP_MS })
    .then((r) => {
      const [running, since] = String(r.stdout || "").trim().split(/\s+/);
      return { running: running === "true", since: Date.parse(since) };
    }, (err) => (err instanceof DockerError && typeof err.code === "number" ? { running: false, since: NaN } : null))
    .then((value) => { e.at = Date.now(); e.value = value; e.running = null; return value; });
  startState.set(target.container, e);
  return e.running;
}

/** Does the entry belong to the CURRENT run of the container? true · false (orphaned or container stopped) · null (unknown). */
async function runValid(run, target, opts) {
  const s = await containerStart(target, opts);
  if (!s) return null;
  if (!s.running) return false;
  if (!Number.isFinite(s.since)) return null;
  return s.since <= Number(run.startedAt);
}

// The state of the inner daemon per instance (`docker ps -a` with labels, containerFromPs) — null if not readable.
const insideStatus = new Map(); // identifier → { container, at, list, running }
function innerState(target) {
  const k = String(target.identifier || target.container);
  const old = insideStatus.get(k);
  if (old && old.container === target.container) {
    if (old.running) return old.running;
    if (Date.now() - old.at < 4000) return Promise.resolve(old.list);
  }
  const e = { container: target.container, at: 0, list: null, running: null };
  e.running = dockerIn(target.container, ["ps", "-a", "--format", PS_TEMPLATE], { capMs: INSTANCE_CAP_MS })
    .then((r) => containerFromPs(r.stdout), () => null)
    .then((list) => { e.at = Date.now(); e.list = list; e.running = null; return list; });
  insideStatus.set(k, e);
  return e.running;
}
const forgetInsideStatus = (target) => insideStatus.delete(String(target.identifier || target.container));

// The resources of the project containers: per container `{ up, row }` (row like dockerStats per name). Valid 4 s, shared.
// instanceStatsAll(targets) → Map container → `{ up, row }`. Only what is neither fresh nor already under way is measured, and
// that in ONE `docker stats --no-stream a b c …`: docker takes the two samples per container in parallel — 12 containers measured
// 2.65 s bundled against 24.13 s one after the other. One entry per container, whose `running` is the COMMON promise: a concurrent
// asker (web and iOS) shares the call. If the bundled call ends with an exit ≠ 0 (a container is gone — docker then prints a row
// for NONE, measured), it measures every container individually (`singleStats`, parallel) — the same meaning per container as
// before: a vanished one is `up: false`, the others keep their numbers. A cap, start or operation error (no numeric code) applies
// to all: `up: false`, as before per container.
// Guard server/backend/test/projectbox-services.test.js (33) and (34).
const instanceStatsStatus = new Map(); // container → { at, value, running }
const STATS_CAP_MS = 15_000;
function singleStats(container) {
  return docker(["stats", "--no-stream", "--format", STATS_TEMPLATE, container], { capMs: STATS_CAP_MS })
    .then((r) => ({ up: true, row: statsFrom(r.stdout).get(container) || null }), () => ({ up: false, row: null }));
}
async function instanceStatsAll(targets) {
  const promises = new Map(); // container → Promise<{ up, row }>
  const fresh = [];
  for (const target of targets) {
    const c = target?.container;
    if (!c || promises.has(c)) continue;
    const old = instanceStatsStatus.get(c);
    if (old?.running) promises.set(c, old.running);
    else if (old && Date.now() - old.at < 4000) promises.set(c, Promise.resolve(old.value));
    else { fresh.push(c); promises.set(c, null); }
  }
  if (fresh.length) {
    // The exec processes of every container come into the SAME state (two /proc samples around this call).
    const bundled = withExecProcesses(fresh, () => docker(["stats", "--no-stream", "--format", STATS_TEMPLATE, ...fresh], { capMs: STATS_CAP_MS })
      .then((r) => { const map = statsFrom(r.stdout); return new Map(fresh.map((c) => [c, { up: true, row: map.get(c) || null }])); },
        async (e) => {
          if (typeof e?.code !== "number") return new Map(fresh.map((c) => [c, { up: false, row: null }]));
          const individual = await Promise.all(fresh.map((c) => singleStats(c)));
          return new Map(fresh.map((c, i) => [c, individual[i]]));
        }));
    for (const c of fresh) {
      const e = { at: 0, value: null, running: null };
      e.running = bundled.then((m) => { const value = m.get(c) || { up: false, row: null }; e.at = Date.now(); e.value = value; e.running = null; return value; });
      instanceStatsStatus.set(c, e);
      promises.set(c, e.running);
    }
  }
  const container = [...promises.keys()];
  const values = await Promise.all(container.map((c) => promises.get(c)));
  return new Map(container.map((c, i) => [c, values[i]]));
}

// A port in the instance: on its IP (B reaches it through the DNAT on eth0). Not addressable without an IP — then "not open"
// (the instance IP helper in projectbox/address.js throws there; here it is a probe, not a connection).
async function portOpenIn(target, port) {
  return target.ip ? checkPort(port, undefined, { host: target.ip }) : false;
}

/** Is the project's port occupied? In the namespace of its instance, otherwise locally as before (the route's start check). */
export async function portOccupied(projectId, port, { instance = MAIN } = {}) {
  const target = targetOf(projectId, instance);
  return target ? portOpenIn(target, port) : checkPort(port);
}

async function probeInInstance(target, { port, container, projectId = null, projectPath = "", dir = "" }) {
  if (container) {
    const list = await innerState(target);
    if (list !== null && runningNames(serviceHits(list, container, { projectId, projectPath, dir })).length > 0) return true;
    return port != null ? portOpenIn(target, port) : false;
  }
  if (port != null) return portOpenIn(target, port);
  return false;
}

async function pidsOnPortIn(target, port, query = (command) => inInstance(target, command)) {
  const { stdout } = await query(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
  return String(stdout || "").split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

// ── The observer of the runtime files ──
// Per folder one fs.watch (where possible) and a query on a beat; per file one receiver, called once as soon as it exists (the
// wrapper writes atomically: tmp + rename — if it exists, it is complete). Without a registered file the folder is free.
export const SERVICE_QUERY_MS = 1_000;
const queryMs = () => {
  const n = Number(process.env.CBASE_SERVICE_QUERY_MS);
  return Number.isInteger(n) && n > 0 ? n : SERVICE_QUERY_MS;
};
const observed = new Map(); // folder → { watcher, tick, files: Map(file → receiver) }

function closeObserver(folder, o) {
  try { o.watcher?.close(); } catch { /* already closed */ }
  clearInterval(o.tick);
  if (observed.get(folder) === o) observed.delete(folder);
}

function checkFolder(folder) {
  const o = observed.get(folder);
  if (!o) return 0;
  let n = 0;
  for (const [file, fn] of [...o.files]) {
    if (o.files.get(file) !== fn || !serviceFileExists(file)) continue;
    o.files.delete(file);
    n += 1;
    try { fn(); } catch (e) { console.error(`[services] receiver of ${path.basename(file)}: ${e?.message || e}`); }
  }
  if (!o.files.size) closeObserver(folder, o);
  return n;
}

function observe(file, fn) {
  const folder = path.dirname(file);
  let o = observed.get(folder);
  if (!o) {
    o = { watcher: null, tick: null, files: new Map() };
    observed.set(folder, o);
    if (process.env.CBASE_SERVICE_FSWATCH !== "0") {
      try {
        const w = fs.watch(folder, { persistent: false }, () => checkFolder(folder));
        w.on("error", () => { try { w.close(); } catch { /* already closed */ } if (o.watcher === w) o.watcher = null; });
        o.watcher = w;
      } catch (e) {
        console.warn(`[services] fs.watch on ${folder} not possible (${e?.message || e}) — the query on the beat carries alone`);
      }
    }
    o.tick = setInterval(() => checkFolder(folder), queryMs());
    o.tick.unref?.();
  }
  o.files.set(file, fn);
  // The file may already exist (a command that ends at once): an event BEFORE registering would never come.
  queueMicrotask(() => checkFolder(folder));
}

function forgetFile(file) {
  if (!file) return;
  const folder = path.dirname(file);
  const o = observed.get(folder);
  if (!o) return;
  o.files.delete(file);
  if (!o.files.size) closeObserver(folder, o);
}

/** Clock seam (tests): look now, as the query on the beat would. Returns: the number of files it found. */
export function serviceQueryNow() {
  let n = 0;
  for (const folder of [...observed.keys()]) n += checkFolder(folder);
  return n;
}
/** The registered files (tests wait for none to be open any more). */
export const openServiceObservations = () => [...observed.values()].reduce((s, o) => s + o.files.size, 0);

const readInteger = (file) => {
  try {
    const t = readServiceFile(file).trim();
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch { return null; }
};
const readPgid = (file) => { const n = file ? readInteger(file) : null; return n && n > 1 ? n : null; };
const removeRunFiles = (run) => {
  for (const d of [run.pgidFile, run.exitFile]) if (d) { try { removeServiceFile(d); } catch { /* ignore */ } }
};
// An entry from an earlier run of the container (runValid false): nothing will ever write its files.
function orphaned(run) {
  forgetFile(run.pgidFile);
  forgetFile(run.exitFile);
  removeRunFiles(run);
}

// The start in the project container, after the `docker exec -d`: its failure, the wrapper's pgid and exit file.
function observeService(run, child, { afterTheEnd, failNotice }) {
  let stderr = "";
  let failed = false;
  child.stderr?.on("data", (b) => { stderr = `${stderr}${b}`.slice(-4000); });
  const fails = (reason) => {
    if (failed) return;
    failed = true;
    orphaned(run);
    try { attachToServiceFile(run.logFile, T`[cbase] Start failed: ${reason}\n`); } catch { /* log gone */ }
    failNotice(reason);
  };
  child.on("error", (e) => fails(e.message));
  child.on("close", (code) => {
    if (code === 0 || code === null) return;
    const row = stderr.split("\n").map((z) => z.trim()).find(Boolean) || "";
    fails(T`docker exec exited with code ${code}${row ? `: ${row}` : ""}`);
  });
  observe(run.pgidFile, () => {
    const n = readPgid(run.pgidFile);
    if (n && RUNS.get(run.key) === run && run.pgid !== n) { run.pgid = n; persist(); }
  });
  observe(run.exitFile, () => {
    const code = readInteger(run.exitFile);
    const pgid = readPgid(run.pgidFile);
    forgetFile(run.pgidFile);
    removeRunFiles(run);
    if (RUNS.get(run.key) !== run) return; // stopped or replaced — no failed start
    if (pgid && !run.pgid) run.pgid = pgid;
    run.ended = code;
    persist();
    if (code === null) return; // unreadable: no verdict
    if (code > 128) afterTheEnd(null, `SIG${code - 128}`);
    else afterTheEnd(code, null);
  });
}

// Does a run in the project container live? true · false · null (unknown). An agent start has no group (in B: `!run.pid`), an ended or
// orphaned run does not live; without a pgid file it is still starting as long as no exit file stands.
async function instanceRunAlive(run) {
  if (run.mode !== "simple") return false;
  if (run.ended !== undefined && run.ended !== null) return false;
  // The instance of the entry (its identifier) — a run of the copy is asked in the copy; if that is gone, it is unknown (null), never
  // "looked up in the main".
  const instance = instanceOfRun(run);
  let target;
  if (copyNameOf(instance) === null) target = targetOf(run.projectId);
  else {
    try { target = targetOf(run.projectId, instance); } catch (e) {
      if (e instanceof ServiceInstanceError) return null;
      throw e;
    }
  }
  if (!target) return false;
  // A verdict "orphaned" never from the cache: a remembered `running:false` from when the container was stopped would otherwise declare
  // a run orphaned that was started AFTER the restart — orphaned() deletes its files, the status its entry, and the service lives on
  // unmanaged (stop "stopped" without a kill, a second start doubled). Positive verdicts may come from the cache: they only lead to `kill -0`.
  let valid = await runValid(run, target);
  if (valid === false) valid = await runValid(run, target, { fresh: true });
  if (valid === false) orphaned(run);
  if (valid !== true) return valid;
  const pgid = run.pgid || readPgid(run.pgidFile);
  if (!pgid) return !(run.exitFile && serviceFileExists(run.exitFile));
  const r = await inInstance(target, ["kill", "-0", "--", `-${pgid}`]);
  return r.code === 0 ? true : r.code === null ? null : false;
}

// The pgid of a run for the stop: from the entry, otherwise from the file — if that is not there yet (stop right after the start), it
// waits until the wrapper writes it, with a cap that says it is one.
export const SERVICE_PGID_MS = 5_000;
const pgidCapMs = () => {
  const n = Number(process.env.CBASE_SERVICE_PGID_MS);
  return Number.isInteger(n) && n > 0 ? n : SERVICE_PGID_MS;
};
async function pgidOf(run) {
  if (run.pgid) return run.pgid;
  const since = Date.now();
  for (;;) {
    const n = readPgid(run.pgidFile);
    if (n) { run.pgid = n; return n; }
    if (!run.pgidFile || (run.ended !== undefined && run.ended !== null) || (run.exitFile && serviceFileExists(run.exitFile))) return null;
    if (Date.now() - since >= pgidCapMs()) {
      console.warn(`[services] cap of ${pgidCapMs()} ms reached: no pgid file for service ${run.serviceId} in ${run.instance} — ` +
        "the group stop is skipped, the stop at the port is not (CBASE_SERVICE_PGID_MS)");
      return null;
    }
    await delay(25);
  }
}

// The stop in the project container (stopService with an instance) — the same sequence as in B.
// IN THE PAUSE: a frozen container is "wait briefly" — the stop waits for the thaw before it asks anything (so the group gets TERM
// and after the grace period KILL, both after the thaw). At the barrier's cap, and if a call gets "is paused" anyway (a pause cbase
// does not hold): no verdict — the entry, the desired state and the run stay, the answer is `stopped: false` with the message. Before,
// a stop in the pause killed nothing but deleted entry and desired state and reported `stopped: true`; the group ran on unmanaged after
// the thaw.
async function stopInInstance(target, { k, run, projectId, serviceId, p, container, projectPath, instance = MAIN, dir = "" }) {
  const frozenNotice = (e, hit = []) => ({
    killed: [...hit],
    stopped: false,
    error: T`Project container ${target.identifier} is frozen — service ${serviceId} not stopped, try again (${e?.message || e})`,
  });
  if (isFrozen(target.container)) {
    try { await waitForThaw(target.container, `stop of service ${serviceId}`); } catch (e) { return frozenNotice(e); }
  }
  let paused = null; // the first call that got "is paused": then no verdict
  const query = async (command) => {
    const r = await inInstance(target, command);
    if (r.paused && !paused) paused = `${command[0]} ${command[1] || ""}`.trim();
    return r;
  };
  const killed = new Set();
  if (container) {
    const choice = { projectId, projectPath, dir };
    const targets = runningNames(serviceHits(await innerState(target), container, choice));
    if (targets.length > 0) {
      await Promise.all(targets.map((n) => dockerIn(target.container, ["stop", n], { capMs: 30_000 }).catch((e) => {
        if (isPausedError(e) && !paused) paused = "docker stop";
      })));
      forgetInsideStatus(target); // the status should see the stop at once
      if (paused) return frozenNotice(paused, killed);
      RUNS.delete(k);
      persist();
      desiredSet(projectId, serviceId, false, instance);
      const stillRunning = runningNames(serviceHits(await innerState(target), container, choice)).length > 0;
      return { killed: targets, stopped: !stillRunning };
    }
  }
  // The group of the simple start — only from an entry of the CURRENT container run, asked fresh: a stop is rare, and a pgid from an
  // earlier run would hit a foreign group.
  let pgid = null;
  if (run?.instance && run.mode === "simple") {
    const valid = await runValid(run, target, { fresh: true });
    if (valid === true) pgid = await pgidOf(run);
    else if (valid === false) orphaned(run);
    else console.warn(`[services] stop of service ${serviceId} in ${target.identifier}: container not readable — no group stop`);
  }
  const group = async (sig) => {
    if (pgid && (await query(["kill", `-${sig}`, "--", `-${pgid}`])).code === 0) killed.add(pgid);
  };
  await group("TERM");
  if (p != null) {
    for (const pid of await pidsOnPortIn(target, p, query)) {
      if ((await query(["kill", "-TERM", String(pid)])).code === 0) killed.add(pid);
    }
  }
  await delay(1500);
  // Hard-kill the survivors.
  await group("KILL");
  if (p != null) for (const pid of await pidsOnPortIn(target, p, query)) await query(["kill", "-KILL", String(pid)]);
  if (paused) return frozenNotice(paused, killed); // no verdict: entry and desired state stay
  RUNS.delete(k);
  persist();
  desiredSet(projectId, serviceId, false, instance);
  const stillOpen = p != null ? await portOpenIn(target, p)
    : pgid ? (await inInstance(target, ["kill", "-0", "--", `-${pgid}`])).code === 0 : false;
  return { killed: [...killed], stopped: !stillOpen };
}

/**
 * Start the native services of a relocated project like the start button (simple start), without a question — for the restore from the
 * instance's desired services. Per service the same checks as the route (already running, port occupied, no start command), one after
 * the other.
 * @param {string} projectId
 * @param {number[]} svcIds  ids of the service rows (desired services)
 * @param {{ instance?: string }} [opts]  the instance: without it the main; a copy starts in ITS container
 * @returns {Promise<{ started: number[], error: { id, reason }[], alreadyRunning: number[] }>}  never throws
 */
export async function startDesiredServices(projectId, svcIds, { instance = MAIN } = {}) {
  const ids = (Array.isArray(svcIds) ? svcIds : []).map(Number);
  const started = [];
  const error = [];
  const alreadyRunning = [];
  const all = (reason) => ({ started, error: ids.map((id) => ({ id, reason })), alreadyRunning });
  let target;
  try { target = targetOf(projectId, instance); } catch (e) { return all(String(e?.message || e)); }
  if (!target) return all(T("not a relocated project (no instance row or no ops marker)"));
  let info = null;
  try { info = projectServicesFn ? projectServicesFn(String(projectId)) : null; } catch (e) { return all(String(e?.message || e)); }
  if (!info) return all(projectServicesFn ? T("Project unknown") : "services: setServicesSeam without projectServices");
  if (!info.path || !fs.existsSync(info.path)) return all(T("Project path not found"));
  for (const id of ids) {
    const svc = Number.isInteger(id) ? (info.services || []).find((s) => s.id === id) : null;
    // A re-scan keeps the ids (store/projects.js) — unknown means deleted.
    if (!svc) { error.push({ id, reason: T("Service unknown (deleted)") }); continue; }
    try {
      // A run in the project container that still lives is "already running", even if its port is still closed: it is booting.
      // serviceStatus asked only the port for a port service, and the second start replaced the entry — the first run lived on
      // unmanaged. Unknown (null, container not readable) does not start twice either. The route keeps its semantics.
      const run = RUNS.get(key(projectId, svc.id, instance));
      if (run?.instance && (run.ended === undefined || run.ended === null) && (await instanceRunAlive(run)) !== false) {
        alreadyRunning.push(svc.id);
        continue;
      }
      if ((await serviceStatus(projectId, svc.id, { ...svc, instance })).running) { alreadyRunning.push(svc.id); continue; }
      if (svc.port != null && (await portOccupied(projectId, svc.port, { instance }))) { error.push({ id, reason: T`Port ${svc.port} is already occupied` }); continue; }
      if (!svc.startCommand) { error.push({ id, reason: T("no start command stored") }); continue; }
      startSimple({ projectId, service: svc, cwd: svc.cwd, projectName: info.name, workspaceId: info.workspaceId ?? null, instance });
      started.push(svc.id);
    } catch (e) {
      if (e instanceof ServiceRunningError) alreadyRunning.push(svc.id); // the start guard saw a living group
      else error.push({ id, reason: String(e?.message || e) });
    }
  }
  return { started, error, alreadyRunning };
}

// ── Background monitor ───────────────────────────────────────────────────────────
// Periodically checks all known services and reports status changes (down/up). Runs in the persistent main process, regardless of
// whether anybody has the services view open. An outage is reported only after 2 consecutive failed probes (debounce against short
// dropouts in the port check).
let monitorTimer = null;
let getTargetsFn = null; // () => [{ key, name, projectId, projectName, workspaceId, port, container, dir }]
// The rebuild marker of a layout change per project (projectbox/layout/procedure.js, step 2 to 21) — the monitor does not check a
// project with a marker (see runMonitorPass). Only in memory: the restart grace of the layout sets it anew for every open job.
const rebuildMarkers = new Set();
export function setRebuildMarker(projectId, enabled) {
  const pid = String(projectId ?? "");
  if (!pid) return;
  if (enabled) rebuildMarkers.add(pid); else rebuildMarkers.delete(pid);
}
export const rebuildMarkerStands = (projectId) => rebuildMarkers.has(String(projectId ?? ""));
let notifyFn = null; // (event) => boolean  (true = delivered natively, then no in-app toast)
const monState = new Map(); // key -> { up: boolean, downStrikes: number }
const monEvents = []; // ring buffer of the latest events
let eventSeq = 0;
const DOWN_STRIKES = 2;

// Common appending of a bell event (id, time, native delivery, ring buffer).
function pushEvent(partial) {
  const ev = { id: ++eventSeq, at: Date.now(), native: false, ...partial };
  // The push verdict BEFORE the persistence: the ring buffer is read again on catch-up, and a catch-up must see the same decision as
  // the live stream.
  try {
    const verdict = pushGateFn ? pushGateFn(ev) : null;
    if (verdict) Object.assign(ev, verdict);
  } catch {
    // Without a verdict it stays at the previous behavior (deliver) — a broken setting must not swallow the notification.
  }
  // Focus-dependent delivery: notifyFn (main.js) shows the native macOS notification when the app is UNFOCUSED and reports that back —
  // then no double in-app toast.
  try {
    ev.native = notifyFn ? Boolean(notifyFn(ev)) : false;
  } catch {
    ev.native = false;
  }
  monEvents.push(ev);
  if (monEvents.length > 100) monEvents.shift();
  persistEvents();
  // Publish only after the persistence: if the receiver disconnects right now, it can catch the event up by its id via /api/services/events.
  try { eventFn?.(ev); } catch { /* a push bridge must never disturb the actual run */ }
  return ev;
}

function recordEvent(kind, t) {
  const title = kind === "down" ? T("Service unreachable") : T("Service back up");
  // A service of a copy names the copy between project and service ("Checkout · copy k1 · web").
  const where = [t.projectName, t.instance ? copyAddition(t.instance) : "", t.name].filter(Boolean).join(" · ");
  const body = `${where}${t.port != null ? ` (:${t.port})` : ""}`;
  pushEvent({
    kind, // "down" | "up"
    key: t.key, name: t.name,
    projectId: t.projectId, projectName: t.projectName, workspaceId: t.workspaceId,
    port: t.port ?? null, title, body,
    ...(t.instance ? { instance: t.instance } : {}),
  });
}

// The monitor's targets per instance: every service of a project with copies additionally stands there per copy, under the key
// `<key>@copy-<name>` — outage and recovery of a copy report like those of the main, and the main keeps its key (its state in the
// monitor stays). Without a copy the plain list. The copies per project once per pass.
function targetsPerInstance(targets) {
  if (!copiesFn) return targets;
  const perProject = new Map();
  const out = [];
  for (const t of targets) {
    out.push(t);
    const pid = String(t.projectId ?? "");
    if (!pid) continue;
    if (!perProject.has(pid)) perProject.set(pid, copiesTargets(pid).map((z) => z.instance));
    for (const instance of perProject.get(pid)) out.push({ ...t, key: `${t.key}@${instance}`, instance });
  }
  return out;
}

// Generic bell notice (not the service monitor) — e.g. a question or a finished run.
// chatId: a click opens the chat in the chat list (that is how a run started by a trigger reports).
// `collapseId`: own bundle identifier for the push. Without it the gateway bundles per chat and kind — two open approvals in the same
// chat would then be ONE notice.
// `requestId`: the identifier of the question card this notice belongs to — resolveNotices finds it again by it once the card is closed.
// `instance`: the copy in which a service failed to start — set only for a copy, otherwise the field is absent.
export function recordNotice({ kind = "info", title, body = "", chatTitle = "", chatId = null, projectId = null, projectName = null, workspaceId = null, collapseId = null, requestId = null, instance = null } = {}) {
  // `chatTitle` is the BARE name of the chat — it stands at the top of the lock screen, where the bell title ("Question: Foo") would
  // cut off the name for every longer chat.
  return pushEvent({ kind, title: String(title || T("Notice")), body: String(body || ""), chatTitle: String(chatTitle || ""), chatId, projectId, projectName, workspaceId, port: null, ...(collapseId ? { collapseId: String(collapseId).slice(0, 64) } : {}), ...(requestId ? { requestId: String(requestId) } : {}), ...(instance ? { instance: String(instance) } : {}) });
}

// Mark a question/review notice as resolved once its card is closed — answered, answered through a channel or dismissed. Until then
// "Question: …" with its prompt stood in the bell even when nobody was waiting any more: the bell is a history, and a history does
// not know by itself what became of a question.
// The entry is changed IN PLACE (same id): web and iOS fetch the full list, so there is neither a new push nor a jump of the gateway
// cursor.
// `id` is the chat (`chatId`), `requestId` the card. Without requestId — or for existing entries without this identifier — the chat
// suffices; a review has no requestId, there the chat alone carries (at most one review waits per chat).
export function resolveNotices({ id = null, requestId = null, kinds = ["question", "review"] } = {}) {
  let n = 0;
  const chatOf = (e) => (id && e.chatId === id);
  for (const e of monEvents) {
    if (e.resolved || !kinds.includes(e.kind)) continue;
    const hits = requestId && e.requestId ? e.requestId === String(requestId) : chatOf(e);
    if (!hits) continue;
    e.resolved = true;
    e.resolvedAt = Date.now();
    n++;
  }
  if (n) persistEvents();
  return n;
}

function persistEvents() {
  if (!EVENTS_FILE) return;
  try {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify({ seq: eventSeq, events: monEvents }));
  } catch {
    /* persistence is best effort */
  }
}

async function runMonitorPass(seedOnly = false) {
  let targets = [];
  try {
    targets = targetsPerInstance((await getTargetsFn?.()) || []);
  } catch {
    return;
  }
  // A service in a FROZEN project container (projectbox/docker.js) is not checked — it has not failed, it stands for seconds; a probe
  // would wait at the barrier, and a port did not answer. Its state stays as it was (no failure counted, no message, not forgotten).
  // Without an instance nobody asks. Per instance.
  // Rebuild marker: a project whose layout is being rebuilt right now is likewise not checked — its services are stopped on purpose
  // (step 3), a "not reachable" would be a false message. Applies to all instances of the project.
  const frozen = (t) => {
    if (t.projectId && rebuildMarkers.has(String(t.projectId))) return true;
    if (!t.projectId || !projectboxOps()) return false;
    try { const z = targetOf(t.projectId, t.instance || MAIN); return Boolean(z?.container) && isFrozen(z.container); } catch { return false; }
  };
  const paused = targets.filter(frozen);
  // A copy that vanished between list and probe throws (ServiceInstanceError): it drops out of this pass and its state with it — no
  // "not reachable" for a cleaned-up copy, and the pass of the others stays.
  const probe = (t) => (t.instance
    ? probeStatus({ port: t.port, container: t.container, projectId: t.projectId, instance: t.instance, dir: t.dir || "" }).catch((e) => {
      if (e instanceof ServiceInstanceError) return null;
      throw e;
    })
    : probeStatus({ port: t.port, container: t.container, projectId: t.projectId, dir: t.dir || "" }));
  const results = (await Promise.all(targets.filter((t) => !paused.includes(t)).map(async (t) => ({ t, running: await probe(t) })))).filter((r) => r.running !== null);
  const alive = new Set(paused.map((t) => t.key));
  for (const { t, running } of results) {
    alive.add(t.key);
    const prev = monState.get(t.key);
    if (!prev) {
      monState.set(t.key, { up: running, downStrikes: 0 }); // first contact: only remember, do not report
      continue;
    }
    if (seedOnly) {
      prev.up = running;
      prev.downStrikes = 0;
      continue;
    }
    if (running) {
      prev.downStrikes = 0;
      if (!prev.up) {
        prev.up = true;
        recordEvent("up", t); // was down, is reachable again
      }
    } else if (prev.up) {
      prev.downStrikes += 1;
      if (prev.downStrikes >= DOWN_STRIKES) {
        prev.up = false;
        prev.downStrikes = 0;
        recordEvent("down", t); // confirmed outage
      }
    }
  }
  // Forget removed services.
  for (const k of [...monState.keys()]) if (!alive.has(k)) monState.delete(k);
}

export function startMonitor({ intervalMs = 30_000, getTargets, notify } = {}) {
  getTargetsFn = getTargets;
  notifyFn = notify;
  stopMonitor();
  // The first pass seeds the actual state without reporting (only real changes after that alert).
  runMonitorPass(true).catch(() => {});
  monitorTimer = setInterval(() => runMonitorPass(false).catch(() => {}), intervalMs);
  monitorTimer.unref?.();
}

export function stopMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}

// Trigger a check pass manually (e.g. for a "check now" button/tests).
export function checkNow() {
  return runMonitorPass(false);
}

export function getMonitorEvents(sinceId = 0) {
  return monEvents.filter((e) => e.id > sinceId);
}

// Empty the notification history ("Delete all" in the notification center). The counter deliberately keeps RUNNING: it is the
// identity by which the push bridge recognizes what it has already seen. Emptying it too would mean giving every following notice a
// number that has already been assigned — and the receiver discards that as "already delivered".
export function clearMonitorEvents() {
  monEvents.length = 0;
  persistEvents();
}

// Highest number ever assigned — the push bridge matches its cursor against it and recognizes a restart of the sequence (number
// smaller than the cursor) instead of silently discarding everything.
export function currentEventSeq() {
  return eventSeq;
}

// ── The NATIVE runs of a project in B ────────────────────────────────────────────────────────────────────────────────
// The relocation (projectbox/relocation/procedure.js) ends the native services of a project in B before it moves the project into its
// project container, and restarts them there through the wrapper (step 14, startDesiredServices). NEVER via stopService: that also
// kills whatever listens on the port (a foreign process on the same port) and stops containers by NAME (matchContainers) — in the
// relocation step 4 stops the containers itself, by id. Here only the process group B started itself (`run.pid`, own group,
// startSimple `detached`).
//   nativeRuns(projectId)  → [{ serviceId, pid }] — the LIVING entries in RUNS with a process group in B (without `instance`), sorted
//                            (a dead entry is no running service — the way back and step 14 would otherwise restart it). The relocation
//                            writes them into the journal BEFORE it ends them (the way back restarts them). With the ops marker only
//                            groups whose start time is still the entry's — the same verdict as status and start guard
//                            (groupOfTheEntry): also a group whose leader has ended and whose boot marker fits stands here (step 4 ends
//                            its member, the process search excludes the group, the tick sees a service).
//   endNativeRuns(projectId, serviceIds, { graceMs })  per entry SIGTERM to the group, after the grace period (product cap, default 5 s)
//                            SIGKILL to every one in which a member still lives (not just the leader); whether it is the own one is fixed
//                            once BEFORE the TERM (nativeRuns) and applies to both signals; the entries fall out of RUNS (saved).
//                            Afterwards "clear RUNS": every other entry of the project in B that demonstrably does not run (a group that
//                            is no longer the own one — one without a leader with a living member IS the own one if the boot marker
//                            fits; an agent service without pid with a closed port) falls; what may run stays and stands in `open` (the
//                            plan stopped at it — it gets here only if it started afterwards).
//                            → { ended: [serviceId], hart: [serviceId], open: [serviceId] } — `hart` says whom only the cap hit.
//   unclearNativeRuns(projectId)  → [{ serviceId, port, reason }]: the entries of the project in B WITHOUT a process group (registered
//                            by the agent, recordAgentRun `pid: null`) that might run — port open (`port-open`) or not checkable
//                            without a port (`without-port`). Step 4 cannot end them (NEVER via the port, see above); the plan collection
//                            reports them, the plan stops, the way out is the stop of the service (stopService, chosen by the human).
export function nativeRuns(projectId) {
  const pid0 = String(projectId ?? "");
  return [...RUNS.values()]
    .filter((r) => String(r.projectId) === pid0 && !r.instance && Number.isInteger(r.pid) && r.pid > 1 && ownGroupAlive(r))
    .map((r) => ({ serviceId: r.serviceId, pid: r.pid }))
    .sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId)));
}

export async function endNativeRuns(projectId, serviceIds, { graceMs = 5_000 } = {}) {
  const pid0 = String(projectId ?? "");
  const intended = new Set((Array.isArray(serviceIds) ? serviceIds : []).map(String));
  // The verdict "own group" falls ONCE, here in nativeRuns (start time), and applies to TERM and KILL: afterwards only whether the GROUP
  // lives counts — its leader is often gone after the TERM, a member that ignores TERM is not.
  const targets = nativeRuns(projectId).filter((l) => intended.has(String(l.serviceId)));
  const group = (pid, sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
  for (const l of targets) group(l.pid, "SIGTERM");
  const until = Date.now() + Math.max(0, graceMs);
  while (targets.some((l) => groupAlive(l.pid)) && Date.now() < until) await delay(50);
  const hart = [];
  for (const l of targets) {
    if (groupAlive(l.pid)) {
      console.warn(`[services] relocation: native service ${l.serviceId} of project ${projectId} still lives after ${graceMs} ms (cap) — SIGKILL to the group`);
      group(l.pid, "SIGKILL");
      hart.push(l.serviceId);
    }
    RUNS.delete(key(projectId, l.serviceId));
  }
  const open = [];
  for (const r of [...RUNS.values()]) {
    if (String(r.projectId) !== pid0 || r.instance) continue;
    const tot = r.pid ? !ownGroupAlive(r) : r.port != null && !(await checkPort(r.port));
    if (tot) RUNS.delete(r.key);
    else open.push(r.serviceId);
  }
  if (open.length) console.warn(`[services] relocation: service(s) ${open.join(", ")} of project ${projectId} may still run in B (without a process group of their own) — not ended`);
  persist();
  return { ended: targets.map((l) => l.serviceId), hart, open: open.sort((a, b) => String(a).localeCompare(String(b))) };
}

export async function unclearNativeRuns(projectId) {
  const pid0 = String(projectId ?? "");
  const out = [];
  for (const r of [...RUNS.values()]) {
    if (String(r.projectId) !== pid0 || r.instance || r.pid) continue;
    if (r.port == null) out.push({ serviceId: r.serviceId, port: null, reason: "without-port" });
    else if (await checkPort(r.port)) out.push({ serviceId: r.serviceId, port: r.port, reason: "port-open" });
  }
  return out.sort((a, b) => String(a.serviceId).localeCompare(String(b.serviceId)));
}
