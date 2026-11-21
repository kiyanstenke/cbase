// Live query of occupied ports: natively by TCP connect, by default against 127.0.0.1 (the user container, "B").
//
// PROJECT CONTAINER. A relocated project no longer listens on B's loopback but in its project container (own network
// namespace); the backend reaches it through the instance's IP (the entrypoint redirects it by DNAT to the container's
// loopback). Hence:
//   checkPort(port, timeoutMs, { host }) / scanPorts(ports, { host })  probe against `host`; by default 127.0.0.1, so without
//     an instance every probe goes where it always went.
//   parseProcNetTcp(text)  the LISTEN rows of /proc/net/tcp{,6}: B reads them from its own /proc, an instance through
//     `docker exec <c> cat ...`.
//   portsInInstance(target)  ONE `docker exec ... cat /proc/net/tcp /proc/net/tcp6`: the instance's LISTEN ports, or `null`
//     (not readable). It is also the liveness probe (instanceAlive) and all the light mode of the port list needs; before,
//     every live instance also ran lsof (two more execs in sequence) just to learn whether it lives.
//   listenersInInstance(target)  the listeners IN an instance: ports from portsInInstance, process (pid, cmd, cwd) via lsof;
//     both through `docker exec` over the Docker seam (projectbox/docker.js; without the ops marker it starts no child).
//     `target` is a network target (projectbox/network-targets.js: `{ identifier, projectId, instance, ip, container }`);
//     this leaf does not import the store, the caller passes the target.
//     The calls run as `agent` (`exec -u agent`): the project box stage has no USER, without `-u` lsof would run as root and
//     resolve the root-owned docker-proxy listeners of the inner dockerd (cwd "/" => "occupied by another" on every
//     published port); B as agent sees no foreign processes (resolveViaProc), and the instance the same.
//     `null` means NOT READABLE (container not running, missing, no operation) and so also: not reachable. instanceAlive
//     asks exactly that; the port list and the tunnel do not probe such an instance (an address without a running container
//     cost 400 ms deadline plus 2 s follow-up per batch, the full scan about 34 s per instance).
//   freePort({ start, end, claims, host })  the first free port: in an instance (`host` set) INSTANCE_BACKEND_PORT (7718) is
//     never free, as projectbox-entry.sh redirects localhost:7718 in the container to the backend.
//   claimsPerSpace / findingsInSpace  the computation of /api/ports/running per NAMESPACE (B or an instance): the claims of a
//     relocated project apply in its instance, all others in B. Without an instance the only space is B with all claims.
//     The CONFLICTS are no longer computed by this leaf but by the one computation of the data layer (store.portConflicts,
//     without relocated projects); findingsInSpace only puts them into the shape of a finding.
import fs from "node:fs";
import net from "node:net";
import { execFile } from "node:child_process";
import { DockerError, docker } from "./projectbox/docker.js";
import { T } from "./i18n.js";

export const DEFAULT_RANGE = { from: 3000, to: 9999 };
export const MAX_PORTS_PER_SCAN = 20000;
const CONNECT_TIMEOUT_MS = 400;
const CONCURRENCY = 500;

const TIMED_OUT = Symbol("timeout");

