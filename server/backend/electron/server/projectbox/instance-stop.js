// Stopping and starting an instance. Measurement basis: a stop that bypasses cbase does not hold for a second — the observer
// projectbox/resumption.js brings the container back after 0.6–0.8 s.
//
// THE STATES (store/project-instances.js): `ready → stop → stopped` (stopping), `stopped → start → ready` (starting, through
// restore.js — the same start sequence as the post-start), every failure `error`. `stop` works (holds `busy`, deploy and reaper
// wait), `stopped` is rest. Every change goes through the setter (instances.js setInstanceState) and thus as event
// `project/instance` to the global stream.
//
// instanceStop(inst) → { row, finished }   (POST …/instances/:instance/stop; main included)
//   First the checks of every writing action (checkAction: ready, no explicit lock, no occupation, the work lock instanceWork —
//   409 INSTANCE_WORKING with the chats), then SYNCHRONOUSLY instance occupation "stop", procedure (withProcedure) and state `stop`
//   (phase "desired") — the answer carries the row in `stop`, `finished` is the procedure's promise (never throws). The procedure:
//     desired     the desired state FRESH (like the desired-state tick and the server end: insideInspect → serverEnd.js
//                 carryForwardDesired → withServicesOfNow) — the tick writes at most every 60 s, and what ran since is what the next
//                 start should start again. An empty reading replaces no non-empty desired state; a read error keeps the old one;
//     sessions    the instance's terminals and debuggers end with a notice (idle.js endInstanceSessions, with the terminals of their
//                 chats' side bar) — they would otherwise run against a container that is about to stop;
//     container   `docker stop -t 30 <id>` through the docker seam (docker.js docker — it sets the marker "cbase stops itself" BEFORE
//                 the child), by id, only an own project container (label `cbase.project` of this project on the container, not
//                 inherited from the image: docker.js onlyOwnProjectContainer). Cap STOP_CAP_MS (deadline + margin, like tearing down
//                 a copy);
//   then `stopped`. Why the observer does NOT bring it back: from the first step the row is in `stop`, never again in `ready`
//   (resumption.js judges only `ready` — "state-stop"/"state-stopped"), AND the `stop` carries the marker. The order: first out of
//   `ready`, then stop. A failure is `error` with a reason (B's next start retries the row, like every one in `error`).
//
// instanceStart(projectId, instance, { cause }) → { row, kind, fresh, since?, reason?, promise }   (POST …/start; one turn)
//   Only from `stopped` (409 INSTANCE_NOT_STOPPED), without lock (409 INSTANCE_LOCKED) and occupation (409 OCCUPIED). First the
//   STORAGE GATE (workflows/storage-gate.js storageSituation — the same as for graph starts and copies):
//     open   ⇒ restore.js restoreInstance(…, { fromStopped: true }) — synchronously `start`, then marker → container (`docker start`
//            by id) → wait (inner dockerd, ≈ 3.5 s measured) → stages → services → names → `ready`. `kind` "start"; if it fails
//            there, the row is `error` (the way of the restoration).
//     closed ⇒ the row stays `stopped` with phase `waiting_storage` (visible in the event, in the row and in
//            waitForInstanceStart: `{ since, reason }`), `kind` "waiting". The arbiter of the storage wait (workflows/storage-queue.js,
//            source "instance-start" — instanceStartCandidates) starts it as soon as the gate opens, like every other waiting work: at
//            most ONE per pass, the oldest first. The phase is in the database: a restart of B does not lose the wish (the source
//            reads the rows; `since` then falls back to `updated_at`).
//   If the row is already in `waiting_storage`, a second start is the same wish (`fresh: false`).
// instanceStartAbort(projectId, instance) → row   (POST …/start-abort) withdraws the waiting: phase empty, the row stays
//   `stopped`. Only in `waiting_storage` (else 409 NO_WAITING_START). A turn waiting for the instance triggers the start again at
//   its next look at the lock (a turn starts the stopped instance).
// nudgeStopped(projectId, instance, { chatId })   the lock's hook (projectbox/idle.js setStoppedStart, wired in server.js): a turn,
//   subagent, workflow agent or oneshot in the project container for a STOPPED instance triggers the start (the same instanceStart,
//   with storage gate) and waits at the lock as for `start`; the transition to `ready` wakes it (instances.js setStateWakeup →
//   idle.js wakeProject). If the start begins anew and the nudge names a chat, a separator (role `hint`) appears there:
//   "<instance> started." or "… will be started as soon as memory is free …". Never throws.
// keepTrackOfStopped(row, container)   the observer's reconciliation (resumption.js, after every (re)start of the stream): if a row is
//   `stopped` but its container runs (a hard end of B in the middle of a stop, a start past cbase), it is stopped again with a
//   notice — never a silent `ready`. Under the instance occupation "stop", only without a procedure and only if the row is still the
//   same (`stateSince`). → whether stopped.
// checkAction(inst)   the checks BEFORE every writing action on an instance (branch, discard, stack restart; stopping) — ONE place,
//   instance-actions.js imports it.
//
// NOT HERE: that `stopped` stays put is kept by the other ways themselves — restore.js (marking, post-start, `STOPPED` without
// `fromStopped`), resumption.js (judges only `ready`), recreate.js (leaves `stopped` alone), instances.js (an interrupted stop becomes
// `stopped` in the post-start). The routes are in instance-actions.js (sub-slice instanceProjectRoutes), the fence rows in
// fence-table.js. Preview links to a stopped instance stay; their proxy answers 502 "instance stopped" (preview/links.js).
//
// Guards: server/backend/test/instance-stop.test.js; the stop place in server/backend/test/projectbox-stop-places.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { projectboxOps } from "./ops.js";
import { MAIN, LABEL_PROJECT } from "./creation.js";
import { containerOf } from "./run-instance.js";
import { docker, isFrozen, onlyOwnProjectContainer } from "./docker.js";
import { procedureAlive, setInstanceState, withProcedure } from "./instances.js";
import { CALL_CAP_MS, occupancySentence, instanceOccupied, withInstanceOccupancy, projectOccupied } from "./instance.js";
import { endInstanceSessions, instanceWork, instanceWorkingError, projectLocked } from "./idle.js";
import { withServicesOfNow, withoutSuperseded, carryForwardDesired } from "./serverEnd.js";
import { insideInspect, restoreInstance } from "./restore.js";
import { storageSituation } from "../workflows/storage-gate.js";

