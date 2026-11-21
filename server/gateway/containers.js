// Container management: one long-lived Docker container + named volume per user.
// Talks to the docker CLI (no SDK) — works with Docker Desktop and a Linux daemon.
// State is NOT duplicated: the source of truth is `docker inspect` (survives gateway restarts).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { promisify } from "node:util";
import { meterFor } from "./cbase-share.js";
import { fetchJsonFromBackend } from "./proxy.js";
import { argsForCreation, argsForUpdate, stateFrom } from "./resources.js";

const run = promisify(execFile);
const IMAGE = process.env.GW_IMAGE || "cbase-backend";
const PREFIX = "cbase-u-";
const MEM = process.env.GW_CONTAINER_MEM || "";   // e.g. "4g" — empty = no limit
const CPUS = process.env.GW_CONTAINER_CPUS || ""; // e.g. "2" — HARD limit; empty = none
// The WEIGHT under contention (docker --cpu-shares → cgroup v2 cpu.weight): a "soft priority" without a hard limit and with half
// weight — a user container takes every free thread, the other containers win as soon as they want to compute themselves.
// Three facts you cannot see from the number:
// - No other container sets a weight, all sit at the kernel default cpu.weight 100 — NOT at the equivalent of 1024. sysbox-runc
//   converts linearly (1 + (s − 2) · 9999 / 262142): 512 ⇒ 20, 1024 ⇒ 39; "half" = 50 ⇒ 1287. A runtime with the quadratic
//   formula of newer opencontainers/cgroups would silently turn the same number into something else — re-measure cpu.weight
//   under /sys/fs/cgroup/system.slice/docker-<id>.scope/ after every Sysbox update.
// - The weight only acts between siblings in the same slice (system.slice: the containers, dockerd and other system services).
//   A service that runs in a slice of its own directly under the root gets its share through that slice, independent of this value.
// - A deploy that swaps a container has to carry the value over itself; the unit applies only to
//   containers the gateway creates ANEW — an existing one gets a new value via `docker update`.
// The three values are only the TEMPLATE for new users (resources.js templateFromEnvironment); what a container carries is stored
// per user in gateway.db and arrives here via `setResourcesSource`. Without a source (or row) the unit applies.
const CPU_SHARES = process.env.GW_CONTAINER_CPU_SHARES || "";
export const UNIT_TEMPLATE = Object.freeze({ mem: MEM, cpus: CPUS, cpuShares: CPU_SHARES });

// Where a fresh creation takes its limits from: `(userId) => { ramGiB, cpuPrio, cpuMax } | null`. Set by index.js (users.js
// getResources) — containers.js does not import users.js, the database stays one layer above.
let resourcesSource = null;
export function setResourcesSource(fn) { resourcesSource = typeof fn === "function" ? fn : null; }

// What the host has: threads (for "no CPU upper limit" = `--cpus <threads>` and the range of the upper limit) and MemTotal (for the
// range of the RAM control and the overcommit). Without /proc/meminfo (not Linux) os.totalmem().
export function hostSpecs() {
  let ramTotalBytes = os.totalmem();
  try {
    const m = /^MemTotal:\s+(\d+) kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) ramTotalBytes = Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return { threads: os.cpus().length || 1, ramTotalBytes };
}

/** The limits of a new user container as `docker run` arguments; a weight that is not an integer 2…262144 is dropped. */
export function limitsArgs({ mem = "", cpus = "", cpuShares = "" } = {}) {
  const args = [];
  if (mem) args.push("--memory", mem);
  if (cpus) args.push("--cpus", cpus);
  const w = /^\d+$/.test(String(cpuShares)) ? Number(cpuShares) : NaN;
  if (Number.isInteger(w) && w >= 2 && w <= 262144) args.push("--cpu-shares", String(w));
  return args;
}
// Runtime "sysbox-runc" = safe Docker-in-Docker (inner dockerd without --privileged).
const RUNTIME = process.env.GW_RUNTIME || "";

const cname = (userId) => PREFIX + userId;
const vname = (userId) => PREFIX + userId + "-home";
const nname = (userId) => PREFIX + userId + "-net";
// Own volume for the INNER Docker's data — separate from the home volume because it MUST sit on /var/lib/docker (reason at the
// mount site in ensureRunning).
const dname = (userId) => PREFIX + userId + "-docker";

// A dedicated bridge network per user: containers of different users cannot see each other (the default bridge allows
// inter-container traffic — there A could reach B's auth-less backend via container IP). Outbound/NAT stays normal.
async function ensureNetwork(userId) {
  const name = nname(userId);
  try { await docker(["network", "inspect", name]); }
  catch { await docker(["network", "create", "--label", "cbase.gateway=1", name]); }
  return name;
}

