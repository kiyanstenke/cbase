// The recreation of a project container. If image or mount list differ from the desired ones — or the container is missing, or its
// entrypoint reports `phase=error` —, cbase recreates the project container in the NEXT IDLE of the project: with the same volume (the
// images and containers of the project stay, no pull), the same IP, the same hostname and the same stack. No UI, no switch: visible
// through the event `project/instance` (phase), `projectWork` in /api/runs/active and the operator's status check.
//
// THE CONTRACT. No recreation in the middle of a run of the project (the lock is set only when the idle is quiet); removed only by
// id (`docker rm <id>`, without `-f`, after `docker stop -t 30 <id>`); a turn that arrives during the recreation waits and runs
// afterwards (lock, wakeup on release).
//
// desiredActual({ inspect, desiredImageId, desiredMountsHash, desiredMountsHashV1, recognized })  PURE: `{ equal: true, fresh: [] }`
//   or `{ equal: false, fresh: [reasons] }` from `.Image` of the container and its labels `cbase.mounts.v2` resp. — without it —
//   `cbase.mounts` (the hash transition, below; `recognize` may be added there). If both labels are missing ⇒ fresh; if the container is
//   missing (no `inspect`) ⇒ fresh. Without a desired state (image id or hash empty) it is NO verdict (TypeError) — empty is not
//   unknown: whoever could not read the desired state does not check.
//
// THE CHECK TIMES: restart grace — after every restore of the restart grace that ended in `ready` (restore.js setRecreateRestartGrace
//   `check`; the deploy loads the new image before the swap; the promise belongs to the hook, the quiet waits for it) — and the turn
//   beginning of a chat of the project (runs/instance.js setTurnObserver `beginning` — a distribution without a swap of B; the check
//   belongs to the turn: doRun ends only after it, guard in the test). Only a relocated instance in `ready` is checked: `docker
//   inspect` of the container, `docker image inspect cbase-projectbox:latest` (desired image) and instance.js desiredMounts (desired
//   mounts: new workspace files, changed ro user files, a new inode of auth.json). A deviation is EARMARKED, never executed at once.
//   Plus the two requests of the restore (`setRecreateRequest`): entrypoint `phase=error` and a missing container — the same way, in
//   the next idle.
//
// THE ATTEMPT (attemptsRecreate) — triggered at earmarking (synchronously), at the end of every turn (setTurnObserver `end`), after the
//   restore of the restart grace and in the look-up tick (below): if the instance is working (start · create · recreate · relocation) or
//   another flow holds the project (creation, deletion, restore), it waits. Else projectLocks(…, "recreate") — set the lock, THEN check
//   idle; if something is open, the earmark stays and it reports what is open. If the project is quiet (the lock ends the terminals
//   `proj:<id>` and `chat:<id>` with a notice), THE FLOW runs under the occupation "recreate" (instance occupation, instance.js
//   withInstanceOccupancy — a project occupation excludes it: no deletion, no relocation, no build of a copy and no second creation in
//   between) and as the flow of the instance (instances.js withProcedure):
//     state `recreate` · precheck of the creation (instance.js creationPrecheck: marker, login, CLI home, image — BEFORE removing; if it
//     fails, the old container still stands) · snapshot `desired` of the running stack (only if the instance was `ready` — from `error`
//     the last one holds, for a broken stack is not the intent; written through serverEnd.js carryForwardDesired and withServicesOfNow:
//     the marker "failed" stays, `services` fresh from the row) · `docker stop -t 30 <id>` · `docker rm <id>` · creation (instance.js
//     createInstance with `state: "recreate"` and `occupancyHeld`: the network of the row stays, so the same `--ip` and hostname; the
//     same volume) · restore (restore.js restoreInstance with `state: "recreate"`: stages from `desired`, native services, names) ·
//     `ready`. Then the lock is released and wakes what came in the meantime (idle.js wakeProject). If a step fails: `error` with a
//     reason (runs end visibly); a recreation request from the restore of THIS pass is not earmarked again (otherwise a permanently broken
//     entrypoint would grind stop/rm/run without end) — the next start of B tries the row once more.
//
// THE RESUMPTION (resumeRecreate, connector setRecreateRestartGrace `resume` of the restart grace): a row that a crash left in `recreate`
//   in the middle of a recreation. No idle (the state itself holds every start since the crash, and the waiting workflow agents of the
//   restart grace never made it quiet), the flow is entered SYNCHRONOUSLY. It finds out what already happened: container gone ⇒ create;
//   there with wrong image/mounts ⇒ stop, rm by id, create; there and equal (the crash came after the creation) ⇒ only the restore.
//   "Equal" means only image and mounts — if the cause was `phase=error` and B crashed before the old container was removed, the "equal"
//   one is the broken one: its restore reports `phase=error` again. A request from the restore of a RESUMPTION WITHOUT CREATION therefore
//   gets exactly ONE pass from recreateRequest (`resumptionFree`): earmarked, recreated in the next idle. Reading the status file
//   beforehand (the other way) does not hold: after the crash the container is stopped, and its content counts only once the entrypoint
//   ran again — so only in the restore. A request from the restore after a CREATION stays refused (no loop).
//
// THE NEW ATTEMPT FROM `error` (recreateErrorAttempt; connector idle.js setErrorAttempt, wired in server.js): a turn or agent (also a
//   workflow agent) of a relocated project whose instance stands in `error` triggers ONE new restore attempt (restoreInstance — if it
//   requests the recreation, it goes the way above: earmarked, in the next idle). At most one per project at a time (no recreation, no
//   occupation, no living flow; the row then stands synchronously in `start`) and not more often than once per look-up tick: measured
//   by `stateSince` of the row — since when it has stood in `error`. Every failed attempt (also that of the restart grace, a
//   recreation, the git view) sets the row to `error` anew and with that the deadline anew. The start waits at the lock as with `start`
//   (idle.js projectLock judges anew after the attempt) and runs after `ready`; if the attempt fails, the transition to `error` wakes it,
//   and it ends visibly as before (the deadline then just restarts). Within the deadline: no attempt, today's error. Without the ops
//   marker or without a relocated row: nothing. Returns: whether an attempt was triggered.
//   NOT for the instance of a copy whose clearing away runs or failed (restore.js copyInClearAway) — it would otherwise stand `error` in
//   stack_copies and `ready` as instance, turns would run in it again, and a clearing away that continues in step 5 would take the new
//   work along unfetched. Likewise attemptsRecreate does not recreate its container (the earmark drops — if it is missing, the clearing
//   away creates it itself without reviving it: stacks/clearAway.js copyRunning), and a resumption of the restart grace does not go on:
//   the row becomes `error` with the phase REVIVED (restore.js copyStaysBehind).
//
// CONNECTORS (wired in server.js): setRecreateFinished (after every successful recreation the continuation of an open setup, see the
//   test seam below), recreateRequest → setRecreateRequest, recreateRestartGraceSeam → setRecreateRestartGrace ({ resume, check }),
//   recreateTurnObserver → runs/instance.js setTurnObserver, cleanUpRecreate → closing of the server (in the "close" listener of
//   stopTunnel — an eleventh listener warned). `atReady` does NOT use it: a callback after EVERY restore would run uncounted beside the
//   server (docker calls after the end of a test, ENOTEMPTY when cleaning up the false docker). TEST SEAMS: setCreationOptions(fn) — the
//   creation options per project (`home`, `system`, `root`, `addresses`, `data`; in the product `{}`); recreateStatus(projectId) —
//   earmark, running flow and the result of the last attempt (`last`: `{ ok, reason, open? }`).
//
// PER INSTANCE: earmark, check, attempt, resumption and the new attempt from `error` hold per identifier `<projectId>/<instance>` — a
//   copy is recreated like the main, in the idle OF THE COPY (idle.js projectLocks with `instance`), under its instance occupation,
//   with its rule table (desiredMounts with `instance` → mountRulesCopy), its volume, its layer (`<data>/copies/…` is not touched here)
//   and its IP (the network of the row). Every function takes the instance as an option (default `main`); for the main everything is
//   as before.
// THE HASH TRANSITION: every creation writes BOTH formulas — the new one (creation.js mountsHash, inode of every single file) into the
//   label `cbase.mounts.v2`, the old one (mountsHashV1, content of the read-only ones) into the label `cbase.mounts` (an older release
//   reads that: a rollback recreates nothing — with the same mount list; every main carries the row `cli-vscode-server`, so a rollback
//   to before it recreates each main created afterwards once — a copy not, its hashes are the same as before).
//   `cbase.mounts.v2` is compared against the desired hash. A container WITHOUT it (created before the new formula) is judged so:
//     1. `cbase.mounts` equals the OLD formula over the state of NOW ⇒ equal, and `recognize` carries the new hash of now: the check
//        writes it into the column `mounts_hash` of the instance row — only for THE SAME container (the row names its id) and only from
//        `ready`.
//     2. else the recognised value of the row (`recognized`, only if it names the same container) equals the new hash of now ⇒ equal. So
//        a write in place (appendFileSync on `~/.codex/config.toml`, same inode) stays without recreation also for an old container —
//        without 2. the old formula would have recreated it at the first write after all.
//     3. else "mounts differ".
//   REMAINING RISK (named): a write in place BETWEEN the last check of the old release and the first of this one (the restart grace after
//   the rollout) no longer finds 1. equal — that container is recreated once, as the old release would have done. And 1. adopts what the
//   old formula did not see: a read-only file replaced by rename with the same content BEFORE the recognition counts as equal with its new
//   inode.
//
// Knob: CBASE_RECREATE_CHECK_BACK_MS (integer ≥ 100, default 60 s) — the look-up tick of an earmark. A product cap that says it is one:
// the ordinary way is the end of a turn; the tick catches an idle that comes without a turn end (an aborted workflow run, an ending
// monitor or oneshot).
import * as store from "../store.js";
import { MAIN, LABEL_INSTANCE, LABEL_MOUNTS, LABEL_MOUNTS_V2, LABEL_PROJECT, PROJECTBOX_IMAGE, STOP_DEADLINE_S, isCopy } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { DockerError, docker, dockerIn } from "./docker.js";
import { CALL_CAP_MS, creationPrecheck, instanceOccupied, createInstance, withInstanceOccupancy, projectOccupied, desiredMounts } from "./instance.js";
import { procedureAlive, setInstanceState, withProcedure } from "./instances.js";
import { containerOf } from "./run-instance.js";
import { projectLocks } from "./idle.js";
import { withServicesOfNow, withoutSuperseded, carryForwardDesired } from "./serverEnd.js";
import { copyStaysBehind, copyInClearAway, restoreInstance } from "./restore.js";