function connectOnce(port, timeoutMs, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (verdict) => { sock.destroy(); resolve(verdict); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(TIMED_OUT));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

// On loopback a timeout is NO evidence that "nothing listens": a closed port answers at once with ECONNREFUSED, nothing is
// filtered here. A timeout only means the attempt did not get through, in practice because the event loop was blocked and
// the deadline timer fired although the connect was long done (a pass over 26 services stood 481 ms while `docker ps` was
// starting child processes). Exactly then a running service was reported "not active". So retry once with a generous
// deadline instead of taking the timeout as the result.
// How often the follow-up deadline occurred: a count, not behaviour. The test (service-probe.test.js) checks this number
// rather than the call's DURATION, which would measure the machine.
let followUps = 0;
export const followUpCounter = () => followUps;
// `host`: an instance's IP; by default 127.0.0.1. An IPv6 address goes in raw (net.Socket does not add brackets).
export async function checkPort(port, timeoutMs = CONNECT_TIMEOUT_MS, { host } = {}) {
  const first = await connectOnce(port, timeoutMs, host);
  if (first !== TIMED_OUT) return first;
  followUps++;
  return (await connectOnce(port, Math.max(timeoutMs * 5, 2000), host)) === true;
}

export async function scanPorts(ports, { host } = {}) {
  const open = [];
  for (let i = 0; i < ports.length; i += CONCURRENCY) {
    const batch = ports.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((p) => checkPort(p, undefined, { host }).then((ok) => [p, ok])));
    for (const [p, ok] of results) if (ok) open.push(p);
  }
  return open.sort((a, b) => a - b);
}

// Which process listens on which of the given ports? Best effort: Linux through /proc (listener socket inode -> /proc/*/fd),
// macOS through lsof. Foreign processes (other user, e.g. root/docker-proxy) stay unresolved -> null. Never throws.
export async function resolveListeners(ports) {
  const wanted = new Set(ports);
  if (!wanted.size) return {};
  try {
    return process.platform === "linux" ? resolveViaProc(wanted) : await resolveViaLsof(wanted);
  } catch {
    return {};
  }
}

// The LISTEN sockets from the text of /proc/net/tcp or /proc/net/tcp6 (also both back to back, as `cat` prints them):
// `[{ port, inode }]` in text order. The header line ("sl local_address ... st ...") drops out through the state, not
// through its position; a second header in the middle of the text (tcp6 after tcp) as well. State 0A = LISTEN; the port is
// the hex number behind the colon of the local address (IPv4 "0100007F:0BB8", IPv6 32 hex digits before it).
export function parseProcNetTcp(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10 || c[3] !== "0A") continue; // 0A = LISTEN
    const port = parseInt(String(c[1]).split(":")[1], 16);
    if (!Number.isInteger(port)) continue;
    out.push({ port, inode: c[9] });
  }
  return out;
}

function resolveViaProc(wanted) {
  const inodeToPorts = new Map(); // socket inode -> ports (v4+v6 of the same process share one each)
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const { port, inode } of parseProcNetTcp(text)) {
      if (!wanted.has(port)) continue;
      if (!inodeToPorts.has(inode)) inodeToPorts.set(inode, new Set());
      inodeToPorts.get(inode).add(port);
    }
  }
  const out = {};
  if (!inodeToPorts.size) return out;
  let unresolved = inodeToPorts.size;
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // foreign user -> EACCES
    for (const fd of fds) {
      let link = "";
      try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const match = link.match(/^socket:\[(\d+)\]$/);
      if (!match || !inodeToPorts.has(match[1])) continue;
      let cmd = "", cwd = "";
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim().slice(0, 200); } catch {}
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
      for (const port of inodeToPorts.get(match[1])) out[port] ??= { pid: Number(pid), cmd, cwd };
      inodeToPorts.delete(match[1]);
      if (--unresolved === 0) return out;
    }
  }
  return out;
}

const lsof = (args) => new Promise((resolve) => {
  execFile("lsof", args, { timeout: 4000 }, (err, stdout) => resolve(err ? "" : stdout));
});