// One ensureRunning per user at a time (single flight) — parallel requests share the start.
const inflight = new Map();
// One destroy per user at a time: userId → { p: promise of the report, purge }. While it runs, ensureRunning refuses.
const teardown = new Map();
// How long a RUNNING but unresponsive container gets before it counts as broken. Adjustable only for the test (which would
// otherwise wait 30 s for exactly this case).
const GRACE_MS = Number(process.env.GW_HEALTH_GRACE_MS || 30_000);
// How long a RUNNING B may stay unresponsive IN A ROW before the gateway replaces it. A busy B is not broken: one that did not
// answer /api/health for 30+ s (event loop occupied) would otherwise be taken for broken after GRACE_MS, its project containers
// stopped (killing the running turn) and removed with `rm -f` — the work gone, the new B not resuming the turn, the journal
// silent. Up to this duration the request gets a 503 (the client retries) and B keeps running. Only one that stays silent this
// long in a row counts as hung and is replaced — with a journal line. Knob GW_UNHEALTHY_REPLACE_MS (ms, ≥ 0), read at runtime;
// 0 = right after GRACE_MS (only for tests).
export const UNHEALTHY_REPLACE_MS = 10 * 60_000;
const replaceAfterMs = () => {
  const n = Number(process.env.GW_UNHEALTHY_REPLACE_MS);
  return process.env.GW_UNHEALTHY_REPLACE_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : UNHEALTHY_REPLACE_MS;
};
// userId → { id, since, last }: since when THIS container (id) has been unresponsive in a row. "In a row" means: between two
// failed checks there was no gap longer than GAP_MS — a gap without a check is unknown, not "sick".
const unhealthySince = new Map();
const GAP_MS = () => 2 * GRACE_MS + 60_000;
const short = (id) => String(id || "").slice(0, 12);

// A user container's stop deadline in seconds. On TERM the backend runs the stop chain (snapshot, then `docker stop -t 30` of each
// project container — measured 11.6–12.4 s with a running stack —, then its own end); the deadline must be above that, otherwise
// SIGKILL hits the inner dockerd mid-chain. Applies at creation (`--stop-timeout`) and at the idle stop (`stop -t`). The same
// number in the deploy: the deploy tool's swap.mjs.
export const B_STOP_DEADLINE = 60;
// The deadline of the project containers (`docker stop -t` INSIDE B) and the cap for the exec that stops them before a B falls
// with `rm -f` — a hanging inner dockerd would otherwise stall the gateway indefinitely (a cap with a message).
export const PROJECT_STOP_DEADLINE = 30;
export const PROJECT_STOP_CAP_MS = (B_STOP_DEADLINE - 5) * 1000;
// Knob GW_PROJECT_STOP_CAP_MS (ms, integer > 0), read at runtime: only the test sets it small, to force the cap on a hanging exec
// (containers.test.js) — otherwise PROJECT_STOP_CAP_MS applies.
export function projectStopCapMs() {
  const raw = process.env.GW_PROJECT_STOP_CAP_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : PROJECT_STOP_CAP_MS;
}

async function docker(args, { timeout = 0 } = {}) {
  const { stdout } = await run("docker", args, { maxBuffer: 8 * 1024 * 1024, timeout });
  return stdout;
}

// Before every `rm -f` of a user container that might be running: stop its project containers (label `cbase.project`) with a
// long deadline — `rm -f` would send B SIGKILL, and with it the inner dockerd, every project container, its dockerd and the stack
// would die hard. The backend's chain (TERM) does NOT run here: an unhealthy B does not answer, and in `destroy` it comes only
// AFTER (a backend that ignores TERM would otherwise end by SIGKILL with its stacks before this script ran). Errors are ignored
// (after a sysbox restart `docker exec` breaks, a B without an inner docker knows no `docker`); a B without project containers is
// done after an empty `ps`. The `desired` snapshot is not written here — on this path the last one applies (residual risk).
// The cap: without it every request of the user would hang on ensureRunning/destroy's single flight as long as the exec hangs
// (e.g. after a sysbox restart). Guard: containers.test.js (an exec that hangs at the gate).
// FIRST thaw every paused project container (via the label, `status=paused`), THEN stop — a paused one does not accept TERM (its
// inner dockerd would die hard after the deadline). A failed `unpause` does not stop the stop (`;`, not `&&`). Guard:
// containers.test.js runs the script.
// ONLY OWN project containers. A user container from an image with `LABEL cbase.project=…` inherits the label and would match both
// filters. `own` keeps of the ids only those whose label is set ON the container — the same comparison as
// server/backend/electron/server/projectbox/own-labels.js ownKey: if the image carries the same, non-empty value, it is inherited;
// if the image (or container) is unreadable, the label alone counts (a project container must never be missing). Guard:
// containers.test.js runs the script against a fake docker with labels on container and image.
const OWN_SCRIPT = "own() { e=; for i in $1; do " +
  "x=$(docker inspect -f '{{.Image}}|{{index .Config.Labels \"cbase.project\"}}' \"$i\" 2>/dev/null) || { e=\"$e $i\"; continue; }; " +
  "b=${x%%|*}; w=${x#*|}; " +
  "if bw=$(docker image inspect -f '{{index .Config.Labels \"cbase.project\"}}' \"$b\" 2>/dev/null) && [ -n \"$bw\" ] && [ \"$bw\" = \"$w\" ]; then continue; fi; " +
  "e=\"$e $i\"; done; printf '%s' \"$e\"; }; ";
