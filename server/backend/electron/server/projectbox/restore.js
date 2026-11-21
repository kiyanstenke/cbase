// Restoring the project containers after every start of B.
//
// THE CONTRACT. After a restart of B no inner container starts before its dependencies and none that was not running
// before; no run of a converted project resumes before its instance is `ready` (or visibly ends as `error`), and no
// workflow agent fails because its instance is still coming up. `start` ends at the latest after number of stages × cap
// (+ the cap of waiting for the inner dockerd). Without a valid marker of the network separation the backend starts no
// project container.
//
// earmarkRestore()  in startServer BEFORE the listen: every converted row (`convertedAt`) in `ready`, `error` or `start`
//   becomes `start` (phase "waiting"). The restartGrace hook only fires `restartGraceMs` after the listen; until then the
//   row would say `ready` although its container is stopped after a restart of B, and a message in that window would go to
//   it. `start` holds every turn and every workflow agent of the project at the lock; the transition to `ready` wakes them
//   (instances.js → idle.js wakeProject). Synchronous, no docker; without the ops marker nothing, not even a database
//   read; rows without `convertedAt` stay as they are. A row in `error` is thus retried once at EVERY start. Exception:
//   the instance of a copy being removed (see "A COPY BEING REMOVED" below).
// restoreRestartGrace()  consumer of the restartGrace hook, registered in server.js ("project-restore") before the
//   consumers that start turns and workflow agents and above all before "project-instances" (there a working row WITHOUT a
//   living procedure becomes `error`). It takes the converted rows in `start` without a living procedure (earmarked, or
//   left behind by a crash in the middle of a restore) and enters their procedure SYNCHRONOUSLY (instances.js
//   withProcedure — "project-instances" sees it and leaves the row); orphaned `recreate` rows go synchronously to the
//   seam `setRecreateRestartGrace`, and every restore that ended `ready` then checks the recreate (same seam). Everything
//   else runs asynchronously. The return value is the promise of all procedures (it never throws) — the register counts it
//   as an open hook, so the quiet of the server waits for the restore. Without the ops marker: nothing.
//
// restoreInstance(projectId, instance = MAIN, { reason, state = "start", root, occupancyHeld, fromStopped })
//   → the row afterwards (`ready` or `error`). The procedure of one instance — also for the recreate (there with
//   `state: "recreate"`, so the row stays in ITS state to the end, and with `occupancyHeld: true` when the caller already
//   holds the occupancy itself). Without it the procedure runs under the INSTANCE occupancy "restore" (main and copy of the
//   same project side by side; a project occupancy excludes it).
//   It rejects WITHOUT touching the row: without the ops marker (`NO_OPS`), without a converted row (`NO_INSTANCE`), for a
//   stopped instance (`STOPPED`, unless `fromStopped`), for a copy being removed (`COPY_CLEAR_AWAY`), for a frozen container
//   (`FROZEN`), next to another procedure of the same project (`OCCUPIED`) and for an unknown state. OCCUPIED is checked
//   BEFORE the synchronous `start`: otherwise the row would stand in `start` without a living procedure, and `busy`, the
//   deploy gate and every turn of the project would wait for a transition nobody writes. Every failure AFTER that is the
//   row in `error` with a reason. In an ENDING server (runs/server-end.js serverEnds) the procedure neither starts nor
//   thaws a project container and does not run a second time after a new attempt (the stop chain is halting it right
//   now) — the row ends `error`.
//   The steps, each a phase of the row (words only, no names — the phase is readable unauthenticated in `projectWork`):
//     marker     valid marker of the network separation (network-marker.js) — otherwise `error`, and NO docker call;
//     container  `docker inspect` of the project container (stable name, run-instance.js containerOf; its project label
//                must name the project), `docker start <id>` when it is not running — PAUSED ⇒ `unpause` instead (if cbase
//                holds the pause itself, the end of it is awaited). If it is MISSING ("No such container"), the row is
//                `error` AND the recreate request goes out (same volume, same IP, same stack); every other docker error
//                and a foreign label stay `error` without a request. Hostname or bridge not the derived `cbp-<n>` (a container
//                of a release before the bridge prefix) ⇒ stopped at once, never started, `error` AND the recreate request
//                (namingDeviation);
//     wait       `docker info` inside AND the status file of the entrypoint (instance.js waitForInside). `phase=error` ⇒
//                row `error` with the reason from the file AND the recreate request (a container whose memory cap has
//                no effect is recreated, not used further); any other phase than `ready` ⇒ `error` without a request;
//     stage n/m  desired ∩ existing: the inner containers that are in the snapshot `desired` (by id, otherwise by name) —
//                `startStages` orders them by `depends_on`; per stage `docker start` of those not running whose desired
//                state is running, then wait for `running` (no healthcheck), `healthy` (with one) or exit 0 (a dependent
//                requires `service_completed_successfully`). One-shot containers with desired state `exited` stay as they
//                are. A container that was not running before never starts. CAP PER STAGE: `stageCapMs` — after it every
//                service of the stage that has not arrived counts as failed and the procedure moves on; without the cap
//                a service that never becomes healthy would hold `start` (and with it `busy`, deploy and reaper) forever.
//                A failed service (unhealthy, exit ≠ 0, cap) is named in the `error` field of the row even in `ready`
//                ("ready with a finding") — runs do not wait forever. If the PROJECT CONTAINER ITSELF stands (stopped,
//                OOM, gone — the `exec` reports runtime/git-run.js CONTAINER_STANDS), the row is `error` at once instead
//                of waiting out every stage cap. Other inspect errors warn ONCE per stage;
//     services   the native services from `desired.services` through the seam `setNativeServicesStarter`; without the
//                seam nothing — and the finding names them. The list is read FRESH from the row (a start or stop through
//                cbase during the stages counts). The starter never throws, it reports
//                `{ error: [{ id, reason }] }` — every entry and a throw end up in the finding, without paths;
//     names      the block in /etc/hosts (names.js bringAlongNames; a failure there is only a log line);
//   then `ready` with a new snapshot `desired` (desiredAfterRestore: the state of now, but a container that SHOULD run
//   and failed stays `running` with the mark `failed` — otherwise the next start would forget it; the mark also survives
//   the snapshot at server end and at recreate, serverEnd.js carryForwardDesired), `services` in it fresh from the row
//   (serverEnd.js withServicesOfNow, synchronously before the write), and afterwards, asynchronously, the `atReady`
//   callbacks. Only the setter (instances.js setInstanceState) changes the state of the row.
//
// STOPPED: a row in `stopped` was halted by a human (instance-stop.js). earmarkRestore does not take it, neither does the
//   restartGrace hook, and restoreInstance rejects it (`STOPPED`, 409, row untouched) — except with `fromStopped: true`:
//   only "Start" and the turn that starts it say that (instance-stop.js). Then the row goes synchronously
//   `stopped → start` and the way of every restore. Without this guard the git wakeup (server.js setGitWakeup) would
//   bring a stopped container back on the next look at the git view.
//
// runInstanceUp(pid, inst, { containerId, desired, state }) → { findings, notices, liveness }  the steps stages,
//   services, names above as a function of their OWN — the same start sequence for restore, relocation and copy. Details
//   at the function.
//
// startStages(container[])  PURE: topological stages from the compose labels (`dependsOn` in the form
//   `service:condition:restart,…`, `service`, `project`; the shape of serverEnd.js desiredFromInspect). Dependencies hold
//   within the same compose project. A cycle or an unknown service ⇒ last stage with a notice (and everything depending
//   on it). A container without labels has no dependencies. → `{ stages: [[c…]…], notices: [] }`, every container with
//   `finishedRequired` (a dependent requires `service_completed_successfully`).
// dependsOnFrom(raw)  PURE, TOLERANT: the form `service:condition:restart` separated by commas, spaces irrelevant, missing
//   parts ⇒ `service_started`; also the JSON form `{"db":{"condition":"service_healthy"}}`. An unknown condition counts
//   as `service_started`, with a notice.
// targetReached(inspect, target)  PURE: stand `yes` · `no` · `failed` (with reason) for the targets `running` ·
//   `healthy` · `finished`.
// desiredAfterRestore(oldDesired, inspect[], { time, notArrived })  PURE: the new snapshot — the state of now; a
//   container that should run and failed (`notArrived`: ids AND names of the findings — a desired container the stages
//   found by its NAME has a new id) stays `running` and carries `failed: true`. A one-shot container that ended with 0 as
//   required is `exited` (it must not run again at the next start) — an old mark does NOT carry over here.
//
// SEAMS (setters, no imports — wired in server.js):
//   setNativeServicesStarter(fn)   fn(projectId, svcIds, { instance }) → Promise; without: start nothing, name it in the finding.
//   setRecreateRequest(fn)         fn({ projectId, instance, reason }); without: nothing (the row stays `error`).
//   setRecreateRestartGrace({ resume, check })  the orphaned `recreate` rows of the restartGrace hook and the check after
//                                  each of its restores, see restoreRestartGrace below.
//   atReady(fn) → unsubscribe()    after EVERY transition to `ready` by the restore, asynchronously,
//                                  fn({ projectId, instance, row }); an error is only logged.
//   The request and the callbacks only come AFTER the procedure: the occupancy "restore" and `withProcedure` are free by
//   then (the recreate works under its own occupancy; with a held one it would get OCCUPIED).
// CLOCK SEAM: advanceStagesCap() lets every running stage cap expire at once — returns the count; a test forces the cap
//   that way, without a wall clock.
// Test seam of the marker: `root` (option) or CBASE_NETWORK_ROOT — prefixes /run and /proc as in network-marker.js (empty
//   in the product).
//
// A COPY BEING REMOVED DOES NOT COME BACK UP. copyInClearAway(projectId, instance) → the row in stack_copies when the
//   instance is a copy whose removal runs (`clearAway` past `earmarked`) or failed (`error` — a converted instance row
//   only has a copy that was ready, and from there only the removal leads to `error`), otherwise null (the main instance
//   without a database read). Why: a revived copy runs turns again, and the next removal would resume at its journal
//   WITHOUT fetching and backing up — whatever was created since the revival would be in no ref. Therefore:
//     - restoreInstance rejects such an instance (`COPY_CLEAR_AWAY`, 409) WITHOUT touching the row — that covers every
//       caller; not readable ⇒ rejected as well;
//     - earmarkRestore does not set it to `start`: in `error` it stays with its reason; if it stands `ready` or `start`
//       (revived), it becomes `error` with the phase REVIVED — the removal then fetches and backs up once more
//       (stacks/clearAway.js);
//     - recreate.js neither tries a new attempt out of `error` nor a recreate — the container belongs to the removal, which
//       starts it itself and recreates it itself when it is missing;
//     - idle.js projectLock tells the chat how to go on.
//   The one way out: trigger the removal again; the restartGrace hook picks the job up by itself
//   (stacks/remove.js). A copy in `clearAway/earmarked` does NOT count: its instance row stays `ready`.
//   Guard: server/backend/test/stacks-clear-away.test.js.
import * as store from "../store.js";
import { MAIN, LABEL_PROJECT, STOP_DEADLINE_S, copyNameOf, networkFromSubnet } from "./creation.js";
import { projectboxOps, ONLY_IN_OPS } from "./ops.js";
import { docker, dockerIn, isFrozen, thawOut, waitForThaw } from "./docker.js";
import { CALL_CAP_MS, instanceOccupied, withInstanceOccupancy, projectOccupied, tickMs, waitForInside } from "./instance.js";
import { procedureAlive, setInstanceState, withProcedure } from "./instances.js";
import { containerOf } from "./run-instance.js";
import { bringAlongNames } from "./names.js";
import { networkSeparation } from "./network-marker.js";
import { DESIRED_RUNNING, withServicesOfNow, withoutSuperseded, desiredFromInspect } from "./serverEnd.js";
import { CONTAINER_STANDS } from "../runtime/git-run.js";
import { serverEnds } from "../runs/server-end.js";