// ── Test seam and knobs ───────────────────────────────────────────────────────────────────────────────────────────

let creationOptions = () => ({});
export function setCreationOptions(fn) { creationOptions = typeof fn === "function" ? fn : () => ({}); }
const optionsFor = (pid) => { try { return creationOptions(pid) || {}; } catch { return {}; } };
/** The creation options of this project (test seam above; `{}` in the product) — the same for the setup. */
export const creationOptionsFor = (projectId) => optionsFor(String(projectId ?? ""));

// THE CONNECTOR OF THE SETUP (pattern setRecreateRestartGrace): after every SUCCESSFUL recreation (row `ready` afterwards) —
// asynchronously, when occupation, flow and lock are released — fn({ projectId, instance }). Wired in server.js to
// projectbox/setup/procedure.js resumeSetup: a restart in the middle of the creation of a new project ends in `error` (hook
// "project-instances"), the recreation brings the row to `ready`, and the setup then continues with `sources`. A throw is only logged.
let recreateFinished = null;
export function setRecreateFinished(fn) { recreateFinished = typeof fn === "function" ? fn : null; }
function reportFinished(pid, inst, row) {
  const fn = recreateFinished;
  if (!fn || row?.state !== "ready") return;
  setImmediate(() => {
    try {
      const r = fn({ projectId: pid, instance: inst });
      if (r && typeof r.then === "function") r.then(null, (e) => console.error(`[projectbox] recreation ${who(pid, inst)}: follow-up connector: ${e?.message || e}`));
    } catch (e) { console.error(`[projectbox] recreation ${who(pid, inst)}: follow-up connector: ${e?.message || e}`); }
  });
}