export const PROJECT_STOP_SCRIPT = OWN_SCRIPT +
  "p=$(own \"$(docker ps -q --filter label=cbase.project --filter status=paused)\"); [ -z \"$p\" ] || docker unpause $p; " +
  `ids=$(own "$(docker ps -q --filter label=cbase.project)"); [ -z "$ids" ] || docker stop -t ${PROJECT_STOP_DEADLINE} $ids`;
// The exec stop bypasses the backend's `docker()` in B — the observer of the project containers
// (server/backend/electron/server/projectbox/resumption.js) would see a crash in it and immediately restart them in the still-living
// B, and the following `rm -f` would kill them hard. Hence the gateway FIRST sets, as root, the "B ends" marker /run/cbase/b-ends
// (epoch ms; /run/cbase is root 0755), which the backend in runs/server-end.js serverEnds() treats like its own (root-owned, fresh:
// under ten minutes; entry.sh clears it at every start). "root-owned" only keeps out processes WITHOUT docker access — an agent
// process in B has it and could write it via the inner dockerd (why this does not become a boundary: head of runs/server-end.js).
// Errors and cap as with the script: ignored.
export const B_ENDS_SCRIPT = "mkdir -p /run/cbase && chmod 755 /run/cbase && date +%s000 > /run/cbase/b-ends.fresh && " +
  "chmod 644 /run/cbase/b-ends.fresh && mv /run/cbase/b-ends.fresh /run/cbase/b-ends";
async function stopProjectContainer(container) {
  const script = PROJECT_STOP_SCRIPT;
  const cap = projectStopCapMs();
  // The marker is a blink: its own short cap (at most 10 s), so a hanging exec takes nothing from the script.
  await docker(["exec", "-u", "root", container, "sh", "-c", B_ENDS_SCRIPT], { timeout: Math.min(cap, 10_000) }).catch(() => {});
  await docker(["exec", "-u", "agent", container, "sh", "-c", script], { timeout: cap }).catch((e) => {
    if (e?.killed) console.warn(`[gateway] Project containers in ${container}: cap of ${cap} ms reached — B is removed anyway`);
  });
}

// The `desired` snapshot BEFORE the stop in destroy — the backend in B runs it via its route (projectbox/relocation/routes.js, only
// in operation, "rejected" for project containers). The backend's TERM stop chain would come too late: by then the script above
// has already stopped the project containers, their insides are unreadable, and the last snapshot would apply. A named cap — a B
// that does not answer does not stop the stop; every error is ignored (then the last one applies). ensureRunning does NOT call it:
// there B is unhealthy and does not answer anyway.
export const SNAPSHOT_ROUTE = "/api/projectbox/desired-snapshot";
// ESTIMATED, NOT MEASURED: the backend's tick reads two inner calls per project container (≤ 5 s cap each there), 20 s covers a
// handful of projects. Together with the stop script (55 s), destroy is at most 75 s before `stop -t 60`.
export const SNAPSHOT_CAP_MS = 20_000;
function snapshotBeforeTheStop(port) {
  return new Promise((resolve) => {
    let finished = false;
    const end = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(cap);
      if (why) console.warn(`[gateway] Snapshot before the stop (port ${port}): ${why} — the last one applies`);
      resolve();
    };
    const req = http.request({ host: "127.0.0.1", port, path: SNAPSHOT_ROUTE, method: "POST", headers: { "content-length": 0 } }, (res) => {
      res.resume();
      res.on("end", () => end(res.statusCode === 200 ? null : `HTTP ${res.statusCode}`));
      res.on("error", (e) => end(e.message));
    });
    const cap = setTimeout(() => { end(`cap of ${SNAPSHOT_CAP_MS} ms reached`); req.destroy(); }, SNAPSHOT_CAP_MS);
    req.on("error", (e) => end(e.message));
    req.end();
  });
}