export const STAGE_CAP_MS = 300_000;
// How often a container that is still untouched in the tick of a stage is started again on its own (runStages).
export const RESTART_GRACE_ATTEMPTS = 3;
// The stage cap (ms, integer > 0), read at run time — never when the module loads.
const wholeMs = (raw, preset) => {
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : preset;
};
export const stageCapMs = () => wholeMs(process.env.CBASE_PROJECT_STAGE_MS, STAGE_CAP_MS);

export class RestoreError extends Error {
  constructor(message, { code, status = 409 } = {}) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
    this.status = status;
  }
}

// ── A copy being removed (see header) ──────────────────────────────────────────────────────────────────────────────

/** The phase of an instance row in `error` whose copy ran again after its removal had begun — stacks/clearAway.js then
 *  fetches and backs up once more. One word (the phase is readable in `projectWork`). */
export const REVIVED = "revived";

/** The row in stack_copies when `instance` is a copy whose removal runs or failed; otherwise null (the main instance
 *  without a database read). Throws only for an invalid instance or a database that does not answer. */
export function copyInClearAway(projectId, instance = MAIN) {
  const name = copyNameOf(String(instance || MAIN));
  if (name === null) return null;
  const k = store.liveStackCopy(String(projectId ?? ""), name);
  if (!k) return null;
  return k.state === "error" || (k.state === "clearAway" && k.phase !== "earmarked") ? k : null;
}

/** One sentence (words and the reason of the row only) about the removal of this copy. */
export const clearAwayText = (k) => (k.state === "error"
  ? `its removal failed: ${String(k.error || "without a reason").split("\n")[0].slice(0, 400)}`
  : "it is being removed");

/** An instance row of a copy being removed that is NOT in `error` (revived) goes to `error` with the phase REVIVED; one
 *  in `error` stays as it is. Synchronous, no docker. Returns whether it was set. */