export const CHECK_BACK_MS = 60_000;
export function recreateCheckBackMs() {
  const raw = process.env.CBASE_RECREATE_CHECK_BACK_MS;
  const ms = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(ms) && ms >= 100 ? ms : CHECK_BACK_MS;
}

// ── The pure check ─────────────────────────────────────────────────────────────────────────────────────────────────

const imageNorm = (x) => {
  const s = String(x ?? "").trim();
  return /^[0-9a-f]{64}$/.test(s) ? `sha256:${s}` : s;
};
const short = (id) => imageNorm(id).replace(/^sha256:/, "").slice(0, 12) || "—";

const empty = (x) => x === undefined || x === null || String(x) === "";

export function desiredActual({ inspect, desiredImageId, desiredMountsHash, desiredMountsHashV1 = null, recognized = null } = {}) {
  if (!desiredImageId || !desiredMountsHash) {
    throw new TypeError("desiredActual: desiredImageId and desiredMountsHash are required — without a desired state there is no verdict (empty is not unknown)");
  }
  if (!inspect || typeof inspect !== "object") return { equal: false, fresh: ["the project container is missing"] };
  const fresh = [];
  const actual = imageNorm(inspect.Image);
  if (!actual) fresh.push("image of the container unknown");
  else if (actual !== imageNorm(desiredImageId)) fresh.push(`image ${short(actual)} instead of ${short(desiredImageId)}`);
  // The transition (header "THE HASH TRANSITION"): first the new label; without it the old one, against the old formula of now, then
  // against the recognised new hash of the row.
  const labels = inspect.Config?.Labels || {};
  const v2 = labels[LABEL_MOUNTS_V2];
  const v1 = labels[LABEL_MOUNTS];
  let recognize = null;
  if (!empty(v2)) {
    if (String(v2) !== String(desiredMountsHash)) fresh.push(`mounts differ (${LABEL_MOUNTS_V2})`);
  } else if (empty(v1)) fresh.push(`without label ${LABEL_MOUNTS_V2} or ${LABEL_MOUNTS}`);
  else if (!empty(desiredMountsHashV1) && String(v1) === String(desiredMountsHashV1)) recognize = String(desiredMountsHash);
  else if (empty(recognized) || String(recognized) !== String(desiredMountsHash)) fresh.push(`mounts differ (${LABEL_MOUNTS})`);
  if (fresh.length) return { equal: false, fresh };
  return recognize ? { equal: true, fresh: [], recognize } : { equal: true, fresh: [] };
}