// Does the object still exist? true · false (docker says "No such …") · null (docker does not answer or answers otherwise —
// unknown is not "gone"). Only for destroy's report; `inspect` below stays as it is (null for every error).
async function exists(args) {
  try { await docker(args); return true; } catch (e) { return /no such/i.test(String(e?.stderr || e?.message || "")) ? false : null; }
}

async function inspect(name) {
  try {
    const out = await docker(["inspect", name]);
    return JSON.parse(out)[0] || null;
  } catch {
    return null;
  }
}

// Like `inspect`, but unknown is not "gone": null only if docker says "No such …"; if docker does not answer or answers otherwise,
// it throws. For the administration — an unresponsive daemon must not appear there as "container missing".
async function inspectExactly(name) {
  let out;
  try { out = await docker(["inspect", name]); }
  catch (e) {
    if (/no such/i.test(String(e?.stderr || e?.message || ""))) return null;
    throw new Error(`docker inspect ${name}: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`);
  }
  return JSON.parse(out)[0] || null;
}

const conflict = (text) => Object.assign(new Error(text), { status: 409 });
export const teardownRunning = (userId) => teardown.has(userId);

function hostPortOf(info) {
  const b = info?.NetworkSettings?.Ports?.["7718/tcp"]?.[0];
  return b?.HostPort ? Number(b.HostPort) : null;
}

function probeHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitHealthy(port, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probeHealth(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Make sure the user's container is running and healthy. Returns { port }.
// While destroy() runs for this user, ensureRunning creates NOTHING (no start, no run) — a request arriving mid-delete would
// otherwise create a new B with `--restart unless-stopped` (orphaned, with the old home if purge=0), and the delete would still
// report success. It is rejected with a plain message, not waited for: after the delete the user no longer exists.
export function ensureRunning(userId) {
  if (teardown.has(userId)) return Promise.reject(new Error("This user's environment is currently being removed"));
  if (inflight.has(userId)) return inflight.get(userId);
  const p = (async () => {
    const name = cname(userId);
    let info = await inspect(name);

    if (info && info.State?.Running) {
      const port = hostPortOf(info);
      if (port && (await probeHealth(port))) { unhealthySince.delete(userId); return { port }; }
      if (port && (await waitHealthy(port, GRACE_MS))) { unhealthySince.delete(userId); return { port }; }
      // Before the container counts as broken: look once more. During the wait a deploy may have REPLACED it — same name, new id,
      // new host port. Otherwise the wait would knock at the dead port of the old container, and the `rm -f` by NAME would then hit
      // the freshly created successor — together with the inner containers the deploy had just brought back.
      const now = await inspect(name);
      if (now && now.Id !== info.Id) {
        const p2 = hostPortOf(now);
        if (p2 && (await waitHealthy(p2))) return { port: p2 };
        throw new Error("Container was replaced in the meantime but does not answer yet");
      }
      // Running, has a port, but does not answer: busy or hung? Up to UNHEALTHY_REPLACE_MS in a row it counts as busy — 503, nothing
      // is touched. Without a port it is broken (no way to it), which is replaced at once.
      if (port) {
        const nowMs = Date.now();
        const old = unhealthySince.get(userId);
        const continuous = old && old.id === info.Id && nowMs - old.last <= GAP_MS();
        const since = continuous ? old.since : nowMs - GRACE_MS;
        unhealthySince.set(userId, { id: info.Id, since, last: nowMs });
        const duration = nowMs - since;
        if (duration < replaceAfterMs()) {
          console.warn(`[gateway] ${name} (${short(info.Id)}) is running but has not answered /api/health for ${Math.round(duration / 1000)} s — NOT replaced (running work stays); replaced only after ${Math.round(replaceAfterMs() / 1000)} s in a row`);
          throw Object.assign(new Error("The backend is busy and not answering — try again in a moment"), { status: 503, busy: true });
        }
        console.warn(`[gateway] ${name} (${short(info.Id)}) has not answered for ${Math.round(duration / 1000)} s in a row — counts as hung and is REPLACED (stop project containers, rm -f, create anew)`);
      } else {
        console.warn(`[gateway] ${name} (${short(info.Id)}) is running without a host port — is REPLACED (stop project containers, rm -f, create anew)`);
      }
      unhealthySince.delete(userId);
      // Removal is by ID, never by name: the name may belong to someone else by now. Project containers first with a long
      // deadline — no stop path begins with `rm -f` of a running B.
      await stopProjectContainer(info.Id);
      await docker(["rm", "-f", info.Id]).catch(() => {});
      info = null;
    }

    if (info && !info.State?.Running) {
      await docker(["start", name]);
      const to = await inspect(name);
      const port = hostPortOf(to);
      if (port && (await waitHealthy(port))) return { port };
      // Replace a defective leftover (the volume stays!) — it was just started and may be running with project containers.
      console.warn(`[gateway] ${name} (${short(to?.Id || info.Id)}) started but does not become healthy — is REPLACED (rm -f, create anew)`);
      await stopProjectContainer(to?.Id || info.Id);
      await docker(["rm", "-f", to?.Id || info.Id]).catch(() => {});
    }

    const net = await ensureNetwork(userId);
    // `--stop-timeout`: the deadline for every `docker stop` without `-t` (host reboot, `docker restart`).
    const args = ["run", "-d", "--init", "--stop-timeout", String(B_STOP_DEADLINE), "--name", name,
      // unless-stopped: Docker restarts the container automatically after a host reboot or container crash (even OOM) — together
      // with resumeInterruptedWork() in the backend, running work (chats/analyses) survives the restart. Only an explicit
      // `docker stop`/gateway stop keeps it down then.
      "--restart", "unless-stopped",
      "-v", `${vname(userId)}:/home/agent`,
      // The inner Docker daemon stores NOT in the home volume but in a volume of its own on exactly this path. Both are measured and
      // both are needed:
      //  · The home volume is mounted via shiftfs. The kernel refuses every overlay mount on it, and dockerd silently falls back to
      //    `vfs` — which has no layer sharing, every image lies as a full copy (real: 11.5 GB of images → 76 GB).
      //  · Sysbox sets up /var/lib/docker, of all paths, overlay-capable. Another ext4 volume is not enough: dockerd picks vfs
      //    again (tested).
      // A volume of its own instead of the Sysbox default directory, because the latter hangs on the container — every recreation
      // (deploy!) would otherwise throw away all of the user's images.
      "-v", `${dname(userId)}:/var/lib/docker`,
      "-p", "127.0.0.1:0:7718",
      "--network", net,
      "--label", "cbase.gateway=1", "--label", `cbase.user=${userId}`,
      // B knows its user id. Independent of RUNTIME; the same source as the label above. On a swap the deploy sets it from exactly this label (the deploy tool's remote.mjs
      // containerSpecFrom).
      "-e", `CBASE_USER_ID=${userId}`];
    // This user's limits (gateway.db) — without a row the unit applies. A new container after "unhealthy" or "defective leftover"
    // thus carries what the administration stored, not what the unit said weeks ago.
    const values = resourcesSource ? resourcesSource(userId) : null;
    args.push(...(values ? argsForCreation(values, hostSpecs().threads) : limitsArgs({ mem: MEM, cpus: CPUS, cpuShares: CPU_SHARES })));
    if (RUNTIME) args.push("--runtime", RUNTIME, "-e", "CBASE_DIND=1");
    // Host networks B cannot see from inside (LAN, VPN, host bridges) that project networks must avoid — see BLOCK_LIST in
    // server/backend/electron/server/projectbox/creation.js. A swap keeps it (container env, not image env).
    if (process.env.CBASE_SUBNET_BLOCK_LIST) args.push("-e", `CBASE_SUBNET_BLOCK_LIST=${process.env.CBASE_SUBNET_BLOCK_LIST}`);
    args.push(IMAGE);
    console.log(`[gateway] ${name}: creating container (${IMAGE})`);
    await docker(args);
    const port = hostPortOf(await inspect(name));
    if (!port) throw new Error("Container started, but no host port assigned");
    if (!(await waitHealthy(port))) throw new Error("Container does not become healthy (timeout)");
    return { port };
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

export async function status(userId) {
  const info = await inspect(cname(userId));
  if (!info) return { state: "missing" };
  return {
    state: info.State?.Running ? "running" : (info.State?.Status || "stopped"),
    port: hostPortOf(info),
    startedAt: info.State?.StartedAt || null,
  };
}

// What "busy" means in the response of /api/runs/active. Running dynamic workflows do NOT count in `busy` — the deploy does not
// wait for them because it restarts the container right away and the restart resumes them. The reaper, however, puts a container
// to SLEEP, and afterwards nobody wakes it: a workflow in the field `dynWorkflows` is therefore busyness for it. A copy WAITING in
// the queue or for storage (`copiesWaiting`, a number — waiting does not hold `busy`) is the same situation: the agent was told
// "you will be woken", and a sleeping container wakes nobody. A backend without these fields reads as before.
export function busyFrom(body) {
  if (!body || typeof body !== "object") return true; // no readable answer: better not stop
  // dynWorkflows and persistent monitors are NOT in `busy` (the deploy does not wait for them), but a backend put to sleep wakes
  // neither: a running workflow would stall, a watch would end without anybody setting it up again.
  return Boolean(body.busy) || (Array.isArray(body.dynWorkflows) && body.dynWorkflows.length > 0)
    || (Array.isArray(body.monitors) && body.monitors.length > 0)
    || (Number.isFinite(body.copiesWaiting) && body.copiesWaiting > 0);
}

// Is the backend busy right now (running chats/analyses)? The idle reaper asks this so as NEVER to put a container with an active
// job to sleep. If the answer is missing → assume "busy" to be safe (better not to stop than to kill a run). Both questions to the
// container with total deadline and cap (proxy.js fetchFromBackend) — an idle-only deadline and an unbounded body would let a
// trickling or endless backend stall the reaper or the gateway's schedule wakeup for ALL users. An error (deadline, cap, no JSON)
// reads like an outage: busy → busy, occurrence → null (unknown, the stored value stays).
export const BACKEND_QUESTION_DEADLINE_MS = 2500;
export const BUSY_CAP_BYTES = 1024 * 1024;
export const OCCURRENCE_CAP_BYTES = 64 * 1024;
export async function busy(userId) {
  const info = await inspect(cname(userId)).catch(() => null);
  const port = hostPortOf(info);
  if (!port) return false;
  const r = await fetchJsonFromBackend(port, "/api/runs/active", { deadlineMs: BACKEND_QUESTION_DEADLINE_MS, capBytes: BUSY_CAP_BYTES });
  return r.error ? true : busyFrom(r.json);
}

// The path of the wakeup: answered by scheduleNextRoute in scheduled/routes.js with the scheduled jobs — path and answer shape
// stayed so an old gateway reads a new backend correctly. ONE place against which the seam guard
// server/backend/test/scheduled-wakeup-seam.test.js asks the real backend.
export const SCHEDULED_OCCURRENCE_PATH = "/api/schedules/next";

// The earliest upcoming occurrence of a scheduled job in the backend (ms) — 0 if none; null if the container does not answer (then
// the stored value stays).
export async function nextScheduleOccurrence(userId) {
  const info = await inspect(cname(userId)).catch(() => null);
  const port = hostPortOf(info);
  if (!port || !info?.State?.Running) return null;
  const r = await fetchJsonFromBackend(port, SCHEDULED_OCCURRENCE_PATH, { deadlineMs: BACKEND_QUESTION_DEADLINE_MS, capBytes: OCCURRENCE_CAP_BYTES });
  if (r.error) return null;
  return Number(r.json?.nextAt) || 0;
}

// Idle stop: TERM to the backend, which runs the stop chain, with the deadline above it (10 s would end a dockerd by SIGKILL
// before its containers are down).
export async function stop(userId) {
  await docker(["stop", "-t", String(B_STOP_DEADLINE), cname(userId)]).catch(() => {});
}

// Restart (administration): a running start is awaited (otherwise the stop would overtake its `run`), then the same stop as
// above, then the same start as on any request. During a teardown 409 — the user is being removed.
export async function restart(userId) {
  if (teardown.has(userId)) throw conflict("This user's environment is currently being removed");
  await inflight.get(userId)?.catch(() => {});
  await stop(userId);
  return ensureRunning(userId);
}

/**
 * What the user's container currently is and carries: `{ state, since, id, hostConfig, cpuWeight }` (resources.js stateFrom;
 * cpuWeight = cpu.weight from the cgroup, only while it runs). Throws if docker does not answer — unknown is not "missing".
 */
export async function situation(userId) {
  const info = await inspectExactly(cname(userId));
  const { state, since } = stateFrom(info);
  const cpuWeight = state === "running" ? await cbaseMeter.cgroupCount(info.Id, "cpu.weight") : null;
  return { state, since, id: info?.Id ?? null, hostConfig: info?.HostConfig ?? null, cpuWeight };
}

/**
 * Apply new limits to the running (or stopped) container — by id, never by name (the name may belong to a successor by now).
 * index.js has saved BEFORE: a start awaited here or coming after already reads the new value. Without a container there is
 * nothing to apply — the next creation reads the row. If someone replaces the container between inspect and update (deploy swap:
 * it carries the OLD values from its inspect), the update fails on the old id and goes once to the new one. Returns the fresh
 * `situation`.
 */
export async function applyResources(userId, values) {
  if (teardown.has(userId)) throw conflict("This user's environment is currently being removed");
  await inflight.get(userId)?.catch(() => {});
  if (teardown.has(userId)) throw conflict("This user's environment is currently being removed");
  const args = argsForUpdate(values, hostSpecs().threads);
  const info = await inspectExactly(cname(userId));
  if (info) {
    try { await docker(["update", ...args, info.Id]); }
    catch (e) {
      const now = await inspectExactly(cname(userId));
      if (!now || now.Id === info.Id) throw new Error(`docker update: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`);
      await docker(["update", ...args, now.Id]);
    }
  }
  return situation(userId);
}

/** The working set and CPU threads per running container (`{ <id>: { ramBytes, cpuThreads } }`), `null` = not measured. */
export async function consumptionPerContainer() {
  const m = await cbaseMeter.measure({ perContainer: true }).catch(() => null);
  return m?.perContainer ?? null;
}

// Removes the container (+ network) and — only with purge — the user's data volume too.
// The order: FIRST the project containers via marker + exec script, while B runs — cleanly (`-t 30`) and independent of whether
// its backend answers; the "B ends" marker keeps the observer quiet meanwhile. THEN B itself like `stop()` (`-t B_STOP_DEADLINE`):
// its backend runs its own stop chain with serverEnds() — it finds nothing left to stop, but is the second net if the marker could
// not be set and the observer restarted a project container. Putting `docker stop -t 60` FIRST and treating the script as a
// fallback "for a B that does not answer" would be wrong: a backend that ignores TERM (hung event loop; tini forwards TERM only to
// node) ends after the deadline by SIGKILL together with the inner dockerd, project containers and their databases, `docker stop`
// still reports 0 — and the script afterwards would hit a standing B. The `desired` snapshot at the end is skipped on this path
// (the backend's chain sees no running project containers any more): the tick's snapshot applies (projectbox/resumption.js).
// ONE destroy per user (single flight), a running start of the same user is AWAITED (otherwise it would create a new B after the
// `rm -f`), and during the teardown ensureRunning refuses. A REPORT comes back of what is really missing afterwards — not of what
// was attempted: `containerAway` (inspect no longer finds B) and with purge `volumesGone` (both volumes gone). Otherwise destroy
// would ignore every error, and the route would report `purged:true` even if `volume rm` failed on a freshly created B. What the
// report means is decided by index.js (the user stays locked and the delete can be repeated).
// The single flight must respect `purge`: if a delete WITH purge arrives during a teardown without purge, it must not get the
// first one's report (`volumesGone: null`) with no `volume rm` run — the route would answer 500, the first would delete the user
// meanwhile, and the volumes would stay with no way to reach them in the UI. So a call with purge appends the purge step to a
// running one without purge and gets its report; the extended teardown is the running one (ensureRunning keeps refusing, a third
// call shares it). A call without purge shares any running one.
export function destroy(userId, { purge = false } = {}) {
  const running = teardown.get(userId);
  if (running && (running.purge || !purge)) return running.p;
  if (running) {
    const entry = { purge: true, p: null };
    entry.p = running.p.then(async (report) => ({ ...report, volumesGone: await removeVolumes(userId) }))
      .finally(() => { if (teardown.get(userId) === entry) teardown.delete(userId); });
    teardown.set(userId, entry);
    return entry.p;
  }
  const entry = { purge, p: null };
  entry.p = (async () => {
    await inflight.get(userId)?.catch(() => {});
    // First the snapshot (while B and its project containers run), then marker and script.
    const info = await inspect(cname(userId));
    const port = info?.State?.Running ? hostPortOf(info) : null;
    if (port) await snapshotBeforeTheStop(port);
    await stopProjectContainer(cname(userId)); // before stopping B and the `rm -f`
    await docker(["stop", "-t", String(B_STOP_DEADLINE), cname(userId)]).catch(() => {});
    await docker(["rm", "-f", cname(userId)]).catch(() => {});
    await docker(["network", "rm", nname(userId)]).catch(() => {});
    const report = { containerAway: (await exists(["inspect", cname(userId)])) === false, volumesGone: null };
    if (purge) report.volumesGone = await removeVolumes(userId);
    return report;
  })().finally(() => { if (teardown.get(userId) === entry) teardown.delete(userId); });
  teardown.set(userId, entry);
  return entry.p;
}

// Both volumes — otherwise the biggest chunk (the inner Docker) stays behind. Whether one is gone is told by `volume inspect`
// afterwards, not by the exit of `volume rm` (an already missing volume reports an error there and is gone anyway). true = both gone.
async function removeVolumes(userId) {
  let allWay = true;
  for (const v of [vname(userId), dname(userId)]) {
    await docker(["volume", "rm", v]).catch(() => {});
    if ((await exists(["volume", "inspect", v])) !== false) allWay = false;
  }
  return allWay;
}

// The user's storage use: du in the running container (GNU), otherwise a helper container (busybox) — both with -sk (KiB) so the
// unit is uniform. BOTH volumes count: the home volume and the inner Docker's data. They lie apart but together cost the server
// space — and the inner Docker is usually the bigger item. `du` does not follow symlinks, so the legacy symlink
// .docker-data → /var/lib/docker is not counted twice.
export async function storage(userId) {
  const name = cname(userId);
  const info = await inspect(name);
  let out = null;
  try {
    if (info?.State?.Running) {
      out = await docker(["exec", name, "du", "-sk", "/home/agent", "/var/lib/docker"]);
    } else {
      await docker(["volume", "inspect", vname(userId)]); // if the volume is missing, there is nothing to measure
      out = await docker(["run", "--rm", "-v", `${vname(userId)}:/data:ro`,
        "-v", `${dname(userId)}:/dockerdata:ro`, "alpine", "du", "-sk", "/data", "/dockerdata"]);
    }
  } catch {
    return { usedBytes: 0 };
  }
  // One line per path; unreadable lines drop out instead of distorting the sum.
  const kb = String(out)
    .split("\n")
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => a + b, 0);
  return { usedBytes: kb * 1024 };
}

// Free space on the Docker data disk (where the volumes live).
let dockerRoot = null;
export async function hostFreeBytes() {
  try {
    if (!dockerRoot) dockerRoot = (await docker(["info", "--format", "{{.DockerRootDir}}"])).trim() || "/";
    const s = fs.statfsSync(dockerRoot);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    try { const s = fs.statfsSync("/"); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
  }
}

// What the HOST still has in total: RAM (MemAvailable, i.e. including freeable cache), swap, CPU load and the disk of the Docker
// data volume (where the volumes live). For the header's resource pill — under Sysbox the user container sees only its own quota.
// Same shape as `hostResources` in server/backend/electron/server/host-resources.js (own copy: gateway and backend are rolled out
// separately). Additionally `cbase`: what the cbase user containers occupy of it (RAM, swap, CPU cores, disk) — the computation and
// its rules are in cbase-share.js. Only here: the backend does not know the host, and without a gateway (the local server) the
// field does not exist — the pill then shows the bars as before.
export const cbaseMeter = meterFor({ docker });
export async function hostResources() {
  let mem = { totalBytes: os.totalmem(), availableBytes: os.freemem() };
  let swap = null;
  try {
    const info = fs.readFileSync("/proc/meminfo", "utf8");
    const kb = (key) => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb("MemTotal"), avail = kb("MemAvailable"), swapTotal = kb("SwapTotal"), swapFree = kb("SwapFree");
    if (total != null && avail != null) mem = { totalBytes: total, availableBytes: avail };
    if (swapTotal != null && swapFree != null && swapTotal > 0) swap = { totalBytes: swapTotal, freeBytes: swapFree };
  } catch { /* not Linux */ }
  let disk = null;
  try {
    if (!dockerRoot) dockerRoot = (await docker(["info", "--format", "{{.DockerRootDir}}"])).trim() || "/";
    const s = fs.statfsSync(dockerRoot);
    disk = { path: dockerRoot, totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
  } catch {
    try { const s = fs.statfsSync("/"); disk = { path: "/", totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) }; } catch { /* without disk */ }
  }
  const [load1, load5, load15] = os.loadavg();
  const cbase = await cbaseMeter.measure().catch(() => null);
  return { at: Date.now(), cpu: { count: os.cpus().length || 1, load1, load5, load15 }, mem, swap, disk, cbase };
}

export async function listAll() {
  try {
    const out = await docker(["ps", "-a", "--filter", "label=cbase.gateway=1",
      "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"]);
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const [name, state, statusText] = l.split("\t");
      return { name, userId: name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null, state, statusText };
    });
  } catch {
    return [];
  }
}