export function copyStaysBehind(z, clearing) {
  if (!z || z.state === "error") return false;
  setInstanceState(z.projectId, z.instance, "error", { phase: REVIVED, error: `copy brought up again after its removal had begun — ${clearAwayText(clearing)}; no restore, the next removal fetches and backs up once more first` });
  console.warn(`[projectbox] ${z.identifier}: copy stood "${z.state}" although ${clearAwayText(clearing)} — now error (${REVIVED}), no restore`);
  return true;
}

// ── Seams ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let nativeServicesStarter = null;
export function setNativeServicesStarter(fn) { nativeServicesStarter = typeof fn === "function" ? fn : null; }
let recreateRequest = null;
export function setRecreateRequest(fn) { recreateRequest = typeof fn === "function" ? fn : null; }
const readyCallbacks = [];
export function atReady(fn) {
  if (typeof fn !== "function") throw new TypeError("atReady: fn must be a function");
  readyCallbacks.push(fn);
  return () => { const i = readyCallbacks.indexOf(fn); if (i >= 0) readyCallbacks.splice(i, 1); };
}
function reportReady(row) {
  const list = [...readyCallbacks];
  if (!list.length) return;
  setImmediate(() => {
    for (const fn of list) {
      try {
        const r = fn({ projectId: row.projectId, instance: row.instance, row });
        if (r && typeof r.then === "function") r.then(null, (e) => console.error(`[projectbox] atReady ${row.identifier}: ${e?.message || e}`));
      } catch (e) { console.error(`[projectbox] atReady ${row.identifier}: ${e?.message || e}`); }
    }
  });
}
function questionRecreate(request) {
  const fn = recreateRequest;
  if (!fn) return;
  try {
    const r = fn(request);
    if (r && typeof r.then === "function") r.then(null, (e) => console.error(`[projectbox] recreate request ${request.projectId}: ${e?.message || e}`));
  } catch (e) { console.error(`[projectbox] recreate request ${request.projectId}: ${e?.message || e}`); }
}

// ── Clock seam of the stage caps ───────────────────────────────────────────────────────────────────────────────────

const runningCaps = new Set();
export function advanceStagesCap() {
  const now = [...runningCaps];
  for (const procedure of now) procedure();
  return now.length;
}
function stagesCap(ms) {
  const d = { expired: false, wakeup: null };
  let further = null;
  d.wait = (tick) => new Promise((r) => { further = r; d.t = setTimeout(() => { further = null; r(); }, tick); });
  const procedure = () => {
    if (d.expired) return;
    d.expired = true;
    runningCaps.delete(procedure);
    clearTimeout(d.wakeup);
    if (further) { clearTimeout(d.t); const w = further; further = null; w(); }
  };
  d.wakeup = setTimeout(procedure, ms);
  runningCaps.add(procedure);
  d.end = () => { clearTimeout(d.wakeup); clearTimeout(d.t); runningCaps.delete(procedure); };
  return d;
}

// ── The pure parts ─────────────────────────────────────────────────────────────────────────────────────────────────

const CONDITIONS = ["service_started", "service_healthy", "service_completed_successfully"];

export function dependsOnFrom(raw) {
  const notices = [];
  const deps = [];
  const condition = (b, service) => {
    const w = String(b ?? "").trim();
    if (!w) return "service_started";
    if (CONDITIONS.includes(w)) return w;
    notices.push(`depends_on: unknown condition "${w}" for "${service}" — counts as service_started`);
    return "service_started";
  };
  const text = String(raw ?? "").trim();
  if (!text) return { deps, notices };
  if (text.startsWith("{")) {
    let obj = null;
    try { obj = JSON.parse(text); } catch { /* reported below */ }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      notices.push(`depends_on not readable ("${text.slice(0, 80)}")`);
      return { deps, notices };
    }
    for (const [service, v] of Object.entries(obj)) {
      if (!service.trim()) continue;
      deps.push({ service: service.trim(), condition: condition(v?.condition, service.trim()), restart: v?.restart === true || v?.restart === "true" });
    }
    return { deps, notices };
  }
  for (const part of text.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const [service, b, restart] = t.split(":").map((x) => x.trim());
    if (!service) { notices.push(`depends_on: part without a service ("${t}") skipped`); continue; }
    deps.push({ service, condition: condition(b, service), restart: restart === "true" });
  }
  return { deps, notices };
}

const key = (project, service) => `${project}\u0000${service}`;
const nameOf = (c) => c.name || String(c.id || "").slice(0, 12) || "?";

export function startStages(container) {
  const list = (Array.isArray(container) ? container : []).map((c) => ({ ...c, finishedRequired: false }));
  const notices = [];
  const services = new Map(); // (project, service) → containers
  for (const c of list) {
    if (!c.service) continue;
    const k = key(c.project || "", c.service);
    if (!services.has(k)) services.set(k, []);
    services.get(k).push(c);
  }
  const edges = new Map(); // container → [containers it depends on]
  const unknown = new Set();
  for (const c of list) {
    const { deps, notices: m } = dependsOnFrom(c.dependsOn);
    for (const x of m) notices.push(`${nameOf(c)}: ${x}`);
    const from = [];
    for (const d of deps) {
      const targets = services.get(key(c.project || "", d.service));
      if (!targets?.length) {
        unknown.add(c);
        notices.push(`${nameOf(c)}: depends on unknown service "${d.service}" — last stage`);
        continue;
      }
      for (const z of targets) {
        if (z === c) continue; // a service with several containers does not depend on itself
        from.push(z);
        if (d.condition === "service_completed_successfully") z.finishedRequired = true;
      }
    }
    edges.set(c, from);
  }
  // Stage = 1 + highest stage of the dependencies; only what resolves completely is resolved (Kahn).
  const stageOf = new Map();
  let progress = true;
  while (progress) {
    progress = false;
    for (const c of list) {
      if (stageOf.has(c) || unknown.has(c)) continue;
      const from = edges.get(c);
      if (!from.every((z) => stageOf.has(z))) continue;
      stageOf.set(c, from.length ? 1 + Math.max(...from.map((z) => stageOf.get(z))) : 0);
      progress = true;
    }
  }
  const rest = list.filter((c) => !stageOf.has(c));
  // Name the cycles among the rest: whoever reaches itself.
  const reached = (start) => {
    const seen = new Set();
    const stack = [...(edges.get(start) || [])];
    while (stack.length) {
      const x = stack.pop();
      if (x === start) return true;
      if (seen.has(x) || stageOf.has(x)) continue;
      seen.add(x);
      stack.push(...(edges.get(x) || []));
    }
    return false;
  };
  const inCycle = rest.filter((c) => !unknown.has(c) && reached(c));
  if (inCycle.length) notices.push(`cycle in depends_on: ${inCycle.map(nameOf).sort().join(", ")} — last stage`);
  for (const c of rest) {
    if (unknown.has(c) || inCycle.includes(c)) continue;
    notices.push(`${nameOf(c)}: depends on a service of the last stage (cycle or unknown) — last stage`);
  }
  const count = stageOf.size ? Math.max(...stageOf.values()) + 1 : 0;
  const stages = Array.from({ length: count }, () => []);
  for (const c of list) if (stageOf.has(c)) stages[stageOf.get(c)].push(c);
  if (rest.length) stages.push(rest);
  for (const s of stages) s.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return { stages, notices };
}