/** The stop's deadline (seconds) — the same as server end and recreation; measured it takes ≈ 11.5 s. */
export const STOP_DEADLINE_S = 30;
/** The cap of `docker stop`: deadline plus margin (like tearing down a copy, stacks/clearAway.js). ESTIMATED, NOT MEASURED. */
export const STOP_CAP_MS = 90_000;
/** The phase of a stopped row whose start waits for storage — the same name as for graph starts and copies. */
export const WAITING_STORAGE = "waiting_storage";

const error = (status, code, text, extra = {}) => Object.assign(new Error(text), { status, code, ...extra });
const short = (e) => String(e?.message || e || "").split("\n")[0].slice(0, 400);
const missing = (e) => /No such (object|container)|not found/i.test(`${e?.stderr || ""}\n${e?.message || ""}`);

// The start wishes in this process's memory: identifier → { since, reason, cause }. Only information (since when, why) and the
// queue's order — the wish itself is in the row (phase `waiting_storage`).
const startWishes = new Map();

// ── The check of every writing action ───────────────────────────────────────────────────────────────────────────────────────

/** Before every WRITING action (header): ready, not locked, not occupied — then the work lock. Throws `{ status, code }`. */
export function checkAction(inst) {
  const name = inst.instance || MAIN;
  if (inst.state !== "ready") {
    throw error(409, "INSTANCE_NOT_READY", T`Instance ${name} is not ready (${inst.state}${inst.error ? `: ${inst.error}` : ""}).`, { state: inst.state });
  }
  const lock = projectLocked(inst.projectId, name);
  if (lock) throw error(409, "INSTANCE_LOCKED", T`Instance ${name} is locked (${lock.reason}).`, { reason: lock.reason });
  const occupied = projectOccupied(inst.projectId) || instanceOccupied(inst.projectId, name);
  if (occupied) throw error(409, "OCCUPIED", T`${occupancySentence(occupied)} is running on instance ${name}.`, { occupancy: occupied });
  const work = instanceWork(inst.projectId, name);
  if (!work.quiet) throw instanceWorkingError(work, name);
}