// `run(args)` -> stdout ("" on error): lsof in B, or IN an instance through docker exec (listenersInInstance).
async function resolveViaLsof(wanted, run = lsof) {
  const out = {};
  // -F format: p<pid> / c<cmd> / n<address> line by line, order p -> c -> n per process.
  const listing = await run(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
  let pid = 0, cmd = "";
  const pidPorts = new Map(); // pid → Set<port>
  for (const line of listing.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); cmd = ""; continue; }
    if (line.startsWith("c")) { cmd = line.slice(1); continue; }
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(1).split(":").pop());
    if (!wanted.has(port) || out[port]) continue;
    out[port] = { pid, cmd, cwd: "" };
    if (!pidPorts.has(pid)) pidPorts.set(pid, new Set());
    pidPorts.get(pid).add(port);
  }
  if (!pidPorts.size) return out;
  // Look up the working directories in a second call.
  const cwds = await run(["-a", "-p", [...pidPorts.keys()].join(","), "-d", "cwd", "-Fpn"]);
  let cur = 0;
  for (const line of cwds.split("\n")) {
    if (line.startsWith("p")) { cur = Number(line.slice(1)); continue; }
    if (!line.startsWith("n") || !pidPorts.has(cur)) continue;
    for (const port of pidPorts.get(cur)) if (out[port]?.pid === cur) out[port].cwd = line.slice(1);
  }
  return out;
}

// ── Listeners IN an instance ──────────────────────────────────────────────────────────────────────────────────────
// A `docker exec` costs 83 ms at the median; the port list polls. So one state per instance like the docker state in
// services.js: valid for 4 s, a running call is SHARED (concurrent requests do not start a second), and another container
// under the same identifier (recreation) discards it. "Not readable" (null) also holds for 4 s: a stopped container is not
// asked again on every request.
// TWO states: the ports (ONE `cat`) and, on top, the processes (lsof, two more execs). Whoever only asks whether an
// instance lives or which ports listen there (light mode of the port list, tunnel, port choice) pays the one exec; process
// resolution only whoever needs it. Measured with about 16 instances under load, the light mode cost 3.4-4.7 s cold when it
// ran all three execs per instance in sequence, and the client's native browser gave up after 4 s ("not measurable", so no
// forwarding to its own copy).
export const INSTANCE_STATUS_MS = 4000;
// Product cap per `docker exec`: a jammed container does not hold up the port list. Estimated (twenty times `cat` and `lsof`,
// both measured under 0.5 s), reported as a cap through the Docker seam. The client's native browser waits longer than this
// (client/browser-rules.js CONTAINER_DEADLINE_MS).
const INSTANCE_CAP_MS = 10_000;
const portsState = new Map();   // identifier -> { container, at, value: number[] | null, running }
const instanceStatus = new Map(); // identifier -> { container, at, value: { <port>: process | null } | null, running }

/** Forgets an instance's state (without argument: all), after a change the caller knows about. Both states. */
export function forgetListenerStatus(identifier) {
  if (identifier === undefined) { portsState.clear(); instanceStatus.clear(); }
  else { portsState.delete(String(identifier)); instanceStatus.delete(String(identifier)); }
}

const targetValid = (target) => Boolean(target) && typeof target.container === "string" && Boolean(target.container);
const statusKey = (target) => String(target.identifier || target.container);

// Every look inside as `agent`: without `-u` it would run as root (the project box stage has no USER), and lsof would resolve
// the root-owned docker-proxy listeners of the inner dockerd; B as agent does not see them, and neither does the instance.
// /proc/net/tcp{,6} is readable by everyone. The same `-u agent` as every other exec in projectbox/ and runtime/inProject.js.
const asAgent = (container, ...command) => ["exec", "-u", "agent", container, ...command];

// lsof IN the instance: the same shape as `lsof()` above; an error (also exit 1 "nothing found") is empty output.
const lsofIn = (container) => async (args) => {
  try { return (await docker(asAgent(container, "lsof", ...args), { capMs: INSTANCE_CAP_MS })).stdout; } catch { return ""; }
};