export function targetReached(inspect, target) {
  const st = inspect?.State || {};
  const status = String(st.Status || "");
  const exit = Number.isInteger(st.ExitCode) ? st.ExitCode : null;
  const ended = status === "exited" || status === "dead";
  if (target === "finished") {
    if (ended) return exit === 0 ? { outcome: "yes" } : { outcome: "failed", reason: `ended with exit ${exit ?? "?"}` };
    return { outcome: "no" };
  }
  if (ended) return { outcome: "failed", reason: `ended (exit ${exit ?? "?"})` };
  if (target === "healthy") {
    const h = String(st.Health?.Status || "");
    if (h === "healthy") return { outcome: "yes" };
    if (h === "unhealthy") return { outcome: "failed", reason: "unhealthy" };
    return { outcome: "no" };
  }
  return status === "running" ? { outcome: "yes" } : { outcome: "no" };
}

export function desiredAfterRestore(oldDesired, inspect, { time = Date.now(), notArrived = [] } = {}) {
  const fresh = desiredFromInspect(inspect, { services: oldDesired?.services || [], time });
  const missing = new Set(notArrived.map(String).filter(Boolean));
  const should = new Set();
  for (const c of oldDesired?.container || []) {
    if (!DESIRED_RUNNING.has(c.state) || !(missing.has(c.id) || missing.has(c.name))) continue;
    if (c.id) should.add(c.id);
    if (c.name) should.add(c.name);
  }
  for (const c of fresh.container) {
    if (!DESIRED_RUNNING.has(c.state) && (should.has(c.id) || should.has(c.name))) { c.state = "running"; c.failed = true; }
  }
  return fresh;
}

// ── The procedure ──────────────────────────────────────────────────────────────────────────────────────────────────

const isMissing = (e) => /No such (object|container)|not found/i.test(`${e?.stderr || ""}\n${e?.message || ""}`);
const idsFrom = (text) => String(text || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);

// A failure with a reason that serves as the error text of the row. Exported for the callers of runInstanceUp
// (relocation, copy): they decide themselves what "the project container stands" means for THEIR row.
export class InstanceFailed extends Error {
  constructor(message, { recreate = false, newAttempt = false } = {}) { super(message); this.name = "InstanceFailed"; this.recreate = recreate; this.newAttempt = newAttempt; }
}

