// The stop chain of the project containers at server end.
//
// projectboxServerEnd()  consumer of the hook kind "serverEnd" (registered in server.js with `wait: true`, fired ONLY by
//   runs/server-end.js endServer — so only when the process really ends, never when a server is closed in a test). Without
//   `projectboxOps()` it does nothing: no docker call, the local server ends as before. Otherwise:
//     0. thaw every paused container with the label `cbase.project` (docker.js thawAll) — BEFORE the stop (`docker stop` of a paused
//        one would not hit the inner dockerd with TERM, it would die hard after the deadline), but ALONGSIDE the snapshot, not before
//        it: the chain has 45 s, and thawing (two calls) plus snapshot (two) plus stop (30 s) did not fit in sequence
//        (tools/check/deadlines.test.mjs); thawing therefore carries the snapshot's cap per call. The snapshot of a container that was
//        FROZEN at server end (the set in docker.js — a copy's build that is torn down anyway) is skipped: the last one counts. A
//        container that someone else paused answers the snapshot "is paused" — then the last one counts too;
//     1. per instance with a container IN `ready` the snapshot `desired`: which containers exist IN the project container and in which
//        state — `docker exec … docker ps -aq` and `docker inspect`, via projectbox/docker.js dockerIn. If that fails for an instance
//        (container up, exec breaks after a sysbox restart), its last snapshot stays — "after a hard end the last one counts". ONLY
//        `ready`: in `start`, `recreate`, `create`, `relocation` or `error` the actual state is half or broken (a restore at the stage
//        gate, an entrypoint on `phase=error` with a running dockerd) — writing it as the intent would let the next restore never start
//        the containers standing there as `exited`. Then the last one counts (with a log line); the state is checked once more
//        directly before writing;
//     2. `docker stop -t 30 <ids>` of all containers of the user container with the label `cbase.project`, ONE call (the daemon stops
//        in parallel). 30 s: measured 11.6–12.4 s for a project container with a running stack — the inner dockerd stops its containers
//        with 10 s.
//      ONLY OWN: a user container from an image with `LABEL cbase.project=…` inherits the label and would hit the filter — which ones
//      those are, `inheritedRead` reads ALONGSIDE the snapshot (docker.js onlyOwnProjectContainer: `ps -a`, `inspect`, `image inspect`
//      against the daemon of B, each with the snapshot's cap), so no call is added before the `stop`; a container this does not know
//      (created afterwards, not readable) is stopped as before.
//   The `stop` has no cap of its own (`capMs: 0`): the cap sits where the cost arises — at waiting for "serverEnd" (runs/server-end.js,
//   45 s), and the stop deadline of the user container (60 s) lies above it. The SNAPSHOT has one: per docker call SNAPSHOT_CAP_MS
//   (5 s, knob CBASE_SNAPSHOT_MS). Without it a single hanging `docker exec … docker ps` (a jammed inner dockerd) would hold every stop
//   until the 45-s cap ended the process — and B would then tear down all project containers hard. The deadlines: 2 × 5 s snapshot +
//   30 s stop < 45 s server end; 45 + 5 s closing < 60 s stop deadline of B (tools/check/deadlines.test.mjs holds both).
//
// desiredFromInspect(inspect[], { services, time })  pure: the shape of `desired` from the output of `docker inspect`.
//   { time, container: [{ name, id, service, project, state, exitCode, dependsOn }], services }
//   `service`/`project`/`dependsOn` are the compose labels `com.docker.compose.service`/`…project`/`…depends_on` (raw, as the daemon
//   carries them — `service:condition:restart,…`; the stages are computed by restore.js `startStages`). `services` are the native
//   services of the instance: cbase starts none in a project container yet, so the snapshot only passes on what the last one carried
//   (else `[]`).
// carryForwardDesired(oldDesired, inspect[], { time, services })  pure: `desiredFromInspect` plus the marker `failed: true` — a
//   container that SHOULD run and did not come at the last restore (restore.js desiredAfterRestore sets it) stays `running` in the
//   desired state while it does not run. Without the marker the next snapshot (server end, recreation) would write it as `exited`, and
//   the restore after that would never start it again, without a message. If it runs at the snapshot, the marker falls (it came). All
//   three writers of `desired` from an actual state go through here: this snapshot, recreate.js desiredWrite and restore.js
//   desiredAfterRestore.
// withServicesOfNow(projectId, instance, desired)  `desired` with `services` FRESH from the row — call SYNCHRONOUSLY directly before
//   writing. Between reading the old `desired` and writing the new one lie docker calls (a restore waits up to 300 s per stage); a
//   service start or stop through cbase in this window (services.js carryForwardServiceDesired — the route is not locked in `start`)
//   would otherwise be lost. Without a row or without `desired` in it: `desired` unchanged. The helper stands here and not in
//   services.js: services.js imports this file (desiredFromInspect), an import in the opposite direction would be a cycle.
import * as store from "../store.js";
import { projectboxOps } from "./ops.js";
import { docker, dockerIn, isFrozen, onlyOwnProjectContainer, thawAll } from "./docker.js";
import { containerOf } from "./run-instance.js";