// The LISTEN ports IN the instance from ONE `cat`: sorted, or `null` if the container is not readable.
async function readPorts(container) {
  let text = "";
  try {
    text = (await docker(asAgent(container, "cat", "/proc/net/tcp", "/proc/net/tcp6"), { capMs: INSTANCE_CAP_MS })).stdout;
  } catch (e) {
    // `cat` ends with 1 if /proc/net/tcp6 is missing (IPv6 off); the tcp rows are on stdout anyway. Only an exit of the
    // command counts like this; a container that does not exist or is not running yields no stdout.
    text = e instanceof DockerError && typeof e.code === "number" ? e.stdout : "";
  }
  // Not readable is UNKNOWN, not "nothing listens": the caller reports it.
  if (!String(text).trim()) return null;
  return [...new Set(parseProcNetTcp(text).map((l) => l.port))].sort((a, b) => a - b);
}

// An instance's ports state as an entry (with `at`; the process state takes it over, see listenersInInstance).
function portsEntry(target) {
  const key = statusKey(target);
  const old = portsState.get(key);
  if (old && old.container === target.container) {
    if (old.running) return old.running;
    if (Date.now() - old.at < INSTANCE_STATUS_MS) return Promise.resolve(old);
  }
  const entry = { container: target.container, at: 0, value: null, running: null };
  entry.running = readPorts(target.container).catch(() => null).then((value) => {
    entry.at = Date.now();
    entry.value = value;
    entry.running = null;
    return entry;
  });
  portsState.set(key, entry);
  return entry.running;
}

/**
 * The LISTEN ports IN an instance: `number[]` (sorted, from /proc/net/tcp{,6} in the network namespace of the project
 * container) or `null` if the container was not readable (missing, stopped, no operation). ONE `docker exec`, 4 s state, a
 * running call is shared. The list is a copy; the state belongs to all callers. Never throws.
 */
export async function portsInInstance(target) {
  if (!targetValid(target)) return null;
  const { value } = await portsEntry(target);
  return value === null ? null : [...value];
}

/**
 * The listeners IN an instance: `{ <port>: { pid, cmd, cwd } | null }` for every LISTEN socket in the project container's
 * network namespace (ports from portsInInstance; `null` = lsof could not assign it to a process), or `null` if the container
 * was not readable (missing, stopped, no operation). `target.container` is the name for `docker exec`
 * (projectbox/run-instance.js containerOf). Never throws.
 * The state is as old as its port list (it takes over its `at`): a shared ports state from 3 s ago does not make a process
 * state that holds another 4 s.
 */
export function listenersInInstance(target) {
  if (!targetValid(target)) return Promise.resolve(null);
  const key = statusKey(target);
  const old = instanceStatus.get(key);
  if (old && old.container === target.container) {
    if (old.running) return old.running;
    if (Date.now() - old.at < INSTANCE_STATUS_MS) return Promise.resolve(old.value);
  }
  const entry = { container: target.container, at: 0, value: null, running: null };
  entry.running = (async () => {
    const p = await portsEntry(target);
    entry.at = p.at;
    if (p.value === null) return null;
    const ports = new Set(p.value);
    const processes = ports.size ? await resolveViaLsof(ports, lsofIn(target.container)) : {};
    const out = {};
    for (const prt of p.value) out[prt] = processes[prt] ?? null;
    return out;
  })().catch(() => null).then((value) => {
    if (!entry.at) entry.at = Date.now();
    entry.value = value;
    entry.running = null;
    return value;
  });
  instanceStatus.set(key, entry);
  return entry.running;
}

/**
 * Does the instance live, i.e. is its container readable (portsInInstance not `null`)? Only a live instance is worth a
 * network path: an address without a running container does not answer, every probe there runs into deadline and follow-up.
 * ONE `docker exec` (the ports state, 4 s), not the whole process resolution; a `docker exec` against a stopped container
 * fails in milliseconds. Never throws.
 */
export async function instanceAlive(target) {
  return (await portsInInstance(target)) !== null;
}