// The recognised new hash (header, transition 2.) — only if the row names THIS container (its id); else null.
const sameContainer = (row, c) => {
  const a = String(row?.containerId || "");
  const b = String(c?.Id || "");
  return a.length >= 12 && b.length >= 12 && (a === b || b.startsWith(a) || a.startsWith(b));
};
const recognizedFor = (row, c) => (sameContainer(row, c) && !empty(row.mountsHash) ? String(row.mountsHash) : null);

// ── docker ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const missing = (e) => e instanceof DockerError && /No such (object|container)|not found/i.test(`${e.stderr}\n${e.message}`);

async function readContainer(name) {
  try { return JSON.parse((await docker(["inspect", "--type", "container", name], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) { if (missing(e)) return null; throw e; }
}

async function desiredValues(pid, inst = MAIN) {
  const id = (await docker(["image", "inspect", "--format", "{{.Id}}", PROJECTBOX_IMAGE], { capMs: CALL_CAP_MS })).stdout.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`${PROJECTBOX_IMAGE}: unexpected id “${id}”`);
  const m = desiredMounts(pid, { ...optionsFor(pid), instance: inst });
  return { desiredImageId: id, desiredMountsHash: m.hash, desiredMountsHashV1: m.hashV1 };
}

// Does the container NOT carry the labels of this instance? For the main only the project (as before); a copy also its instance.
const foreignLabel = (c, pid, inst) => c.Config?.Labels?.[LABEL_PROJECT] !== pid || (inst !== MAIN && c.Config?.Labels?.[LABEL_INSTANCE] !== inst);

// The snapshot `desired` of the running stack (the form of serverEnd.js): `docker ps -aq` and `inspect` IN the container. If it
// fails, the last one holds (pattern of the stop chain). Written from the row of NOW (read synchronously before writing): the marker
// "failed" of the last snapshot stays, `services` fresh.
async function desiredWrite(pid, inst, row, id) {
  try {
    const ids = (await dockerIn(id, ["ps", "-aq", "--no-trunc"], { capMs: CALL_CAP_MS })).stdout.split(/\s+/).filter(Boolean);
    const inspect = ids.length ? JSON.parse((await dockerIn(id, ["inspect", ...ids], { capMs: CALL_CAP_MS })).stdout || "[]") : [];
    const now = store.projectInstance(pid, inst);
    if (!now) return;
    store.changeProjectInstance(pid, inst, { desired: withServicesOfNow(pid, inst, carryForwardDesired(now.desired ?? row?.desired, withoutSuperseded(pid, inspect))) });
  } catch (e) {
    console.warn(`[projectbox] recreation ${who(pid, inst)}: snapshot not written, the last one holds (${e?.message || e})`);
  }
}

// ── Earmark, check, attempt ────────────────────────────────────────────────────────────────────────────────────────
// Everything per identifier `<projectId>/<instance>` (store.instanceIdentifier). In the log the main is still named only by its
// project (as before), a copy by its identifier.

const earmarked = new Map(); // identifier → { reason, since }
const active = new Set(); // identifiers with a running recreation in THIS process
const checks = new Map(); // identifier → running check (one per instance)
const last = new Map(); // identifier → { time, ok, reason, open? } — information about the last attempt
const resumptionFree = new Set(); // resumptions WITHOUT creation — their restore may request ONCE
let checkBack = null;

const identifierOf = (pid, inst) => store.instanceIdentifier(pid, inst);
const who = (pid, inst) => (inst === MAIN ? pid : identifierOf(pid, inst));
/** Project and instance from an identifier (the instance stands behind the LAST slash). */
function parts(identifier) {
  const i = identifier.lastIndexOf("/");
  return { pid: identifier.slice(0, i), inst: identifier.slice(i + 1) };
}
/** The instance of an option: `main` without a value; an invalid one throws (creation.js copyNameOf). */
function instanceFrom(instance) {
  const inst = String(instance || MAIN);
  isCopy(inst);
  return inst;
}

/** Information (test seam and log): earmark, running flow, last attempt — per instance (default the main). */
export function recreateStatus(projectId, instance = MAIN) {
  const k = identifierOf(String(projectId ?? ""), instanceFrom(instance));
  const v = earmarked.get(k);
  return { earmarked: v ? { ...v } : null, active: active.has(k), last: last.get(k) || null };
}

function planCheckBack() {
  if (checkBack || !earmarked.size) return;
  const ms = recreateCheckBackMs();
  checkBack = setTimeout(() => {
    checkBack = null;
    const list = [...earmarked.keys()];
    if (list.length) console.log(`[projectbox] recreation: look-up after ${ms} ms (cap CBASE_RECREATE_CHECK_BACK_MS) — ${list.map((k) => { const t = parts(k); return who(t.pid, t.inst); }).join(", ")}`);
    for (const k of list) attemptsIdentifier(k);
    planCheckBack();
  }, ms);
  checkBack.unref?.();
}

const attempts = (pid, inst = MAIN) => { attemptsRecreate(pid, { instance: inst }).catch((e) => console.error(`[projectbox] recreation ${who(pid, inst)}: ${e?.message || e}`)); };
const attemptsIdentifier = (k) => { const t = parts(k); attempts(t.pid, t.inst); };

/** Earmark a recreation (header) — executed in the next idle of the instance. Returns: earmarked yes/no. */
export function earmarkRecreate(projectId, { instance = MAIN, reason = "" } = {}) {
  if (!projectboxOps()) return false;
  const pid = String(projectId ?? "");
  if (!pid) return false;
  let inst;
  try { inst = instanceFrom(instance); } catch (e) { console.warn(`[projectbox] recreation ${pid}/${instance}: ${e?.message || e} — not earmarked`); return false; }
  const k = identifierOf(pid, inst);
  const g = String(reason || "").trim() || "no reason";
  const old = earmarked.get(k);
  if (old) { if (!old.reason.split("; ").includes(g)) old.reason = `${old.reason}; ${g}`; }
  else {
    earmarked.set(k, { reason: g, since: Date.now() });
    console.log(`[projectbox] recreation ${who(pid, inst)} earmarked (${g}) — in the next idle of the project`);
  }
  planCheckBack();
  // Synchronous (no setImmediate): an attempt that finds the project quiet sets lock and state `recreate` in this very turn — between
  // earmarking and beginning there is no gap in which the quiet of the server could report "quiet".
  attempts(pid, inst);
  return true;
}

/** Connector setRecreateRequest of the restore (entrypoint `phase=error`, missing container): the same way as a deviation. */
export function recreateRequest({ projectId, instance = MAIN, reason = "" } = {}) {
  const pid = String(projectId ?? "");
  let inst;
  try { inst = instanceFrom(instance); } catch (e) { console.warn(`[projectbox] recreation request ${pid}/${instance}: ${e?.message || e}`); return false; }
  const k = identifierOf(pid, inst);
  // From the restore of ONE recreation (the fresh container fails again): no second pass in the same turn (header) — the row stays
  // `error`, the next start tries it once more. Exception: a resumption that did NOT create found the old, broken container — it gets
  // exactly one pass.
  if (active.has(k)) {
    if (resumptionFree.delete(k)) {
      console.log(`[projectbox] recreation ${who(pid, inst)}: the resumption found the old container and its restore failed (${reason}) — ONE pass in the next idle`);
      return earmarkRecreate(pid, { instance: inst, reason });
    }
    console.warn(`[projectbox] recreation ${who(pid, inst)}: the restore after the recreation failed (${reason}) — no second recreation in this turn`);
    return false;
  }
  return earmarkRecreate(pid, { instance: inst, reason });
}

/** Check whether the container of a ready relocated instance matches the desired state; a deviation is earmarked. */
export function checkRecreate(projectId, { cause = "", instance = MAIN } = {}) {
  if (!projectboxOps()) return Promise.resolve(null);
  const pid = String(projectId ?? "");
  if (!pid) return Promise.resolve(null);
  let inst;
  try { inst = instanceFrom(instance); } catch (e) { return Promise.resolve({ checked: false, reason: String(e?.message || e) }); }
  const k = identifierOf(pid, inst);
  const running = checks.get(k);
  if (running) return running;
  const p = check(pid, inst, cause)
    .catch((e) => { console.warn(`[projectbox] recreation ${who(pid, inst)}: check (${cause || "—"}) not possible: ${e?.message || e}`); return { checked: false, reason: String(e?.message || e) }; })
    .finally(() => checks.delete(k));
  checks.set(k, p);
  return p;
}

async function check(pid, inst, cause) {
  const k = identifierOf(pid, inst);
  const row = store.projectInstance(pid, inst);
  if (!row?.convertedAt || row.state !== "ready") return { checked: false, reason: "no ready relocated instance" };
  if (earmarked.has(k) || active.has(k)) return { checked: false, reason: "already earmarked" };
  const name = containerOf(row);
  const c = await readContainer(name);
  let r;
  if (!c) r = { equal: false, fresh: [`the project container ${name} is missing`] };
  else {
    if (foreignLabel(c, pid, inst)) return { checked: false, reason: `${name} does not carry the label of this project` };
    r = desiredActual({ inspect: c, ...(await desiredValues(pid, inst)), recognized: recognizedFor(row, c) });
  }
  // During the docker calls another flow may have moved or deleted the row: only for THE SAME ready instance.
  const now = store.projectInstance(pid, inst);
  const ready = Boolean(now?.convertedAt && now.state === "ready");
  if (!r.equal && ready) earmarkRecreate(pid, { instance: inst, reason: `${cause ? `${cause}: ` : ""}${r.fresh.join("; ")}` });
  // The transition (header, 1.): the new hash of now holds from here on for this container — only if the row still names it.
  if (r.recognize && ready && sameContainer(now, c) && now.mountsHash !== r.recognize) {
    store.changeProjectInstance(pid, inst, { mountsHash: r.recognize });
    console.log(`[projectbox] recreation ${who(pid, inst)}: ${name} carries only ${LABEL_MOUNTS} (created before the new formula) — the new hash of now is recognised (${r.recognize.slice(0, 12)})`);
  }
  return { checked: true, ...r };
}

/** Try an earmarked recreation (header "THE ATTEMPT"). Returns: the result (also in recreateStatus). */
export async function attemptsRecreate(projectId, { instance = MAIN } = {}) {
  const pid = String(projectId ?? "");
  const inst = instanceFrom(instance);
  const k = identifierOf(pid, inst);
  const entry = earmarked.get(k);
  if (!entry) return { ok: false, reason: "not earmarked" };
  if (active.has(k)) return { ok: false, reason: "already running" };
  const state = (o) => { last.set(k, { time: Date.now(), ...o }); return o; };
  const forget = () => { earmarked.delete(k); if (!earmarked.size && checkBack) { clearTimeout(checkBack); checkBack = null; } };
  if (!projectboxOps()) { forget(); return state({ ok: false, reason: "no ops" }); }
  let row;
  try { row = store.projectInstance(pid, inst); }
  catch (e) { return state({ ok: false, reason: `instance not readable: ${e?.message || e}` }); }
  if (!row?.convertedAt) { forget(); return state({ ok: false, reason: "no relocated instance" }); }
  // The container of a copy in clearing away is not recreated — it belongs to the clearing away (it starts it itself and, if it is
  // missing, creates it itself without reviving the copy: stacks/clearAway.js copyRunning), and in the end the copy would stand `ready`
  // here again. The earmark drops; not readable ⇒ wait.
  let clearing;
  try { clearing = copyInClearAway(pid, inst); } catch (e) { return state({ ok: false, reason: `copy not readable: ${e?.message || e}` }); }
  if (clearing) { forget(); return state({ ok: false, reason: `copy in clearing away (${clearing.state}) — no recreation` }); }
  if (store.PROJECT_WORK_STATES.includes(row.state)) return state({ ok: false, reason: `instance in “${row.state}”` });
  // A STOPPED instance is not touched by the recreation — it ended `ready` and would have started it against the will of the human.
  // The earmark drops; after the next start the turn beginning (recreateTurnObserver.beginning) checks the container against the
  // desired state again.
  if (row.state === "stopped") { forget(); return state({ ok: false, reason: "instance stopped — no recreation" }); }
  const occupied = projectOccupied(pid) || instanceOccupied(pid, inst); // both levels
  if (occupied) return state({ ok: false, reason: `project occupied (${occupied})` });
  // Set the lock, THEN idle — both in projectLocks, synchronous, per instance (a copy in the idle OF THE COPY). If something is open:
  // wait (the earmark stays).
  let lock;
  try { lock = projectLocks(pid, { reason: "recreate", instance: inst }); }
  catch (e) { return state({ ok: false, reason: `lock: ${e?.message || e}` }); }
  if (!lock.ok) {
    const open = lock.open || [];
    if (!last.get(k)?.open) console.log(`[projectbox] recreation ${who(pid, inst)} waits for idle: ${open.map((o) => o.reason).join(", ") || lock.error || "—"}`);
    return state({ ok: false, reason: lock.error || "not idle", open });
  }
  forget();
  state({ ok: true, reason: entry.reason });
  active.add(k);
  const priorReady = row.state === "ready";
  try {
    // Synchronous up to the first step: occupation, flow and state `recreate` stand before anything else runs.
    const row = await withInstanceOccupancy(pid, inst, "recreate", () => withProcedure(pid, inst, () => procedure(pid, inst, { reason: entry.reason, priorReady })));
    reportFinished(pid, inst, row);
    return row;
  } finally {
    active.delete(k);
    lock.resolve();
    if (earmarked.has(k)) setImmediate(() => attempts(pid, inst)); // earmarked again in the meantime
  }
}

/** Connector setRecreateRestartGrace `resume` of the restart grace (header "THE RESUMPTION") — enters the flow SYNCHRONOUSLY. */
export function resumeRecreate({ projectId, instance = MAIN, reason = "" } = {}) {
  const pid = String(projectId ?? "");
  if (!projectboxOps() || !pid) return Promise.resolve(null);
  let inst;
  try { inst = instanceFrom(instance); } catch (e) { return Promise.reject(e); }
  const k = identifierOf(pid, inst);
  earmarked.delete(k);
  // A copy in clearing away resumes no recreation — its row goes synchronously to `error` (REVIVED) so "project-instances" does not set
  // it there without the marker. Not readable ⇒ as before (the restore at the end refuses).
  let from = null;
  try { from = copyInClearAway(pid, inst); } catch { from = null; }
  if (from) {
    try { copyStaysBehind(store.projectInstance(pid, inst), from); }
    catch (e) { console.error(`[projectbox] recreation ${who(pid, inst)}: resumption refused, row not set: ${e?.message || e}`); }
    return Promise.resolve(null);
  }
  active.add(k);
  const p = withInstanceOccupancy(pid, inst, "recreate", () => withProcedure(pid, inst, () => procedure(pid, inst, { reason: reason || "resumption", resumption: true })))
    .then((row) => { reportFinished(pid, inst, row); return row; });
  return p.finally(() => {
    active.delete(k);
    resumptionFree.delete(k);
    if (earmarked.has(k)) setImmediate(() => attempts(pid, inst));
  });
}

/** The new attempt from `error` (header "THE NEW ATTEMPT FROM `error`") — connector idle.js setErrorAttempt.
 *  `row`: the row of the instance on which the lock judges — without it the main. */
export function recreateErrorAttempt(projectId, row = null) {
  if (!projectboxOps()) return false;
  const pid = String(projectId ?? "");
  if (!pid) return false;
  const z = row || store.projectInstance(pid, MAIN);
  if (!z?.convertedAt || z.state !== "error" || String(z.projectId ?? pid) !== pid) return false;
  let inst;
  try { inst = instanceFrom(z.instance); } catch { return false; }
  // A copy whose clearing away runs or failed does not come up again — the lock judges `error` with the reason. Not readable ⇒ no
  // attempt (the restore would refuse it anyway).
  try { if (copyInClearAway(pid, inst)) return false; } catch { return false; }
  const since = Number(z.stateSince) || 0;
  const tick = recreateCheckBackMs();
  if (Date.now() - since < tick) return false; // within the deadline: the error of today
  if (active.has(identifierOf(pid, inst)) || projectOccupied(pid) || instanceOccupied(pid, inst) || procedureAlive(pid, inst)) return false; // at most one attempt at a time
  console.log(`[projectbox] ${who(pid, inst)}: in error for ${Math.round((Date.now() - since) / 1000)} s — a start triggers ONE new restore attempt (deadline ${tick} ms, CBASE_RECREATE_CHECK_BACK_MS)`);
  // Synchronous up to the first await: the row then stands in `start` (or, if the attempt failed without docker, already in `error`
  // again — the lock reads it anew afterwards).
  restoreInstance(pid, inst, { reason: "new attempt from error — a start waits", root: optionsFor(pid).root })
    .catch((e) => console.error(`[projectbox] ${who(pid, inst)}: new restore attempt not begun: ${e?.message || e}`));
  return true;
}

async function procedure(pid, inst, { reason, priorReady = false, resumption = false }) {
  const k = identifierOf(pid, inst);
  const opts = optionsFor(pid);
  const phase = (p) => setInstanceState(pid, inst, "recreate", { phase: p });
  console.log(`[projectbox] recreation ${who(pid, inst)}${resumption ? " (resumption)" : ""}: ${reason}`);
  try {
    phase("check");
    // Before removing: can a creation succeed NOW at all? (marker, login, CLI home, image — otherwise the project would stand without a
    // container.)
    await creationPrecheck(pid, opts);
    const row = store.projectInstance(pid, inst);
    const name = containerOf(row);
    const c = await readContainer(name);
    if (c && foreignLabel(c, pid, inst)) {
      throw new Error(`${name} does not carry the label of this project (${LABEL_PROJECT}=${c.Config?.Labels?.[LABEL_PROJECT] ?? "—"}${inst === MAIN ? "" : `, ${LABEL_INSTANCE}=${c.Config?.Labels?.[LABEL_INSTANCE] ?? "—"}`}) — not removed`);
    }
    let create = true;
    if (c && resumption) {
      // The continuation finds out what already happened: a container that matches the desired state IS the new one — or the old,
      // broken one (header "THE CONTINUATION"): if its restore fails, it may request one ONCE.
      try { create = !desiredActual({ inspect: c, ...(await desiredValues(pid, inst)), recognized: recognizedFor(row, c) }).equal; }
      catch (e) { console.warn(`[projectbox] recreation ${who(pid, inst)}: desired state not readable (${e?.message || e}) — recreate`); }
      if (!create) resumptionFree.add(k);
    }
    if (c && create) {
      const id = String(c.Id);
      // The stack as it runs — only from `ready` (header); else the last snapshot holds.
      if (priorReady && c.State?.Status === "running") { phase("desired"); await desiredWrite(pid, inst, row, id); }
      phase("stop");
      await docker(["stop", "-t", String(STOP_DEADLINE_S), id]);
      phase("remove");
      await docker(["rm", id]); // by id, without -f
    }
    if (create) {
      phase("creation");
      // A copy like the main — its rule table, its volume, its IP (the network of the row); the layer under `<data>/copies/…` is not
      // touched by the creation. The main without `instance` (as before).
      await createInstance(pid, { ...opts, ...(inst === MAIN ? {} : { instance: inst }), state: "recreate", occupancyHeld: true });
    }
    // Restore in the state of the recreation: stages from `desired`, native services, names, then `ready`.
    return await restoreInstance(pid, inst, { state: "recreate", occupancyHeld: true, reason: `recreation (${reason})`, root: opts.root });
  } catch (e) {
    const set = `recreation failed: ${e?.message || e}`;
    console.error(`[projectbox] ${who(pid, inst)}: ${set}`);
    try {
      if (!store.projectInstance(pid, inst)) return null; // deleted — the row does not come back here
      return setInstanceState(pid, inst, "error", { error: set });
    } catch (x) { console.error(`[projectbox] recreation ${who(pid, inst)}: state not set: ${x?.message || x}`); return null; }
  }
}

// ── The connectors to restore and turn ─────────────────────────────────────────────────────────────────────────────

/** Connector setRecreateRestartGrace of the restore (server.js): resumption and check time "restart grace" — per instance (a copy row
 *  checks ITS container against ITS desired state, not the main's). */
export const recreateRestartGraceSeam = Object.freeze({
  resume: (request) => resumeRecreate(request),
  check({ projectId, instance = MAIN } = {}) {
    const pid = String(projectId ?? "");
    if (!pid || !projectboxOps()) return undefined;
    let inst;
    try { inst = instanceFrom(instance); } catch { return undefined; }
    if (earmarked.has(identifierOf(pid, inst))) { attempts(pid, inst); return undefined; }
    return checkRecreate(pid, { cause: "restart grace", instance: inst });
  },
});

/** Connector runs/instance.js setTurnObserver (server.js). `beginning` returns the check — the turn waits for it at the end. The instance
 *  of the turn is checked (its identifier) — without one the main. */
export const recreateTurnObserver = Object.freeze({
  beginning({ projectId, identifier } = {}) {
    if (!projectId) return undefined;
    const pid = String(projectId);
    const t = typeof identifier === "string" && identifier.startsWith(`${pid}/`) ? parts(identifier) : null;
    return checkRecreate(pid, { cause: "turn start", ...(t && t.inst !== MAIN ? { instance: t.inst } : {}) });
  },
  end() {
    if (!earmarked.size) return;
    // After the rest of the turn end (queue, end of work): only then does the idle count.
    setImmediate(() => { for (const k of [...earmarked.keys()]) attemptsIdentifier(k); });
  },
});

/** On closing the server: earmarks, information and look-up gone (a new start checks anew). */
export function cleanUpRecreate() {
  earmarked.clear();
  last.clear();
  resumptionFree.clear();
  if (checkBack) { clearTimeout(checkBack); checkBack = null; }
}