export const PROJECT_STOP_DEADLINE_S = 30;
export const SNAPSHOT_CAP_MS = 5_000;

// Knob CBASE_SNAPSHOT_MS (ms, integer > 0): set small in the test to force the cap (clock seam).
export function snapshotCapMs() {
  const raw = process.env.CBASE_SNAPSHOT_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : SNAPSHOT_CAP_MS;
}
export const PROJECT_LABEL = "cbase.project";

const idsFrom = (text) => String(text || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);

export function desiredFromInspect(inspect, { services = [], time = Date.now() } = {}) {
  const container = (Array.isArray(inspect) ? inspect : []).map((c) => {
    const l = c?.Config?.Labels || {};
    return {
      name: String(c?.Name || "").replace(/^\//, ""),
      id: String(c?.Id || ""),
      service: l["com.docker.compose.service"] || "",
      project: l["com.docker.compose.project"] || "",
      state: c?.State?.Status || "",
      exitCode: Number.isInteger(c?.State?.ExitCode) ? c.State.ExitCode : null,
      dependsOn: l["com.docker.compose.depends_on"] || "",
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { time, container, services: Array.isArray(services) ? services : [] };
}

// The states of a container that mean "runs" in the desired state (restore.js too).
export const DESIRED_RUNNING = new Set(["running", "restarting"]);

export function carryForwardDesired(oldDesired, inspect, { time = Date.now(), services } = {}) {
  const fresh = desiredFromInspect(inspect, { services: services ?? oldDesired?.services ?? [], time });
  const remembered = new Set();
  for (const c of Array.isArray(oldDesired?.container) ? oldDesired.container : []) {
    if (!c?.failed) continue;
    if (c.id) remembered.add(String(c.id));
    if (c.name) remembered.add(String(c.name));
  }
  for (const c of fresh.container) {
    if (!DESIRED_RUNNING.has(c.state) && (remembered.has(c.id) || remembered.has(c.name))) { c.state = "running"; c.failed = true; }
  }
  return fresh;
}

// withoutSuperseded(projectId, inspect[])  the output of `docker inspect` WITHOUT the old containers of renamed stacks (they stand
//   stopped next to the new ones; table `project_superseded`) — the desired state NEVER takes them in, otherwise a restore would start
//   the old stack next to the new one. Compared by id prefix. All four writers of a desired state from an actual state go through
//   here: the snapshot at server end, the desired-state tick (resumption.js), the recreation (recreate.js desiredWrite) and the
//   restore (restore.js).
export function withoutSuperseded(projectId, inspect) {
  const list = Array.isArray(inspect) ? inspect : [];
  let out;
  try { out = [...store.supersededIds(String(projectId ?? ""))]; } catch { out = []; }
  if (!out.length) return list;
  return list.filter((c) => { const id = String(c?.Id || ""); return !id || !out.some((a) => a.startsWith(id) || id.startsWith(a)); });
}

export function withServicesOfNow(projectId, instance, desired) {
  const now = store.projectInstance(projectId, instance)?.desired?.services;
  return desired && Array.isArray(now) ? { ...desired, services: now } : desired;
}

async function snapshot(inst) {
  const capMs = snapshotCapMs();
  const ps = await dockerIn(inst.containerId, ["ps", "-aq"], { capMs });
  const ids = idsFrom(ps.stdout);
  const inspect = ids.length ? JSON.parse((await dockerIn(inst.containerId, ["inspect", ...ids], { capMs })).stdout || "[]") : [];
  // Synchronously before writing: the state still `ready` and the native services of now.
  const now = store.projectInstance(inst.projectId, inst.instance);
  if (now?.state !== "ready") {
    console.log(`[server-end] snapshot ${inst.identifier} discarded (meanwhile “${now?.state ?? "deleted"}”) — the last one counts`);
    return null;
  }
  const desired = withServicesOfNow(inst.projectId, inst.instance, carryForwardDesired(now.desired, withoutSuperseded(inst.projectId, inspect)));
  store.changeProjectInstance(inst.projectId, inst.instance, { desired });
  return desired;
}

// The ids of the containers that inherit `cbase.project` only from their image (see header, 2.). Never throws; without a verdict empty.
async function inheritedRead(capMs) {
  const error = [];
  let all = [];
  try { all = idsFrom((await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${PROJECT_LABEL}`], { capMs })).stdout); }
  catch (e) { console.error(`[server-end] list of inherited labels not readable (${e?.message || e}) — stopping by the label alone`); return new Set(); }
  const own = await onlyOwnProjectContainer(all, { capMs }, error);
  if (error.length) console.error(`[server-end] ${error.join("; ")} — whatever was not readable counts by the label alone`);
  return new Set(all.filter((id) => !own.includes(id)));
}

export async function projectboxServerEnd() {
  if (!projectboxOps()) return { snapshots: 0, stopped: [] };
  let n = 0;
  const withContainer = store.projectInstances().filter((i) => i.containerId);
  // Whoever is frozen NOW gets no snapshot — remembered BEFORE thawing (afterwards the set is empty).
  const frozen = new Set(withContainer.filter((i) => isFrozen(containerOf(i)) || isFrozen(i.containerId)).map((i) => i.identifier));
  const thaw = thawAll({ reason: "server end", capMs: snapshotCapMs() }); // alongside the snapshot (header, 0.)
  // only `ready` — otherwise the actual state is not the intent, and the last snapshot counts (see header).
  const instances = withContainer.filter((i) => i.state === "ready" && !frozen.has(i.identifier));
  for (const i of withContainer) {
    if (i.state !== "ready") console.log(`[server-end] no snapshot for ${i.identifier} (state “${i.state}”) — the last one counts`);
    else if (frozen.has(i.identifier)) console.log(`[server-end] no snapshot for ${i.identifier} (frozen) — the last one counts`);
  }
  let inherited = new Set();
  const foreign = inheritedRead(snapshotCapMs()).then((g) => { inherited = g; }); // alongside the snapshot
  await Promise.all([thaw, foreign, ...instances.map((inst) => snapshot(inst).then(
    (desired) => { if (desired) n += 1; },
    (e) => console.error(`[server-end] snapshot ${inst.identifier} not written, the last one counts (${e?.message || e})`),
  ))]);
  const ids = idsFrom((await docker(["ps", "-q", "--filter", `label=${PROJECT_LABEL}`])).stdout).filter((id) => {
    const other = [...inherited].some((g) => g.startsWith(id));
    if (other) console.log(`[server-end] ${id} carries cbase.project only from its image — no project container, stays`);
    return !other;
  });
  if (ids.length) {
    console.log(`[server-end] stopping ${ids.length} project container(s) (-t ${PROJECT_STOP_DEADLINE_S})`);
    await docker(["stop", "-t", String(PROJECT_STOP_DEADLINE_S), ...ids], { capMs: 0 });
  }
  return { snapshots: n, stopped: ids };
}