// ── Port choice ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The port every instance reserves for the backend: projectbox-entry.sh redirects EVERY local connection of the container to
// 127.0.0.1:7718 by OUTPUT DNAT to the backend (hard-wired, not BASE_URL). A service there would be reachable from B
// (PREROUTING redirects the instance IP without a port limit to the loopback) but never inside the container, where
// localhost:7718 ends at the backend (401 from the fence). The probe from B sees only an RST there and would take it for free.
// Guard: projectbox-network-paths.test.js reads the number from the entrypoint.
export const INSTANCE_BACKEND_PORT = 7718;

// The first free port in [start, end]: neither claimed nor live-occupied (on `host`, by default 127.0.0.1); in an instance
// (`host` set) never INSTANCE_BACKEND_PORT, which then appears with its reason in `reserved` (only then; without an instance
// the answer is the same as ever). `check` is the probe (checkPort; replaceable in the test).
// The SKIPPED claimed ports travel along: "the next free port is 3102" as the whole answer hid that 3100 and 3101 are taken
// as a mere omission, and an omission carries no signal. An agent walked past exactly that and took the free neighbour port of
// the app it was meant to start. Whoever scans a project's range should SEE its services on the way.
export async function freePort({ start, end, claims, host, check = checkPort }) {
  const byPort = new Map(claims.map((r) => [r.port, r]));
  const skipped = [];
  const reserved = [];
  let occupiedWithoutClaim = 0;
  for (let prt = start; prt <= end; prt++) {
    if (host && prt === INSTANCE_BACKEND_PORT) {
      reserved.push({ port: prt, reason: "Backend port of the instance: localhost:7718 in the container goes to the cbase backend (projectbox-entry.sh)" });
      continue;
    }
    const claim = byPort.get(prt);
    if (claim) {
      skipped.push({ port: prt, id: claim.id, service: claim.name, project: claim.projectName,
                           startCommand: claim.startCommand || "" });
      continue;
    }
    if (await check(prt, undefined, host ? { host } : {})) { occupiedWithoutClaim++; continue; }
    // Name only the first entries: whoever searches from 3000 passes very many services, and an answer listing a hundred of
    // them is overlooked again.
    const truncated = skipped.length > 12;
    return { status: 200, body: {
      port: prt,
      skipped: truncated ? skipped.slice(0, 12) : skipped,
      skippedTotal: skipped.length,
      occupiedWithoutClaim,
      ...(reserved.length ? { reserved } : {}),
    } };
  }
  return { status: 404, body: { error: T`No free port between ${start} and ${end}` } };
}

// ── Namespaces of the port list ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The claims (store.listScannedPorts) per namespace: `Map<identifier | null, claim[]>`. `null` is B; a project that has a
 * target (relocated) applies wholly in its namespace, in EVERY one of its namespaces: main and every copy get their project's
 * claims (the same services run there on the same ports; otherwise only the first instance would, and a copy would fill the
 * pill with "unregistered"). Every space is in the map, also empty. Without targets: `{ null -> all }`.
 */
export function claimsPerSpace(claims, targets = []) {
  const cleanOf = new Map();
  const out = new Map([[null, []]]);
  for (const z of targets || []) {
    if (!z?.identifier) continue;
    const pid = String(z.projectId);
    if (!cleanOf.has(pid)) cleanOf.set(pid, []);
    if (!cleanOf.get(pid).includes(z.identifier)) cleanOf.get(pid).push(z.identifier);
    if (!out.has(z.identifier)) out.set(z.identifier, []);
  }
  for (const a of claims || []) {
    const clean = cleanOf.get(String(a?.projectId));
    if (!clean) out.get(null).push(a);
    else for (const k of clean) out.get(k).push(a);
  }
  return out;
}

/**
 * The findings of ONE namespace, each with `instance` (null = B):
 *   conflict       more than one project claims a port; `conflicts` is the result of the ONE computation (store.portConflicts:
 *                  `[{ port, claims }]`, without relocated projects); only the shape is here. The caller gives it to space B;
 *                  an instance has none (its project is relocated). Does not depend on the scan, also applies in `light`.
 *                  REQUIRED (a forgotten field would silently drop the conflicts).
 *   occupiedByOther  an open entry with `mismatch` (a process other than the registered service listens there)
 *   unregistered   a listener without a claim whose cwd lies in a project folder of THIS space (only without `light`)
 * `projects` are the space's projects (B: all without an instance; an instance: its project); a listener from a folder of a
 * project in another space does not belong here.
 */