// ── Container ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function readContainer(name) {
  try { return JSON.parse((await docker(["inspect", "--type", "container", name], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) { if (missing(e)) return null; throw e; }
}

// The ONE stop of a project container here (stop place, table in the header of resumption.js): by id, only an own one.
async function stopContainer(id) {
  const foreign = [];
  const own = await onlyOwnProjectContainer([id], { capMs: CALL_CAP_MS }, foreign);
  if (!own.length) throw new Error(T`${id.slice(0, 12)} carries the project label only from its image — not a project container, not stopped`);
  await docker(["stop", "-t", String(STOP_DEADLINE_S), id], { capMs: STOP_CAP_MS });
}

// The desired state fresh (header, step "desired"). Never throws — a read error keeps the old desired state.
async function desiredNow(pid, name, id) {
  let inspect;
  try { inspect = await insideInspect(id); }
  catch (e) { console.warn(`[projectbox] stop ${pid}/${name}: inside not readable (${short(e)}) — the old desired state stays`); return false; }
  const now = store.projectInstance(pid, name);
  if (now?.state !== "stop") return false;
  const fresh = carryForwardDesired(now.desired, withoutSuperseded(pid, inspect));
  if (!fresh.container.length && (now.desired?.container?.length || 0) > 0) {
    console.warn(`[projectbox] stop ${pid}/${name}: read empty, the desired state names ${now.desired.container.length} containers — the old desired state stays`);
    return false;
  }
  store.changeProjectInstance(pid, name, { desired: withServicesOfNow(pid, name, fresh) });
  return true;
}

// ── Stopping ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POST …/stop (header). Throws the checks (status/code); otherwise `{ row, finished }` with the row in `stop`. */
export function instanceStop(inst) {
  checkAction(inst);
  const pid = String(inst.projectId);
  const name = inst.instance || MAIN;
  if (procedureAlive(pid, name)) throw error(409, "OCCUPIED", T`A procedure is running on instance ${name}.`);
  if (isFrozen(containerOf(inst))) throw error(409, "FROZEN", T`Instance ${name} is frozen right now (a copy is being made).`);
  let row = null;
  // Synchronous up to the first await: occupation, procedure and `stop` are in place before the answer goes (withInstanceOccupancy
  // and withProcedure call their function in the same tick).
  const finished = withInstanceOccupancy(pid, name, "stop", () => withProcedure(pid, name, () => {
    row = setInstanceState(pid, name, "stop", { phase: "desired" });
    return stopProcedure(pid, name);
  })).catch((e) => { console.error(`[projectbox] stop ${pid}/${name}:`, short(e)); return null; });
  return { row: row || store.projectInstance(pid, name), finished };
}

async function stopProcedure(pid, name) {
  const phase = (p) => setInstanceState(pid, name, "stop", { phase: p });
  try {
    const inst = store.projectInstance(pid, name);
    const cname = containerOf(inst);
    const c = await readContainer(cname);
    if (!c) throw new Error(T`The project container ${cname} is missing`);
    if (c.Config?.Labels?.[LABEL_PROJECT] !== pid) throw new Error(T`${cname} does not carry this project's label (${LABEL_PROJECT}=${c.Config?.Labels?.[LABEL_PROJECT] ?? "—"})`);
    const id = String(c.Id);
    if (c.State?.Status === "running" && !c.State?.Paused) await desiredNow(pid, name, id);
    phase("sessions");
    try {
      const n = endInstanceSessions(pid, name, T`Instance ${name} is being stopped — this session ends.`, { chats: true });
      if (n) console.log(`[projectbox] stop ${pid}/${name}: ${n} session(s) ended with a notice`);
    } catch (e) { console.warn(`[projectbox] stop ${pid}/${name}: sessions not ended (${short(e)})`); }
    phase("container");
    await stopContainer(id);
    const row = setInstanceState(pid, name, "stopped", { phase: "", containerId: id });
    console.log(`[projectbox] stop ${pid}/${name}: stopped (${id.slice(0, 12)})`);
    return row;
  } catch (e) {
    const reason = short(e);
    console.error(`[projectbox] stop ${pid}/${name} failed: ${reason}`);
    if (!store.projectInstance(pid, name)) return null;
    return setInstanceState(pid, name, "error", { error: T`Stop failed: ${reason}` });
  }
}

// ── Starting ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const identifierOf = (pid, name) => store.instanceIdentifier(String(pid), name || MAIN);

/** Does this instance's start wait for storage? → `{ since, reason }` or null (for answers and the tree). */
export function waitForInstanceStart(projectId, instance = MAIN) {
  const z = store.projectInstance(String(projectId), instance || MAIN);
  if (z?.state !== "stopped" || z.phase !== WAITING_STORAGE) return null;
  const w = startWishes.get(identifierOf(projectId, instance));
  return { since: w?.since ?? z.updatedAt, reason: w?.reason ?? "" };
}

// The start sequence (header, gate open). Synchronous up to `start`; the promise never throws (an early denial is in `kind`).
function startUp(pid, name, cause) {
  startWishes.delete(identifierOf(pid, name));
  let denial = null;
  const promise = restoreInstance(pid, name, { reason: `start (${cause})`, fromStopped: true })
    .catch((e) => { denial = e; console.error(`[projectbox] start ${pid}/${name}: ${short(e)}`); return null; });
  const row = store.projectInstance(pid, name);
  const begun = row?.state === "start";
  // A denial before `start` (OCCUPIED, copy tear-down …) leaves the row untouched — a waiting phase stays too, and the queue tries
  // again in the next pass. The promise then throws the denial (the route names it).
  return { row, kind: begun ? "start" : "denied", promise: promise.then((r) => { if (!begun && denial) throw denial; return r; }) };
}

/** POST …/start and the nudge of a turn (header). Throws the checks (status/code). */
export function instanceStart(projectId, instance = MAIN, { cause = "human" } = {}) {
  const pid = String(projectId ?? "");
  const name = String(instance || MAIN);
  const z = store.projectInstance(pid, name);
  if (!z?.convertedAt) throw error(404, "UNKNOWN_INSTANCE", T`No living instance "${name}" in project ${pid}.`, { instance: name });
  if (z.state !== "stopped") {
    throw error(409, "INSTANCE_NOT_STOPPED", T`Instance ${name} is not stopped (${z.state}).`, { state: z.state });
  }
  const lock = projectLocked(pid, name);
  if (lock) throw error(409, "INSTANCE_LOCKED", T`Instance ${name} is locked (${lock.reason}).`, { reason: lock.reason });
  const occupied = projectOccupied(pid) || instanceOccupied(pid, name);
  if (occupied) throw error(409, "OCCUPIED", T`${occupancySentence(occupied)} is running on instance ${name}.`, { occupancy: occupied });
  if (z.phase === WAITING_STORAGE) return { row: z, kind: "waiting", fresh: false, ...waitForInstanceStart(pid, name), promise: Promise.resolve(null) };
  const situation = storageSituation();
  if (!situation.free) {
    const since = Date.now();
    startWishes.set(identifierOf(pid, name), { since, reason: situation.reason, cause });
    const row = setInstanceState(pid, name, "stopped", { phase: WAITING_STORAGE });
    console.log(`[projectbox] start ${pid}/${name} (${cause}): ${situation.reason} — the instance starts as soon as the gate opens`);
    return { row, kind: "waiting", fresh: true, since, reason: situation.reason, promise: Promise.resolve(null) };
  }
  return { ...startUp(pid, name, cause), fresh: true };
}

/** POST …/start-abort (header). → the row afterwards. */
export function instanceStartAbort(projectId, instance = MAIN) {
  const pid = String(projectId ?? "");
  const name = String(instance || MAIN);
  const z = store.projectInstance(pid, name);
  if (!z || z.state !== "stopped" || z.phase !== WAITING_STORAGE) {
    throw error(409, "NO_WAITING_START", T`No start is waiting on instance ${name} (${z ? `${z.state}${z.phase ? `, ${z.phase}` : ""}` : T("no row")}).`, { state: z?.state ?? null });
  }
  startWishes.delete(identifierOf(pid, name));
  console.log(`[projectbox] start ${pid}/${name}: the wait for storage was withdrawn`);
  return setInstanceState(pid, name, "stopped", { phase: "" });
}

/** The wording of the separator. */
export function startSeparatorText(instance, kind, reason = "") {
  const name = String(instance || MAIN);
  if (kind === "waiting") return T`${name} will be started as soon as memory is free${reason ? ` (${reason})` : ""}.`;
  return T`${name} started.`;
}

/** The lock's hook (header). Never throws. → `{ ok, kind }`. */
export function nudgeStopped(projectId, instance = MAIN, { chatId = null } = {}) {
  let r;
  try { r = instanceStart(projectId, instance, { cause: chatId ? `turn in chat ${chatId}` : "work in the project" }); }
  catch (e) {
    console.warn(`[projectbox] start ${projectId}/${instance} not triggered from the lock: ${short(e)}`);
    return { ok: false, kind: "denied", reason: short(e) };
  }
  if (r.fresh && r.kind !== "denied" && chatId) {
    try { store.addMessage(String(chatId), "hint", startSeparatorText(instance, r.kind, r.reason)); }
    catch (e) { console.error(`[projectbox] start ${projectId}/${instance}: separator in chat ${chatId}:`, short(e)); }
  }
  return { ok: r.kind !== "denied", kind: r.kind };
}

/**
 * The source "instance-start" of the arbiter (workflows/storage-queue.js, registered in server.js): every stopped row in
 * `waiting_storage`, `waitingSince` = since the wish (after a restart `updated_at`), `storage` always. `attempts()` asks the gate itself
 * (like stacks/queue.js) and starts up if it is open and the instance is neither locked nor occupied.
 */
export function instanceStartCandidates() {
  if (!projectboxOps()) return [];
  return store.projectInstancesInState(["stopped"]).filter((z) => z.convertedAt && z.phase === WAITING_STORAGE).map((z) => ({
    waitingSince: startWishes.get(z.identifier)?.since ?? z.updatedAt,
    storage: true,
    attempts: () => {
      const now = store.projectInstance(z.projectId, z.instance);
      if (now?.state !== "stopped" || now.phase !== WAITING_STORAGE) return { started: false };
      if (projectLocked(z.projectId, z.instance) || projectOccupied(z.projectId) || instanceOccupied(z.projectId, z.instance)) return { started: false };
      const situation = storageSituation();
      if (!situation.free) {
        const w = startWishes.get(z.identifier);
        startWishes.set(z.identifier, { since: w?.since ?? z.updatedAt, reason: situation.reason, cause: w?.cause ?? "queue" });
        return { started: false };
      }
      const r = startUp(z.projectId, z.instance, startWishes.get(z.identifier)?.cause || "queue");
      return { started: r.kind === "start" };
    },
  }));
}

// ── The reconciliation (resumption.js) ───────────────────────────────────────────────────────────────────────────────────────

/** Header "keepTrackOfStopped". `container` is the `inspect` of the running container. → whether stopped. Never throws. */
export async function keepTrackOfStopped(row, container) {
  const pid = String(row?.projectId ?? "");
  const name = row?.instance || MAIN;
  const id = String(container?.Id || "");
  if (!pid || !id) return false;
  const equal = () => {
    const now = store.projectInstance(pid, name);
    return now?.state === "stopped" && now.stateSince === row.stateSince && !procedureAlive(pid, name);
  };
  if (!equal() || projectOccupied(pid) || instanceOccupied(pid, name)) return false;
  if (container?.Config?.Labels?.[LABEL_PROJECT] !== pid) return false;
  try {
    return await withInstanceOccupancy(pid, name, "stop", async () => {
      if (!equal()) return false;
      console.warn(`[projectbox] reconcile ${pid}/${name}: the row is stopped, the container runs (${id.slice(0, 12)}) — stopping it again`);
      await stopContainer(id);
      return true;
    });
  } catch (e) {
    console.error(`[projectbox] reconcile ${pid}/${name}: the stopped container runs and could not be stopped (${short(e)})`);
    return false;
  }
}