// THE LIFE OF THE PROJECT CONTAINER. If it restarts behind cbase's back during the start sequence (crash, OOM, the
// daemon starts it), its inside is a FRESH dockerd: what is then read as a snapshot is the crash, not the intent — and a
// `ready` would hide the restart from the observer. Therefore: livenessRemember on entering runStartSequence (id and
// State.StartedAt), checkLiveness IMMEDIATELY before writing `ready` with the desired state (after reading the inside).
// If the life differs, it throws InstanceFailed (`newAttempt`): no snapshot, the old desired state stays. The restore
// then runs through once more; relocation and copy decide for themselves. Without a readable life on entry (null)
// there is nothing to check.
const alive = (c) => ["running", "paused"].includes(String(c?.State?.Status || ""));
async function containerLiveness(containerId) {
  const c = JSON.parse((await docker(["inspect", "--type", "container", containerId], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null;
  return c ? { id: String(c.Id || ""), startedAt: String(c.State?.StartedAt || ""), alive: alive(c) } : null;
}
export async function livenessRemember(containerId) {
  try { const l = await containerLiveness(containerId); return l?.alive ? l : null; } catch { return null; }
}
// THE CONFIRMED LIVES (container id → State.StartedAt). checkLiveness records the life it found unchanged — the start
// sequence saw its inside, and the desired state from it is the intent. An unmarked `die` the observer noted during the
// procedure lay BEFORE this life: resumption.js therefore does not treat a container running in a confirmed life as
// silently restarted — otherwise the next tick would restore an instance a second time. Capped (the oldest falls).
const CONFIRMED_CAP = 1000;
const confirmed = new Map();
export function livenessConfirmed(id, startedAt) {
  return Boolean(id) && Boolean(startedAt) && confirmed.get(String(id)) === String(startedAt);
}
export async function checkLiveness(containerId, liveness) {
  if (!liveness) return;
  let now;
  try { now = await containerLiveness(containerId); }
  catch (e) { throw new InstanceFailed(`the project container ${String(containerId).slice(0, 12)} is not readable (${e?.message || e}) — no snapshot`, { newAttempt: true }); }
  if (!now?.alive || now.id !== liveness.id || now.startedAt !== liveness.startedAt) {
    throw new InstanceFailed(`the project container ${String(containerId).slice(0, 12)} restarted or stood still during the start sequence — its inside is the crash, not the intent (no snapshot)`, { newAttempt: true });
  }
  if (now.id && now.startedAt) {
    confirmed.delete(now.id);
    confirmed.set(now.id, now.startedAt);
    if (confirmed.size > CONFIRMED_CAP) confirmed.delete(confirmed.keys().next().value);
  }
}

// Exported for the start of a copy (stacks/start.js: the desired state after coming up, as in the step "ready" here).
export async function insideInspect(container) {
  const ids = idsFrom((await dockerIn(container, ["ps", "-aq", "--no-trunc"], { capMs: CALL_CAP_MS })).stdout);
  if (!ids.length) return [];
  return JSON.parse((await dockerIn(container, ["inspect", ...ids], { capMs: CALL_CAP_MS })).stdout || "[]");
}

/** Run the stages (header, step "stage n/m"). `findings` collects the failed services `{ id, name, reason }` in place.
 *  `set(fields)` writes phase and finding text (runInstanceUp: into the working state of the row; the layout: nothing
 *  on the row, it stays `ready`). */
async function runStages(inst, set, container, desired, findings) {
  const desiredList = Array.isArray(desired?.container) ? desired.container : [];
  if (!desiredList.length) return { notices: [] };
  const existing = await insideInspect(container);
  const viewAfter = new Map(); // Id → inspect
  for (const c of existing) viewAfter.set(String(c.Id || ""), c);
  const forms = desiredFromInspect(existing).container;
  const byId = new Map(forms.map((c) => [c.id, c]));
  const byName = new Map(forms.map((c) => [c.name, c]));
  const selection = [];
  const taken = new Set();
  for (const s of desiredList) {
    const exists = (s.id && byId.get(s.id)) || (s.name && byName.get(s.name));
    if (!exists || taken.has(exists.id)) continue; // desired ∩ existing: what no longer exists, nobody starts
    taken.add(exists.id);
    selection.push({ ...exists, desiredState: s.state });
  }
  const { stages, notices } = startStages(selection);
  if (notices.length) console.warn(`[projectbox] restore ${inst.identifier}: ${notices.join("; ")}`);
  const tick = tickMs();
  for (let k = 0; k < stages.length; k++) {
    const active = stages[k].filter((c) => DESIRED_RUNNING.has(c.desiredState));
    if (!active.length) continue;
    set({ phase: `stage ${k + 1}/${stages.length}`, error: findingText(findings) });
    const toStart = active.filter((c) => viewAfter.get(c.id)?.State?.Status !== "running");
    // If the project container itself stands, no `exec` answers any more — `error` at once instead of waiting for the cap.
    const throwIfContainerStands = (e) => {
      if (CONTAINER_STANDS.test(`${e?.stderr || ""}\n${e?.message || ""}`)) {
        throw new InstanceFailed(`the project container stands (stage ${k + 1}/${stages.length}): ${String(e?.stderr || e?.message || "").trim().split("\n")[0]}`);
      }
    };
    if (toStart.length) {
      try { await dockerIn(container, ["start", ...toStart.map((c) => c.id)], { capMs: CALL_CAP_MS }); }
      catch (e) { throwIfContainerStands(e); console.warn(`[projectbox] restore ${inst.identifier}: start (stage ${k + 1}) reported ${e.message}`); }
    }
    const open = new Map(active.map((c) => [c.id, c]));
    const cap = stagesCap(stageCapMs());
    let warned = false; // ONE warning per stage (one per tick would be thousands until the cap)
    // Starting again: if the cap of the `start` above cuts it off, the rest of the list stays as it was — `exited` from
    // the stop chain or `created` — and would be counted as failed at once (exited) or awaited until the stage cap
    // (created), but never started. A container that is not running and whose StartedAt is still the one from BEFORE the
    // start of the stage (`viewAfter`; no clock — a comparison with "now" would take a container that ran shortly before
    // for already started) is UNTOUCHED: it is started again on its own instead of judged, at most
    // RESTART_GRACE_ATTEMPTS times per stage, then judged as usual.
    const attempts = new Map();
    let startWarned = false;
    try {
      while (open.size && !cap.expired) {
        let view = [];
        try {
          view = JSON.parse((await dockerIn(container, ["inspect", ...open.keys()], { capMs: CALL_CAP_MS })).stdout || "[]");
        } catch (e) {
          throwIfContainerStands(e);
          // A missing container (removed meanwhile) is no longer in the output; everything else: next tick.
          if (!isMissing(e) && !warned) {
            warned = true;
            console.warn(`[projectbox] restore ${inst.identifier}: inspect (stage ${k + 1}) ${e.message} — continuing in the tick until the stage cap (only this one warning)`);
          }
          try { view = JSON.parse(e.stdout || "[]"); } catch { view = []; }
        }
        const seen = new Set();
        const startAfterwards = [];
        for (const s of view) {
          const c = open.get(String(s.Id || ""));
          if (!c) continue;
          seen.add(c.id);
          const st = s.State || {};
          const untouched = st.Status !== "running" && st.Status !== "restarting" && String(st.StartedAt || "") === String(viewAfter.get(c.id)?.State?.StartedAt || "");
          if (untouched && (attempts.get(c.id) || 0) < RESTART_GRACE_ATTEMPTS) { startAfterwards.push(c.id); continue; }
          const target = c.finishedRequired ? "finished" : s.State?.Health ? "healthy" : "running";
          const r = targetReached(s, target);
          if (r.outcome === "yes") open.delete(c.id);
          else if (r.outcome === "failed") { open.delete(c.id); findings.push({ id: c.id, name: nameOf(c), reason: r.reason }); }
        }
        if (view.length) {
          for (const c of [...open.values()]) {
            if (!seen.has(c.id)) { open.delete(c.id); findings.push({ id: c.id, name: nameOf(c), reason: "disappeared" }); }
          }
        }
        for (const id of startAfterwards) {
          if (!open.has(id)) continue;
          attempts.set(id, (attempts.get(id) || 0) + 1);
          try { await dockerIn(container, ["start", id], { capMs: CALL_CAP_MS }); } catch (e) {
            throwIfContainerStands(e);
            if (!startWarned) {
              startWarned = true;
              console.warn(`[projectbox] restore ${inst.identifier}: starting again (stage ${k + 1}) ${nameOf(open.get(id))}: ${e.message} (only this one warning)`);
            }
          }
        }
        if (open.size && !cap.expired) await cap.wait(tick);
      }
    } finally { cap.end(); }
    for (const c of open.values()) {
      findings.push({ id: c.id, name: nameOf(c), reason: `not arrived — stage cap of ${stageCapMs()} ms hit` });
    }
    if (findings.length) set({ error: findingText(findings) });
  }
  return { notices };
}

// A reason without paths: a throw from the starter can name the working folder, and the finding is readable in the event.
const withoutPaths = (x) => String(x ?? "").replace(/(^|[\s(„"'=:])\/[^\s)“"',;]+/g, "$1…").trim();

const findingText = (findings) => (findings.length
  ? `service(s) failed: ${findings.map((b) => `${b.name} (${b.reason})`).join(", ")}`
  : "");

// The ids of the native services from `desired.services`. services.js writes NUMBERS (the ids of the service rows);
// accepted are number, string, `{ id }`/`{ svcId }` — a reader that only knew strings would silently drop every number.
function desiredServiceIds(desired) {
  return (Array.isArray(desired?.services) ? desired.services : [])
    .map((d) => (typeof d === "string" || typeof d === "number" ? d : d?.id ?? d?.svcId ?? ""))
    .map(String).filter(Boolean);
}

// ── The start sequence of an instance ──────────────────────────────────────────────────────────────────────────────
// runInstanceUp(pid, inst, { containerId, desired, state }) → { findings, notices, liveness }. The project container
// `containerId` RUNS and its dockerd answers (the caller checked that — here: steps marker, container, wait); then in
// this order: stages (desired ∩ existing in `depends_on` order, cap per stage), services (the native ones from
// `desired.services`, FRESH from the row), names (/etc/hosts). Restore, relocation and copy all call this — otherwise
// there would be a second and a third start sequence.
// THE PROMISE. It only sets PHASES in the given state (with the finding text of the failed services in the `error` field
// of the row), never `ready` or `error` as a state: `state` must be a working one (store PROJECT_WORK_STATES), and the
// row must already be in it on entry — otherwise it throws without setting anything. So it does not wake (the setter
// only wakes on a change into a non-working state, instances.js) and occupies nothing (no project occupancy, no
// `withProcedure` — the caller holds both if it needs them). The caller writes the transition afterwards (`ready` with
// snapshot, or `error`). Throws `InstanceFailed` when the project container stands or the inner containers are not
// readable; the caller decides what that means. Guard: server/backend/test/projectbox-start-up.test.js.
export async function runInstanceUp(pid, inst, { containerId, desired, state } = {}) {
  if (!store.PROJECT_WORK_STATES.includes(state)) {
    throw new TypeError(`runInstanceUp: state "${state}" is not a working one (${store.PROJECT_WORK_STATES.join(", ")}) — no transition happens here`);
  }
  const now = store.projectInstance(pid, inst?.instance || MAIN);
  if (!now || now.state !== state) {
    throw new InstanceFailed(`runInstanceUp: the row ${inst?.identifier || pid} ${now ? `is in "${now.state}"` : "does not exist"}, not in "${state}" — no transition happens here`);
  }
  return runStartSequence(pid, inst, { containerId, desired, set: (f) => setInstanceState(pid, inst.instance, state, f) });
}

// ── The start sequence without a state ─────────────────────────────────────────────────────────────────────────────
// runStartSequence(pid, inst, { containerId, desired, set, starter }) → { findings, notices, liveness } — the middle
// part of runInstanceUp (stages, services, names) without the state check: `set(fields)` writes phase and finding text
// wherever the caller wants. runInstanceUp sets the working state of the row with it (the promise above); the layout
// (layout/procedure.js, step `runUp` and the return path) runs the start sequence on a row in `ready` — its lock holds
// the starts, and a state change would wake the waiting ones in the middle of the rebuild. `starter` (default: the
// connected native services starter): the layout passes its test seam through. Throws like runInstanceUp.
export async function runStartSequence(pid, inst, { containerId, desired, set, starter = nativeServicesStarter } = {}) {
  if (typeof set !== "function") throw new TypeError("runStartSequence: set is required");
  const liveness = await livenessRemember(containerId);
  const findings = [];
  // Every phase carries the finding of the failed services along (a state other than `error` without an `error` field
  // would make the setter clear the error text).
  const phase = (p) => set({ phase: p, error: findingText(findings) });

  // stages
  try { await runStages(inst, set, containerId, desired, findings); }
  catch (e) {
    if (e instanceof InstanceFailed) throw e; // the project container stands — its own reason
    throw new InstanceFailed(`inner containers not readable: ${e.message}`);
  }

  // services — the list fresh from the row, the starter's result in the finding.
  phase("services");
  const ids = desiredServiceIds(store.projectInstance(pid, inst.instance)?.desired ?? desired);
  const notices = [];
  if (ids.length) {
    if (starter) {
      try {
        const r = await starter(pid, ids, { instance: inst.instance || MAIN }); // in THIS instance
        // The prefixes "native service <id>:" and "native services:" are a contract: stacks/start.js recognises them.
        for (const f of Array.isArray(r?.error) ? r.error : []) notices.push(`native service ${f?.id ?? "?"}: ${withoutPaths(f?.reason) || "failed"}`);
      } catch (e) { notices.push(`native services: ${withoutPaths(e?.message || e)}`); }
    } else notices.push(`native services not started (no starter attached): ${ids.join(", ")}`);
  }

  // names
  phase("names");
  try { bringAlongNames(); } catch (x) { console.warn(`[projectbox] restore ${inst.identifier}: names not brought along: ${x?.message || x}`); }
  return { findings, notices, liveness };
}

const NEW_ATTEMPTS = 1; // how often the restore runs through once more after a crash in the middle of the start sequence

// In an ENDING server (runs/server-end.js serverEnds — its own marker or the gateway's) the restore does not run a
// second time and neither starts nor thaws a project container. The stop chain (serverEnd.js, or the gateway's exec
// script) is halting it right now; a second pass would start it again, and with B it would then die hard together with
// the inner dockerd and the stack. The row ends in `error` (visible, holds no `busy`); earmarkRestore of the next
// process takes it like any other.
const SERVER_ENDS_TEXT = "the server is ending — no start of a project container, the stop chain would no longer see it";

async function procedure(pid, inst, opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await procedureAttempt(pid, inst, opts); }
    catch (e) {
      if (e instanceof InstanceFailed && e.newAttempt && attempt < NEW_ATTEMPTS && store.projectInstance(pid, inst.instance)) {
        if (serverEnds()) return procedureFail(pid, inst, opts, new InstanceFailed(`${e.message}; no second pass: ${SERVER_ENDS_TEXT}`));
        console.warn(`[projectbox] restore ${inst.identifier}: ${e.message} — the row runs through the procedure once more`);
        continue;
      }
      return procedureFail(pid, inst, opts, e);
    }
  }
}

async function procedureAttempt(pid, inst, { state, root, after }) {
  // Before the stages there is no finding: every phase here clears the error text.
  const phase = (p) => setInstanceState(pid, inst.instance, state, { phase: p, error: "" });
  // marker — without it no docker call.
  phase("marker");
  const marker = networkSeparation({ root });
  if (!marker.valid) throw new InstanceFailed(`network separation is missing (marker ${marker.reason}) — without it no project container starts`);

  // container
  phase("container");
  const name = containerOf(inst);
  let c;
  try { c = JSON.parse((await docker(["inspect", "--type", "container", name], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) {
    if (!isMissing(e)) throw new InstanceFailed(`inspect ${name}: ${e.message}`);
    c = null;
  }
  // A missing container ("No such container") is a case for the recreate (same volume, same IP, same stack) — not just
  // `error`. Every other docker error above stays `error` without a request.
  if (!c) throw new InstanceFailed(`the project container ${name} is missing`, { recreate: true });
  if (c.Config?.Labels?.[LABEL_PROJECT] !== pid) throw new InstanceFailed(`${name} does not carry the label of this project (${LABEL_PROJECT}=${c.Config?.Labels?.[LABEL_PROJECT] ?? "—"})`);
  const id = String(c.Id);
  // THE BRIDGE NAME (hard cut, creation.js BRIDGE_PREFIX). entry.sh of this release guards only the bridges `cbp-+`; a
  // container that an older release created sits on a bridge with the old name — every port of it open to B and the neighbouring
  // projects. It must not keep running a moment longer: stopped HERE (also a paused one, thawed first), never started, and the row
  // goes `error` with the recreate request — the recreate (next idle; same volume, same IP, same stack from `desired`) removes it, and
  // instance.js networkFor recreates its network with the derived bridge. Here because every converted container passes the restore
  // after the deploy that brings the new prefix (earmarkRestore takes every converted row in ready/error/start; a `stopped` one is
  // not running and passes here when it is started). Not in recreate.js desiredActual: that check runs only at turn start and after
  // `ready` — the container would run unprotected until then.
  const stale = await namingDeviation(c, inst);
  if (stale) {
    if (c.State?.Paused || c.State?.Status === "running") {
      try {
        if (c.State?.Paused) await thawOut(id);
        await docker(["stop", "-t", String(STOP_DEADLINE_S), id]);
      } catch (e) { throw new InstanceFailed(`${stale}; stopping ${id.slice(0, 12)} failed: ${e.message}`, { recreate: true }); }
    }
    throw new InstanceFailed(`${stale} — stopped, recreated in the next idle`, { recreate: true });
  }
  // A PAUSED container is thawed, never started (`docker start` rejects it). If cbase holds the pause itself (the frozen
  // set in docker.js), its procedure thaws — the restore waits for that (cap with a message) instead of thawing the
  // container under its hands. After a restart of B the set is empty: then the restartGrace hook "project-thaw" thaws
  // (before this hook), and what it misses is thawed here.
  // In an ending server neither `start` nor `unpause` — asked immediately before.
  const ownHoldPause = c.State?.Paused && (isFrozen(name) || isFrozen(id));
  if ((c.State?.Paused || c.State?.Status !== "running") && !ownHoldPause && serverEnds()) throw new InstanceFailed(SERVER_ENDS_TEXT);
  if (c.State?.Paused) {
    try {
      if (ownHoldPause) await waitForThaw(name, "the restore");
      else await thawOut(id);
    } catch (e) { throw new InstanceFailed(`paused project container ${id.slice(0, 12)}: ${e.message}`); }
  } else if (c.State?.Status !== "running") {
    try { await docker(["start", id]); } catch (e) { throw new InstanceFailed(`docker start ${id.slice(0, 12)}: ${e.message}`); }
  }

  // wait — docker info and the status file of the entrypoint.
  phase("wait");
  let status;
  try { ({ status } = await waitForInside(id)); } catch (e) { throw new InstanceFailed(e.message); }
  if (status.phase === "error") {
    throw new InstanceFailed(`the entrypoint reports phase=error: ${status.notice || "—"}`, { recreate: true });
  }
  if (status.phase !== "ready") throw new InstanceFailed(`the entrypoint reports phase=${status.phase}: ${status.notice || "—"}`);

  // stages, services, names — the start sequence (runInstanceUp: the same one for relocation and copy).
  const desired = store.projectInstance(pid, inst.instance)?.desired ?? inst.desired ?? null;
  const { findings, notices, liveness } = await runInstanceUp(pid, inst, { containerId: id, desired, state });

  // ready — with a new snapshot (header).
  let newDesired;
  // Ids AND names: a desired container the stages found by its name has a new id.
  try { newDesired = desiredAfterRestore(desired, withoutSuperseded(pid, await insideInspect(id)), { notArrived: findings.flatMap((b) => [b.id, b.name]) }); }
  catch (e) { newDesired = undefined; console.warn(`[projectbox] restore ${inst.identifier}: snapshot not written, the last one holds (${e.message})`); }
  await checkLiveness(id, liveness); // no writing of `ready` and the desired state from a restarted life
  const finding = [findingText(findings), ...notices].filter(Boolean).join("; ");
  // `services` fresh from the row, synchronously right before the write.
  const row = setInstanceState(pid, inst.instance, "ready", { phase: "", error: finding, containerId: id, ...(newDesired ? { desired: withServicesOfNow(pid, inst.instance, newDesired) } : {}) });
  console.log(`[projectbox] restore ${inst.identifier}: ready${finding ? ` — ${finding}` : ""}`);
  after.push(() => reportReady(row));
  return row;
}

// Hostname or bridge of the project container NOT the derived ones of its row (`cbp-<n>`, n = third octet of the row's subnet) →
// the sentence, else "". The hostname comes with the inspect; the bridge costs ONE `network inspect` of the row's network and is only
// asked when the hostname is right (creation derives both from the same /24 in one step — a container of an older release already
// fails at the hostname). A row without a subnet (only test rows: the creation always writes it) gives no verdict. A network that
// cannot be read gives none either: the start that follows reports it.
async function namingDeviation(c, row) {
  if (!row?.subnet) return "";
  let want;
  try { want = networkFromSubnet(row.subnet); } catch { return ""; }
  const hostname = String(c.Config?.Hostname ?? "");
  if (hostname !== want.hostname) return `the project container carries the hostname “${hostname || "—"}” instead of ${want.hostname} (an older release)`;
  if (!row.network || !c.NetworkSettings?.Networks?.[row.network]) return "";
  let n;
  try { n = JSON.parse((await docker(["network", "inspect", row.network], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) { console.warn(`[projectbox] restore ${row.identifier}: bridge of ${row.network} not readable (${e.message})`); return ""; }
  const bridge = String(n?.Options?.["com.docker.network.bridge.name"] ?? "");
  return n && bridge !== want.bridge ? `the project network carries the bridge “${bridge || "—"}” instead of ${want.bridge} (an older release)` : "";
}

function procedureFail(pid, inst, { after }, e) {
  const reason = e instanceof InstanceFailed ? e.message : `restore: ${e?.message || e}`;
  console.error(`[projectbox] restore ${inst.identifier} failed: ${reason}`);
  // A row deleted meanwhile is not created anew here (the setter would otherwise create it).
  if (!store.projectInstance(pid, inst.instance)) return null;
  const row = setInstanceState(pid, inst.instance, "error", { error: reason });
  if (e instanceof InstanceFailed && e.recreate) after.push(() => questionRecreate({ projectId: pid, instance: inst.instance, reason }));
  return row;
}

const STATES_OF_THE_PROCEDURE = ["start", "recreate"];

export function restoreInstance(projectId, instance = MAIN, { reason = "", state = "start", root, occupancyHeld = false, fromStopped = false } = {}) {
  const pid = String(projectId ?? "");
  const inst0 = String(instance || MAIN);
  if (!STATES_OF_THE_PROCEDURE.includes(state)) return Promise.reject(new TypeError(`restoreInstance: state "${state}" is not one of the restore (${STATES_OF_THE_PROCEDURE.join(", ")})`));
  if (!projectboxOps()) return Promise.reject(new RestoreError(ONLY_IN_OPS, { code: "NO_OPS", status: 404 }));
  const inst = store.projectInstance(pid, inst0);
  if (!inst?.convertedAt) return Promise.reject(new RestoreError(`project ${pid} has no converted instance "${inst0}"`, { code: "NO_INSTANCE", status: 404 }));
  // A stopped instance only starts for whoever explicitly wants it (header "STOPPED").
  if (inst.state === "stopped" && !fromStopped) {
    return Promise.reject(new RestoreError(`the instance ${inst.identifier} is stopped — it only starts through "Start" or a turn, the row stays as it is`, { code: "STOPPED", status: 409 }));
  }
  // A copy whose removal runs or failed is brought up by no path — the row stays as it is. Not readable ⇒ rejected as
  // well (closed: better no restore than a copy working past the backup).
  let clearing;
  try { clearing = copyInClearAway(pid, inst0); }
  catch (e) { return Promise.reject(new RestoreError(`the copy ${inst.identifier}: the state of its removal is not readable (${e?.message || e}) — no restore, the row stays as it is`, { code: "COPY_CLEAR_AWAY", status: 409 })); }
  if (clearing) {
    return Promise.reject(new RestoreError(`the copy ${inst.identifier} does not come back up: ${clearAwayText(clearing)} — it belongs to the removal (trigger it again), the row stays as it is`, { code: "COPY_CLEAR_AWAY", status: 409 }));
  }
  // No path starts a frozen container — the pause belongs to a procedure that thaws itself. Every caller gets FROZEN
  // without the row being touched (like OCCUPIED).
  if (isFrozen(containerOf(inst))) {
    return Promise.reject(new RestoreError(`the project container of ${pid} is frozen right now — no restore, the row stays as it is`, { code: "FROZEN", status: 409 }));
  }
  const w = root ?? process.env.CBASE_NETWORK_ROOT ?? "";
  // OCCUPIED BEFORE any write — otherwise the row would stand in `start` without a living procedure (header). With a held
  // occupancy the caller holds occupancy and procedure itself. The occupancy is that of the INSTANCE — main and copy of
  // the same project come up side by side; a project occupancy (creation, deletion, relocation, building a copy)
  // excludes them.
  if (!occupancyHeld) {
    const occupied = projectOccupied(pid) || instanceOccupied(pid, inst0);
    if (occupied || procedureAlive(pid, inst0)) {
      return Promise.reject(new RestoreError(`for project ${pid} ${occupied ? `a procedure ("${occupied}")` : "a procedure of the instance"} is already running — the row stays as it is`, { code: "OCCUPIED", status: 409 }));
    }
  }
  // Synchronous up to here (the row in the state, the procedure entered) — the restartGrace hook relies on it: there is
  // no await between the check above and the occupancy below, withInstanceOccupancy occupies synchronously.
  if (inst.state !== state) setInstanceState(pid, inst0, state, { phase: "waiting" });
  if (reason) console.log(`[projectbox] restore ${inst.identifier} (${reason})`);
  // Recreate request and atReady callbacks only AFTER the procedure: the occupancy "restore" and `withProcedure` are
  // free by then — the recreate works under its own occupancy, a callback may occupy the project itself.
  const after = [];
  const run = () => withProcedure(pid, inst0, () => procedure(pid, inst, { state, root: w, after }));
  const p = occupancyHeld ? run() : withInstanceOccupancy(pid, inst0, "restore", run);
  return p.then((r) => { for (const fn of after) fn(); return r; });
}

// ── The window before the restartGrace hook ────────────────────────────────────────────────────────────────────────
// The hook only fires some time AFTER the listen. Until then a converted row would say `ready` although its project
// container is stopped after a restart of B — a message in that window would go to a stopped container. So startServer
// sets every converted row in `ready`, `error` or `start` to `start` (phase "waiting") BEFORE the listen: from then on
// the lock holds every turn and workflow agent of the project, and they run at the transition to `ready`. Synchronous,
// no docker. Without the ops marker nothing, not even a database read; rows without `convertedAt` stay. Returns the count.
export function earmarkRestore() {
  if (!projectboxOps()) return 0;
  let rows = [];
  try { rows = store.projectInstancesInState(["ready", "error", "start"]).filter((z) => z.convertedAt); }
  catch (e) { console.error(`[projectbox] start: instances not readable — nothing earmarked (${e?.message || e})`); return 0; }
  let n = 0;
  for (const z of rows) {
    try {
      // A copy being removed stays `error` with its reason; a revived one (`ready`/`start`) becomes `error` with the phase
      // REVIVED (header). Not readable ⇒ as usual (the procedure reads once more and then rejects).
      let clearing = null;
      try { clearing = copyInClearAway(z.projectId, z.instance); } catch { clearing = null; }
      if (clearing) { copyStaysBehind(z, clearing); continue; }
      setInstanceState(z.projectId, z.instance, "start", { phase: "waiting" });
      n += 1;
    } catch (e) { console.error(`[projectbox] start ${z.identifier}: not set to start (${e?.message || e})`); }
  }
  if (n) console.log(`[projectbox] start: ${n} converted instance(s) set to start — the restore follows in the restartGrace hook`);
  return n;
}

// The seam of the recreate into the restartGrace hook (set in server.js): `{ resume, check }`.
//   resume({ projectId, instance, reason })  a row a crash left in the middle of a RECREATE is resumed as a recreate — the
//       function must enter its procedure SYNCHRONOUSLY (withProcedure), otherwise "project-instances" (later in the
//       same chain) sets it to `error`. Without the seam: exactly that.
//   check({ projectId, instance, row })      after every restore of the hook that ended `ready`: the check point of the
//       recreate (image and mounts against the desired state — the deploy loads the new image before the swap). Its
//       promise belongs to the promise of the hook: the quiet of the server waits for it.
let recreateSeam = null;
export function setRecreateRestartGrace(seam) { recreateSeam = seam && typeof seam === "object" ? seam : null; }

export function restoreRestartGrace() {
  if (!projectboxOps()) return undefined;
  let rows = [];
  // The rows in `start` — earmarkRestore() put them there before the listen, or a crash in the middle of a restore left
  // them there (no procedure lives at start). A row whose procedure LIVES (the git view may have triggered it in the
  // window) belongs to it. Plus orphaned `recreate` rows (seam above).
  try { rows = store.projectInstancesInState(["start", "recreate"]).filter((z) => z.convertedAt && !procedureAlive(z.projectId, z.instance)); }
  catch (e) { console.error(`[projectbox] restart grace: instances not readable — no restore (${e?.message || e})`); return undefined; }
  const procedures = [];
  for (const z of rows) {
    if (z.state === "recreate") {
      const fn = recreateSeam?.resume;
      if (typeof fn !== "function") { console.warn(`[projectbox] restart grace ${z.identifier}: orphaned recreate without a seam — "project-instances" sets it to error`); continue; }
      try {
        const r = fn({ projectId: z.projectId, instance: z.instance, reason: "restart grace: resume recreate" });
        if (r && typeof r.then === "function") procedures.push(r.then(null, (e) => { console.error(`[projectbox] restart grace ${z.identifier}: recreate ${e?.message || e}`); return null; }));
      } catch (e) { console.error(`[projectbox] restart grace ${z.identifier}: recreate ${e?.message || e}`); }
      continue;
    }
    procedures.push(restoreInstance(z.projectId, z.instance, { reason: "restart grace" }).then((row) => {
      const check = recreateSeam?.check;
      if (row?.state !== "ready" || typeof check !== "function") return row;
      return Promise.resolve().then(() => check({ projectId: z.projectId, instance: z.instance, row }))
        .then(() => row, (e) => { console.error(`[projectbox] restart grace ${z.identifier}: check of the recreate ${e?.message || e}`); return row; });
    }, (e) => {
      console.error(`[projectbox] restart grace ${z.identifier}: ${e?.message || e}`);
      // A procedure that never began (OCCUPIED, row gone): do not leave the row in `start`. A copy being removed
      // (COPY_CLEAR_AWAY) goes to `error` with the phase REVIVED — `start` means it was not in `error` before.
      try {
        const now = store.projectInstance(z.projectId, z.instance);
        if (now?.state === "start" && !procedureAlive(z.projectId, z.instance)) {
          const clearing = e?.code === "COPY_CLEAR_AWAY" ? copyInClearAway(z.projectId, z.instance) : null;
          if (clearing) copyStaysBehind(now, clearing);
          else setInstanceState(z.projectId, z.instance, "error", { error: `restore not begun: ${e?.message || e}` });
        }
      } catch (x) { console.error(`[projectbox] restart grace ${z.identifier}: ${x?.message || x}`); }
      return null;
    }));
  }
  return Promise.all(procedures);
}