export function findingsInSpace({ identifier = null, conflicts, open = [], projects = [], light = false }) {
  if (!Array.isArray(conflicts)) throw new TypeError("findingsInSpace without `conflicts` (store.portConflicts): empty means none, missing is no state");
  const findings = [];
  for (const { port: prt, claims: arr } of conflicts) {
    findings.push({ kind: "conflict", port: prt, instance: identifier, services: arr.map((a) => ({ id: a.id, name: a.name, project: a.projectName })) });
  }
  if (light) return findings;
  // Project paths by descending length: if a project lies in another one's folder, the MORE SPECIFIC wins; otherwise every
  // subfolder would get the parent's name.
  const projPaths = projects
    .filter((pr) => pr.path)
    .map((pr) => ({ ...pr, norm: pr.path.replace(/\/+$/, "") }))
    .sort((a, b) => b.norm.length - a.norm.length);
  for (const e of open) {
    if (e.mismatch) {
      findings.push({ kind: "occupiedByOther", port: e.port, instance: identifier, service: e.registered?.name || "", project: e.registered?.projectName || "",
                     process: e.process?.cmd || "", cwd: e.process?.cwd || "" });
      continue;
    }
    if (e.registered || !e.process?.cwd) continue;
    const cwd = e.process.cwd;
    const home = projPaths.find((pr) => cwdInside(cwd, pr.norm));
    if (!home) continue; // some process on the machine, not our business
    findings.push({ kind: "unregistered", port: e.port, instance: identifier, project: home.name, projectId: home.id,
                   workspaceId: home.workspaceId, process: e.process.cmd || "", cwd });
  }
  return findings;
}

// Is `kind` at or below `base`? Both are resolved first, because the two sides come from different worlds: the project path
// was entered by a human (or comes from `path.resolve`), the cwd comes from lsof/ss and is already resolved. On macOS that
// gives `/private/var/folders/...` against `/var/folders/...`, and without this adjustment a perfectly healthy service counts as
// occupied by another just because its folder is reachable through a symlink. The same hits every project under a linked home.
const realCache = new Map();
const real = (p) => {
  if (!p) return "";
  if (realCache.has(p)) return realCache.get(p);
  let out = p;
  try { out = fs.realpathSync(p); } catch { /* path gone or not readable: take the raw form */ }
  realCache.set(p, out);
  return out;
};
export function cwdInside(kind, base) {
  if (!kind || !base) return false;
  const norm = (x) => String(x).replace(/\/+$/, "");
  const candidates = new Set([norm(kind), norm(real(kind))]);
  for (const b of new Set([norm(base), norm(real(base))])) {
    if (!b) continue;
    for (const k of candidates) if (k === b || k.startsWith(b + "/")) return true;
  }
  return false;
}

// Parses '3000-3999,5173,8080' -> sorted port list. Throws on nonsense.
export function parsePortsParam(spec) {
  const out = new Set();
  for (let part of spec.split(",")) {
    part = part.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [loS, hiS] = part.split("-", 2);
      const lo = Number(loS), hi = Number(hiS);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || lo > hi) {
        throw new Error(T`Invalid range: ${part}`);
      }
      for (let p = lo; p <= hi; p++) out.add(p);
    } else {
      const p = Number(part);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(T`Invalid port: ${part}`);
      out.add(p);
    }
  }
  if (out.size > MAX_PORTS_PER_SCAN) throw new Error(T`Too many ports (max ${MAX_PORTS_PER_SCAN})`);
  if (!out.size) throw new Error(T("No ports given"));
  return [...out].sort((a, b) => a - b);
}
