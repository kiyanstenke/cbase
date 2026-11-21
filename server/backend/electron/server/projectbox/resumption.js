// The observer of the project containers: restart past cbase, and a continuously updated desired state.
//
// THE FINDING. A project container (`cbase-p-<pid>`, also a copy `cbase-k-<pid>-<name>`) that ends PAST CBASE and starts again
// (`docker stop` + `docker start` by hand; the daemon restarts a crashed one or one killed by the OOM killer itself through
// `unless-stopped`) came back without its desired state: only the inner containers with a restart policy ran, and the instance row
// stood on `ready` the whole time. It was restored only in the restart grace of B.
//
// E1 — THE STREAM. `docker events --since <t> --filter type=container --filter label=cbase.project --format '{{json .}}'` as ONE
//   long-lived child through the docker seam (docker.js dockerStream). Only with the ops marker; started in the restart grace (hook
//   "restartGrace" "project-resumption", registered in server.js as the LAST of its kind — after the restore), ended in the hook
//   "serverEnd" (after the stop chain) and at `close` of the server. If the stream ends unexpectedly: restart after a growing pause
//   (RESTART_PAUSES_MS, capped at the last, each reported) with `--since` from the last seen (the daemon delivers the gap from its
//   buffer), and after EVERY (re)start a reconcile (E4). Helpers (label `cbase.helper`) and everything without a valid instance
//   assignment (no row, no `converted_at`, a name that is not the row's — run-instance.js containerOf) stay unnoticed. `oom` and
//   `kill` only go to the log.
// E2 — THE RESUMPTION. `die` of a project or copy container whose row stands on `ready`, without a living flow (instances.js
//   procedureAlive), not in an ending server (runs/server-end.js serverEnds), not frozen (docker.js isFrozen), without occupation
//   (instance.js projectOccupied/instanceOccupied), not older than the state of the row (`stateSince` — an event from BEFORE the
//   present `ready` says nothing about it) and without the marker "cbase stops itself" (docker.js selfStoppedSince) ⇒ restore.js
//   restoreInstance(pid, instance, { reason: "resumption" }): synchronous `start` (turns wait at the lock), the container is started
//   if it does not run (also after a manual `docker stop` — cbase owns these containers; whoever wants one permanently off takes the
//   way through cbase), then the desired-state reconcile in stages. A `start` of such a row (the daemon was faster than the `die`, or
//   the `die` fell into a gap) ⇒ the same way; a `start` first withdraws the markers "cbase stops itself" of this container that are
//   not younger than it (a new life) — likewise reconcile and tick on a running container withdraw the markers older than its
//   `State.StartedAt` (the `start` possibly fell into a gap). OCCUPIED, FROZEN, NO_INSTANCE etc. of the restore go to the log, never
//   as a throw. A No for a TRANSIENT reason (flow, occupation, frozen, server end) is remembered and looked up again at the next tick
//   (E3): if the row then still stands `ready` and the container does not, the resumption follows — otherwise a crash during a copy
//   build would stay unnoticed until the next start of B.
// E3 — THE DESIRED STATE, CONTINUOUSLY. A tick (default DESIRED_TICK_MS = 60 s, knob CBASE_PROJECT_DESIRED_MS, 0 = off — a pure test
//   knob: without a tick no catching up of remembered events; reported at start) reads one after the other (never in parallel) for
//   every `ready` row without flow, without occupation, not frozen, whose container runs, the inside (restore.js insideInspect) and
//   writes the desired state with serverEnd.js carryForwardDesired and withServicesOfNow to the same place as the server end (the
//   column `desired` of the instance row, store.changeProjectInstance). Written only if the container stayed THE SAME and running
//   while reading (State.StartedAt before = after, no event of its life cycle in between — otherwise the tick would read the inner
//   containers of a dying dockerd as `exited` and take the next resumption its desired state) and the row afterwards synchronously
//   still stands `ready` with the same `stateSince`. If reading fails: the old state stays. An EMPTY list never replaces a non-empty
//   one (a dockerd still booting may name nothing; a desired state with containers that no longer exist does no harm — the restore
//   starts only desired ∩ present). An unchanged state is not rewritten. A container that started AFTER the `ready` of its row
//   (`State.StartedAt` > `stateSince` — past cbase, its `start` was lost) gets no snapshot (its inside is the crash, not the intent)
//   but the look-up as in the reconcile (E4). The tick occupies nothing, sets no state and holds no turn (no `busy`).
// E4 — THE RECONCILE after every (re)start of the stream: every relocated `ready` row without flow whose container does not run
//   (`docker inspect` through the seam; `running`, `restarting` and `paused` count as running) or silently restarted after the row's
//   `ready` (`State.StartedAt` > `stateSince`: `die` and `start` both fell out of the buffer of the daemon) and does not carry the
//   marker "cbase stops itself" gets the resumption as in E2. One after the other. Then every relocated row in `stopped` (a human
//   stopped it, projectbox/instance-stop.js) whose container RUNS (a hard end of B in the middle of the stop, a start past cbase) —
//   it is stopped again with a notice (instance-stop.js keepTrackOfStopped), never silently `ready`. Verdict "stopped-running". The
//   stopped row itself is otherwise never touched by E2, E3 and E4 (they judge only `ready`: "state-stopped").
//
// THE STOP PLACES (E2: cbase's own stops NEVER trigger a resumption). Every stop of a container in the daemon of B goes through
// docker.js docker() and thus carries the marker "cbase stops itself" (set there, BEFORE the child). Beyond that, per place the reason
// why the row does not restart anyway — guard server/backend/test/projectbox-stop-places.test.js (a new place without a row there is
// red, a row without a place too):
//   file                          call                          row at the stop / protection next to the marker
//   projectbox/recreate.js      stop -t 30, rm (old one)      `recreate`, flow (withProcedure) and instance occupation "recreate"
//   projectbox/erase.js        stop -t 30, rm -f             `ready`, but project occupation "erase" (and the lock); an event AFTER a
//                                                               failed deletion is held by the marker alone (the rows then stay
//                                                               `ready`, containers stopped/removed)
//   projectbox/serverEnd.js      stop -t 30 (all)              serverEnds() (set before the hooks); the stream ends afterwards
//   projectbox/instance.js         rm -f (teardown of a creation, 2×) `create`/`recreate`, flow of the creation
//   projectbox/restore.js         stop -t 30 (old naming)       `start`/`recreate`, instance occupation "restore" and the flow of the
//                                                               restore; a container of an older release (not `cbp-<n>`),
//                                                               afterwards `error` with the recreate request
//   projectbox/setup/procedure.js stop -t 30, rm (rest)      only on "try again": row `error` or none, flow of the setup
//   projectbox/helper.js          stop -t 0, rm -f -v           a helper never carries `cbase.project` — not in the stream
//   projectbox/relocation/procedure.js    stop -t 30 (2×), rm, rm -f    the old compose containers in B (not in the stream); the new
//                                                               project container on the way back: `relocation`, flow of the relocation
//   stacks/dismantling.js            rm -f (copy)                  `create`/`clearAway`, flow resp. instance occupation of the teardown
//   stacks/clearAway.js           stop -t 30 (copy)             `clearAway`, flow and instance occupation "copy-clear-away"
//   stacks/remove.js           rm -f (orphaned copy)         no row (only orphans)
//   projectbox/instance-stop.js   stop -t 30 (by id)            "Stop" by a human — the row stands in `stopping` BEFORE the stop (flow,
//                                                               instance occupation "stop"), afterwards `stopped`; in the
//                                                               reconcile (below) the keeping track of a `stopped` row whose
//                                                               container ran — under the same occupation
//   services.js                   stop (localDocker)          WITHOUT marker (past docker(), DOCKER_CALLS_ALLOWED): the compose
//                                                               containers of a project WITHOUT an instance — they carry no
//                                                               `cbase.project`, not in the stream
//   server/gateway/containers.js exec -u agent B (script:        NOT in the backend, past docker(): stopProjectContainer (unhealthy B
//                                 docker stop -t 30)             in ensureRunning, destroy) FIRST sets the marker /run/cbase/b-ends by
//                                                                `exec -u root`, which serverEnds() (runs/server-end.js) counts like
//                                                                its own (root-owned, < 10 min); destroy() stops B only AFTERWARDS
//                                                                with `docker stop -t 60` (B runs its chain itself, it finds nothing)
//   server/backend/entry.sh       docker stop -t 30 (all)        at the start of B without network separation, before the backend: no
//                                                                observer; every start removes the marker b-ends
//   Not among them: `pause` (stacks/freeze.js — no `die`, the row is frozen), every stop IN the project container (dockerIn: the
//   inner daemon, not in the stream), the deploy (it stops B itself; the stream ends with B).
//   Own STARTS do trigger if the row stands `ready` without flow and occupation: today only the way back of a failed deletion
//   (erase.js againStart — under the occupation "erase"; if its `start` arrives only afterwards, the resumption brings back the
//   desired state that the bare `docker start` does not). The others (restore.js, relocation, helper) start in `start`/`relocation`
//   resp. without `cbase.project`, and a late `start` is `stale`.
//
// FURTHER GUARANTEES. A unmarked `die` during a living flow (state ≠ `ready`) is remembered with its event time (catching up); the
//   look-up counts a container that has started since as silently restarted; restore.js checkLiveness checks IMMEDIATELY before `ready`
//   including the desired state (id and State.StartedAt as on entering runInstanceUp) — otherwise no snapshot from a fresh dockerd, the
//   restore runs through once more (relocation and copy: desired state stays, resp. `error`). No catch-up iteration and no round
//   rejects (no unhandled promise). The marker of a FAILED stop expires on a running container after SELF_DEADLINE_MS (docker.js
//   expireSelfStopped, called in livenessBegan). The stop of the gateway sets the marker /run/cbase/b-ends (table above). In an ending
//   server (serverEnds) the restore starts no project container and does not run through again (restore.js procedureAttempt). A `die`
//   with reason `serverEnd` is transient (TRANSIENT) — if the foreign marker expires in a surviving B, the tick brings it back. A
//   container in the life confirmed by checkLiveness (restore.js livenessConfirmed) counts for the look-up with event time as not
//   silently restarted — the promise "exactly one resumption" holds also when the observer did not trigger it.
// INTERFACE
//   resumptionRestartGrace()     receiver "restartGrace": without the ops marker nothing; else stream and tick (once per process — a
//                               second call while they run does nothing). Returns undefined (the quiet does not wait).
//   stopResumption(reason)  end stream, restart and tick (hook "serverEnd" and `close` of the server).
//   resumptionVerdict(e, situation) PURE: the verdict on an event (E2), table in the guard.
//   desiredTickRound()             ONE pass of the tick (E3) — the timer calls it, the tests too.
//   restartPauseMs(attempt)    PURE: the pause before restart no. `attempt` (0-based).
//   Test seams: resumptionStatus() (numbers, last verdicts), resumptionQuiet() (waits for reconcile, tick and every triggered
//   resumption), advanceRestart() (the clock seam of the restart pause, pattern docker.js advanceCap).
// Guard: server/backend/test/projectbox-resumption.test.js, server/backend/test/projectbox-stop-places.test.js.
import * as store from "../store.js";
import { serverEnds } from "../runs/server-end.js";
import { MAIN, LABEL_INSTANCE, LABEL_PROJECT } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { docker, dockerStream, isFrozen, expireSelfStopped, selfStoppedSince, forgetSelfStopped } from "./docker.js";
import { LABEL_HELPER } from "./helper.js";
import { CALL_CAP_MS, instanceOccupied, projectOccupied } from "./instance.js";
import { procedureAlive } from "./instances.js";
import { containerOf } from "./run-instance.js";
import { withServicesOfNow, withoutSuperseded, carryForwardDesired } from "./serverEnd.js";
import { keepTrackOfStopped } from "./instance-stop.js";
import { insideInspect, livenessConfirmed, restoreInstance } from "./restore.js";

export const DESIRED_TICK_MS = 60_000;
// Knob CBASE_PROJECT_DESIRED_MS (integer ≥ 0; 0 = off), read at run time.
export function desiredTickMs() {
  const raw = process.env.CBASE_PROJECT_DESIRED_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : DESIRED_TICK_MS;
}
// ESTIMATED, NOT MEASURED: 1 s, 5 s, 15 s, then every minute — a stream that ends again at once (dockerd restarts) must not flood B
// with starts; a stream that ran long begins the series anew (STREAM_QUIET_MS).
export const RESTART_PAUSES_MS = Object.freeze([1_000, 5_000, 15_000, 60_000]);
export const STREAM_QUIET_MS = 60_000;
export const restartPauseMs = (attempt) => RESTART_PAUSES_MS[Math.min(Math.max(0, Number(attempt) || 0), RESTART_PAUSES_MS.length - 1)];
// How far `--since` reaches before the last seen (time in ms: the event itself and everything in the same second).
const SINCE_MARGIN_MS = 1_000;

const LIFE_LOG = new Set(["start", "restart", "kill", "die", "oom", "stop", "pause", "unpause", "destroy"]);
// `serverEnd` (in the own server end the observer ends anyway — stopResumption empties the look-up); the FOREIGN marker b-ends of the
// gateway, however, expires after ten minutes if B lives on (`rm -f` failed, the gateway restarted in the window) — then the look-up of
// the next tick brings the stopped containers back. The tick does not run while serverEnds() holds; a stop through docker() also
// carries the marker "cbase stops itself" (look-up).
const TRANSIENT = new Set(["procedure", "occupied", "frozen", "serverEnd"]);
const RUNNING = new Set(["running", "restarting", "paused"]);
const missing = (e) => /No such (object|container)|not found/i.test(`${e?.stderr || ""}\n${e?.message || ""}`);
const short = (e) => String(e?.message || e || "").split("\n")[0].slice(0, 300);

// ── The pure verdict (E2) ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * `event` { action: "die"|"start", time (ms) }, `situation` { row, nameMatches, ends, selfSince, procedure, frozen, occupied }
 * → { yes, reason }. The order of the checks is that of the reasons in the log.
 */
export function resumptionVerdict(event, situation) {
  const no = (reason) => ({ yes: false, reason });
  const z = situation?.row;
  if (!z) return no("no-row");
  if (!z.convertedAt) return no("not-converted");
  if (!situation.nameMatches) return no("foreign-name");
  if (situation.ends) return no("serverEnd");
  const time = Number(event?.time);
  if (event?.action === "die" && situation.selfSince !== null && situation.selfSince !== undefined && (!Number.isFinite(time) || situation.selfSince <= time)) return no("self-stopped");
  if (z.state !== "ready") return no(`state-${z.state}`);
  if (Number.isFinite(time) && Number.isFinite(Number(z.stateSince)) && time < Number(z.stateSince)) return no("stale");
  if (situation.procedure) return no("procedure");
  if (situation.frozen) return no("frozen");
  if (situation.occupied) return no("occupied");
  return { yes: true, reason: event?.action === "start" ? "start" : "end" };
}

// ── State of the process ────────────────────────────────────────────────────────────────────────────────────────────

let run = null; // { aus, stream, attempt, restart, restartRun, tick, startedAt, untilSeen, reconcile, round, tickMs }
const disquiet = new Map(); // container id → counter of the life-cycle events (E3: the tick compares before/after)
const catchUp = new Map(); // identifier → { projectId, instance, time? } — a No for a transient reason (header, E2); `time` (ms): an unmarked `die` during a living flow
const open = new Set(); // triggered resumptions (test seam resumptionQuiet)
const verdicts = []; // the last verdicts (test seam, diagnosis)
const snapshot = { streams: 0, restarts: 0, events: 0, resumptions: 0, reconcile: 0, tickRounds: 0, desiredWritten: 0 };

function remember(entry) {
  verdicts.push({ ...entry, at: Date.now() });
  if (verdicts.length > 200) verdicts.shift();
}

const disquietOf = (id) => disquiet.get(String(id || "")) || 0;
function disquietCount(id) {
  const k = String(id || "");
  if (!k) return;
  disquiet.set(k, disquietOf(k) + 1);
  if (disquiet.size > 1000) disquiet.delete(disquiet.keys().next().value);
}

/** Numbers and the last verdicts (test seam; no way of the UI). */
export function resumptionStatus() {
  return {
    ...snapshot,
    running: Boolean(run && !run.ended),
    streamOpen: Boolean(run?.stream),
    restartScheduled: Boolean(run?.restart),
    nextPauseMs: run ? restartPauseMs(run.attempt) : null,
    tickMs: run ? run.tickMs : null,
    catchUp: [...catchUp.keys()],
    tickScheduled: Boolean(run?.tick),
    verdicts: verdicts.map((u) => ({ ...u })),
  };
}

/** Waits until reconcile, tick round and every triggered resumption are done (test seam; never throws). */
export async function resumptionQuiet() {
  for (;;) {
    const wait = [run?.reconcile, run?.round, ...open].filter(Boolean);
    if (!wait.length) return;
    await Promise.allSettled(wait);
  }
}

/** Test seam: set an entry of the look-up without the detour through an event. */
export function resumptionCatchUpRemember(projectId, instance = MAIN, time) {
  catchUp.set(store.instanceIdentifier(projectId, instance), { projectId, instance, ...(time === undefined ? {} : { time }) });
}

/** Clock seam: a scheduled restart of the stream runs AT ONCE (the product never calls it). → 1 or 0. */
export function advanceRestart() {
  if (!run?.restart) return 0;
  run.restartRun();
  return 1;
}

// ── Start and stop ──────────────────────────────────────────────────────────────────────────────────────────────────

export function resumptionRestartGrace() {
  if (!projectboxOps()) return undefined;
  if (run && !run.ended) return undefined;
  const l = { ended: false, stream: null, attempt: 0, restart: null, restartRun: null, tick: null, startedAt: 0, untilSeen: Date.now(), reconcile: null, round: null, tickMs: desiredTickMs() };
  run = l;
  console.log(`[projectbox] resumption: observer started (docker events, label ${LABEL_PROJECT}); tick of the desired state ${l.tickMs ? `every ${l.tickMs} ms` : "off (CBASE_PROJECT_DESIRED_MS=0)"}`);
  startStream(l, "start");
  tickSchedule(l);
  return undefined;
}

export function stopResumption(reason = "") {
  const l = run;
  if (!l || l.ended) return false;
  l.ended = true;
  clearTimeout(l.restart);
  l.restart = null;
  clearTimeout(l.tick);
  l.tick = null;
  const s = l.stream;
  l.stream = null;
  s?.stop();
  catchUp.clear();
  console.log(`[projectbox] resumption: observer ended${reason ? ` (${reason})` : ""}`);
  return true;
}

const EVENTS_ARGS = (sinceMs) => [
  "events", "--since", (Math.max(0, sinceMs) / 1000).toFixed(3),
  "--filter", "type=container", "--filter", `label=${LABEL_PROJECT}`, "--format", "{{json .}}",
];

function startStream(l, cause) {
  if (l.ended) return;
  if (!projectboxOps()) { console.warn(`[projectbox] resumption: no stream without the ops marker (${cause})`); return; }
  const since = l.untilSeen - SINCE_MARGIN_MS;
  let s = null;
  try {
    s = dockerStream(EVENTS_ARGS(since), { row: (z) => rowSeen(l, z), end: (r) => streamEnd(l, s, r) });
  } catch (e) {
    console.error(`[projectbox] resumption: docker events not started (${short(e)})`);
    restartSchedule(l);
    return;
  }
  l.stream = s;
  l.startedAt = Date.now();
  snapshot.streams += 1;
  // E4: after EVERY (re)start a reconcile — what happened between two streams and is no longer in the buffer of the daemon.
  const a = reconcile(l, cause).catch((e) => console.error(`[projectbox] resumption: reconcile (${cause}) ${short(e)}`));
  l.reconcile = a;
  a.finally(() => { if (l.reconcile === a) l.reconcile = null; });
}

function streamEnd(l, s, r) {
  if (l.stream !== s) return;
  l.stream = null;
  if (l.ended || r?.stopped) return;
  if (Date.now() - l.startedAt >= STREAM_QUIET_MS) l.attempt = 0;
  const reason = r?.error ? short(r.error) : `exit ${r?.code ?? "—"}${r?.signal ? `, ${r.signal}` : ""}${r?.stderr ? `: ${String(r.stderr).trim().split("\n")[0].slice(0, 200)}` : ""}`;
  console.error(`[projectbox] resumption: docker events ended unexpectedly (${reason})`);
  restartSchedule(l);
}

function restartSchedule(l) {
  if (l.ended || l.restart) return;
  const ms = restartPauseMs(l.attempt);
  const seq = l.attempt + 1;
  l.attempt += 1;
  snapshot.restarts += 1;
  console.error(`[projectbox] resumption: restart ${seq} of the stream in ${ms} ms${ms === RESTART_PAUSES_MS[RESTART_PAUSES_MS.length - 1] ? " (cap of the pause)" : ""} — a reconcile follows`);
  const go = () => {
    if (!l.restart) return;
    clearTimeout(l.restart);
    l.restart = null;
    l.restartRun = null;
    startStream(l, `restart ${seq}`);
  };
  l.restartRun = go;
  l.restart = setTimeout(go, ms);
  l.restart.unref?.();
}

// ── The events (E1, E2) ─────────────────────────────────────────────────────────────────────────────────────────────

// The time of an event in ms — from `timeNano` in the RAW text (read as a number it would lose the last millisecond), else
// `time` (seconds).
function timeFrom(text, ev) {
  const m = /"timeNano"\s*:\s*"?(\d+)/.exec(text);
  if (m) { try { return Number(BigInt(m[1]) / 1_000_000n); } catch { /* below */ } }
  const s = Number(ev?.time);
  return Number.isFinite(s) ? s * 1000 : NaN;
}

function rowSeen(l, text) {
  if (l.ended) return;
  let ev;
  try { ev = JSON.parse(text); } catch { console.warn(`[projectbox] resumption: row without JSON skipped (${text.slice(0, 120)})`); return; }
  snapshot.events += 1;
  const time = timeFrom(text, ev);
  if (Number.isFinite(time) && time > l.untilSeen) l.untilSeen = time;
  try { event(ev, time); } catch (e) { console.error(`[projectbox] resumption: event not processed (${short(e)})`); }
}

function event(ev, time) {
  if (String(ev?.Type || "") !== "container") return;
  const action = String(ev.Action || ev.status || "").split(":")[0].trim();
  const a = ev.Actor?.Attributes || {};
  const id = String(ev.Actor?.ID || ev.id || "");
  const name = String(a.name || "");
  if (LIFE_LOG.has(action)) disquietCount(id);
  // A new life: the marker "cbase stops itself" no longer holds (header, E2) — only markers that are not younger.
  if (action === "start") forgetSelfStopped([id, name].filter(Boolean), Number.isFinite(time) ? time : Infinity);
  if (Object.hasOwn(a, LABEL_HELPER)) return;
  const pid = String(a[LABEL_PROJECT] || "");
  if (!pid) return;
  const instance = String(a[LABEL_INSTANCE] || MAIN);
  if (action === "oom" || action === "kill") {
    remember({ action, name, id, identifier: store.instanceIdentifier(pid, instance), yes: false, reason: "only-log", signal: a.signal ?? null });
    console.log(`[projectbox] resumption: ${action} ${name || id.slice(0, 12)}${a.signal ? ` (signal ${a.signal})` : ""} — log only`);
    return;
  }
  if (action !== "die" && action !== "start") return;
  let row = null;
  let nameMatches = false;
  try {
    row = store.projectInstance(pid, instance) || null;
    nameMatches = Boolean(row) && containerOf(row) === name;
  } catch (e) { console.warn(`[projectbox] resumption: ${action} ${name}: row not readable (${short(e)})`); return; }
  const situation = {
    row, nameMatches, ends: serverEnds(),
    selfSince: action === "die" ? (selfStoppedSince(id) ?? selfStoppedSince(name)) : null,
    procedure: procedureAlive(pid, instance), frozen: isFrozen(name) || isFrozen(id),
    occupied: Boolean(projectOccupied(pid) || instanceOccupied(pid, instance)),
  };
  const u = resumptionVerdict({ action, time }, situation);
  const identifier = store.instanceIdentifier(pid, instance);
  remember({ action, name, id, identifier, yes: u.yes, reason: u.reason, exitCode: a.exitCode ?? null });
  if (!u.yes) {
    if (TRANSIENT.has(u.reason)) catchUp.set(identifier, { projectId: pid, instance });
    // An UNMARKED `die` during a living flow (state `start`, `recreate`, `relocation`, `create` …): the flow then writes `ready` and
    // hides it. Remember it like `procedure`, with the event time — the look-up counts a container that has started since as
    // silently restarted. (A `start` is cbase's own way and never a reason.)
    else if (action === "die" && situation.procedure && u.reason.startsWith("state-")) catchUp.set(identifier, { projectId: pid, instance, time: Number.isFinite(time) ? time : Date.now() });
    if (!["no-row", "not-converted", "foreign-name"].includes(u.reason)) {
      console.log(`[projectbox] resumption: ${action} ${name}${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ""} — no resumption (${u.reason})`);
    }
    return;
  }
  catchUp.delete(identifier);
  resumption(pid, instance, `${action === "die" ? `end${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ""}` : "start"} past cbase`);
}

function resumption(pid, instance, cause) {
  snapshot.resumptions += 1;
  console.log(`[projectbox] resumption ${store.instanceIdentifier(pid, instance)}: ${cause} — restore`);
  let p;
  try {
    p = restoreInstance(pid, instance, { reason: "resumption" });
  } catch (e) { p = Promise.reject(e); }
  const q = Promise.resolve(p).then(
    (row) => {
      console.log(`[projectbox] resumption ${store.instanceIdentifier(pid, instance)}: ${row?.state ?? "row gone"}${row?.error ? ` — ${row.error}` : ""}`);
      // A `ready` that checkLiveness confirmed covers the unmarked `die` that came DURING this flow — they need no second look-up
      // (only entries with an event time; a transient No stays).
      const entry = catchUp.get(store.instanceIdentifier(pid, instance));
      if (row?.state === "ready" && entry?.time !== undefined && entry.time <= Number(row.stateSince)) catchUp.delete(store.instanceIdentifier(pid, instance));
      return row;
    },
    (e) => { console.warn(`[projectbox] resumption ${store.instanceIdentifier(pid, instance)}: not begun (${e?.code ? `${e.code}: ` : ""}${short(e)})`); return null; },
  );
  open.add(q);
  q.finally(() => open.delete(q));
  return q;
}

// ── The reconcile (E4) and the look-up (E2, transient reasons) ───────────────────────────────────────────────────────

// Does the row stand NOW so that a resumption comes into question (without a look at the container)? → reason of the No or null.
function upfrontNo(z) {
  if (!z?.convertedAt) return "not-converted";
  if (z.state !== "ready") return `state-${z.state}`;
  if (serverEnds()) return "serverEnd";
  if (procedureAlive(z.projectId, z.instance)) return "procedure";
  if (projectOccupied(z.projectId) || instanceOccupied(z.projectId, z.instance)) return "occupied";
  let name;
  try { name = containerOf(z); } catch { return "foreign-name"; }
  if (isFrozen(name) || (z.containerId && isFrozen(z.containerId))) return "frozen";
  return null;
}

// A marker "cbase stops itself" that is OLDER than the start of the running life no longer holds (the `start` in between possibly
// fell into a gap of the stream) — a younger one stays: it belongs to a stop that is running right now.
function livenessBegan(c, name) {
  const since = Date.parse(String(c?.State?.StartedAt || ""));
  const who = [String(c?.Id || ""), name].filter(Boolean);
  if (Number.isFinite(since) && since > 0) forgetSelfStopped(who, since);
  // The marker of a FAILED stop (the container does run) no longer holds after stop cap + margin.
  expireSelfStopped(who);
}

// Did the container start AFTER the row became `ready`? Every way of cbase that starts a project container does so in another state
// (restore, creation, recreation, relocation) and sets `ready` afterwards; a start afterwards went past cbase — its `start` (and the
// `die` before) fell into a gap of the stream that `--since` no longer closes (the buffer of the daemon). The only own exception: the
// way back of a failed deletion (header, stop places) — there the resumption is just as right. Only `running` (a `restarting` belongs
// to the daemon and comes through its event).
function stillNewStarted(c, z) {
  const since = Date.parse(String(c?.State?.StartedAt || ""));
  const readySince = Number(z?.stateSince);
  return c?.State?.Status === "running" && Number.isFinite(since) && Number.isFinite(readySince) && readySince > 0 && since > readySince;
}

async function readContainer(name) {
  try { return JSON.parse((await docker(["inspect", "--type", "container", name], { capMs: CALL_CAP_MS })).stdout || "[]")[0] || null; }
  catch (e) { if (missing(e)) return null; throw e; }
}

// Look up one row: if its container does not run (or silently restarted — stillNewStarted), carries no marker "cbase stops itself"
// and the row afterwards still stands the same ⇒ the resumption is TRIGGERED (not awaited: the restore of one instance takes up to
// stages × cap, the reconcile of the others does not stand behind it). → whether triggered.
async function checkBack(z, cause, { sinceTime } = {}) {
  if (upfrontNo(z)) return false;
  const name = containerOf(z);
  let c;
  try { c = await readContainer(name); }
  catch (e) { console.warn(`[projectbox] resumption (${cause}): ${name} not readable (${short(e)}) — nothing triggered`); return false; }
  let status = String(c?.State?.Status || "");
  if (c && RUNNING.has(status)) {
    livenessBegan(c, name); // its `start` possibly fell into a gap of the stream
    // An unmarked `die` during a living flow (sinceTime) — if the container has run since, it started anew. Unless a start sequence
    // confirmed exactly this life (restore.js checkLiveness) — then it is already restored, whichever way the restore came.
    const sinceThe = Number.isFinite(sinceTime) && Date.parse(String(c?.State?.StartedAt || "")) >= sinceTime - SINCE_MARGIN_MS && c?.State?.Status === "running"
      && !livenessConfirmed(c?.Id, c?.State?.StartedAt);
    if (!stillNewStarted(c, z) && !sinceThe) return false;
    status = "silently restarted";
  }
  const itself = selfStoppedSince(c?.Id) ?? selfStoppedSince(z.containerId) ?? selfStoppedSince(name);
  if (itself !== null) {
    remember({ action: "reconcile", name, id: String(c?.Id || ""), identifier: z.identifier, yes: false, reason: "self-stopped" });
    console.log(`[projectbox] resumption (${cause}): ${name} stands (${status || "missing"}), cbase stopped it itself — no resumption`);
    return false;
  }
  const now = store.projectInstance(z.projectId, z.instance);
  if (!now || now.stateSince !== z.stateSince || upfrontNo(now)) return false; // meanwhile moved — its way holds
  remember({ action: "reconcile", name, id: String(c?.Id || ""), identifier: z.identifier, yes: true, reason: status || "missing" });
  resumption(z.projectId, z.instance, `${cause}: container ${status || "missing"}`);
  return true;
}

async function reconcile(l, cause) {
  snapshot.reconcile += 1;
  let rows = [];
  try { rows = store.projectInstancesInState(["ready"]).filter((z) => z.convertedAt); }
  catch (e) { console.error(`[projectbox] resumption: reconcile (${cause}) — instances not readable (${short(e)})`); return; }
  let n = 0;
  for (const z of rows) { // one after the other (E4)
    if (l.ended) return;
    if (await checkBack(z, `reconcile after ${cause}`)) n += 1;
  }
  if (n) console.log(`[projectbox] resumption: reconcile after ${cause} — ${n} instance(s) triggered`);
  // (Header E4): a stopped row whose container runs is stopped again.
  let stopped = [];
  try { stopped = store.projectInstancesInState(["stopped"]).filter((z) => z.convertedAt); }
  catch (e) { console.error(`[projectbox] resumption: reconcile (${cause}) — stopped instances not readable (${short(e)})`); return; }
  for (const z of stopped) {
    if (l.ended) return;
    const name = containerOf(z);
    let c;
    try { c = await readContainer(name); }
    catch (e) { console.warn(`[projectbox] resumption (reconcile after ${cause}): ${name} not readable (${short(e)}) — stopped stays unchecked`); continue; }
    if (!c || !RUNNING.has(String(c?.State?.Status || ""))) continue;
    remember({ action: "reconcile", name, id: String(c?.Id || ""), identifier: z.identifier, yes: false, reason: "stopped-running" });
    await keepTrackOfStopped(z, c);
  }
}

// ── The tick (E3) ───────────────────────────────────────────────────────────────────────────────────────────────────

function tickSchedule(l) {
  if (l.ended || !l.tickMs) return;
  l.tick = setTimeout(() => {
    l.tick = null;
    desiredTickRound().catch((e) => console.error(`[projectbox] desired tick: round rejected (${short(e)})`)).finally(() => tickSchedule(l));
  }, l.tickMs);
  l.tick.unref?.();
}

const desiredText = (desired) => JSON.stringify({ container: (desired?.container || []).map(({ name, id, service, project, state, exitCode, dependsOn, failed }) => ({ name, id, service, project, state, exitCode, dependsOn, failed: Boolean(failed) })), services: desired?.services || [] });

async function desiredOneRow(z) {
  if (upfrontNo(z)) return "upfront";
  const name = containerOf(z);
  let c;
  try { c = await readContainer(name); } catch (e) { console.warn(`[projectbox] desired tick ${z.identifier}: ${name} not readable (${short(e)}) — the old desired state stays`); return "not-readable"; }
  if (c?.State?.Status !== "running") return "stands";
  livenessBegan(c, name);
  // If it restarted past cbase, its inside is not the intent but what the resumption is meant to restore — no snapshot but the
  // look-up (it triggers it).
  if (stillNewStarted(c, z)) { await checkBack(z, "tick"); return "newly-started"; }
  const id = String(c.Id || "");
  const since = c.State?.StartedAt;
  const disquietPrior = disquietOf(id);
  let inspect;
  try { inspect = await insideInspect(id); }
  catch (e) { console.warn(`[projectbox] desired tick ${z.identifier}: the inside not readable (${short(e)}) — the old desired state stays`); return "not-readable"; }
  // The same container, running, without an event of its life cycle in between (header, E3).
  let c2;
  try { c2 = await readContainer(id); } catch (e) { console.warn(`[projectbox] desired tick ${z.identifier}: ${short(e)} — the old desired state stays`); return "not-readable"; }
  if (c2?.State?.Status !== "running" || c2.State?.StartedAt !== since || disquietOf(id) !== disquietPrior) {
    console.log(`[projectbox] desired tick ${z.identifier}: the container moved while reading — the old desired state stays`);
    return "unquiet";
  }
  const now = store.projectInstance(z.projectId, z.instance);
  if (!now || now.stateSince !== z.stateSince || upfrontNo(now)) return "moved";
  const fresh = carryForwardDesired(now.desired, withoutSuperseded(z.projectId, inspect));
  if (!fresh.container.length && (now.desired?.container?.length || 0) > 0) {
    console.warn(`[projectbox] desired tick ${z.identifier}: read empty, the desired state names ${now.desired.container.length} containers — the old desired state stays`);
    return "empty";
  }
  const desired = withServicesOfNow(z.projectId, z.instance, fresh);
  if (desiredText(desired) === desiredText(now.desired)) return "equal";
  store.changeProjectInstance(z.projectId, z.instance, { desired });
  snapshot.desiredWritten += 1;
  return "written";
}

/** ONE pass of the tick (header, E3): first the look-up of the remembered Nos, then the desired state per row. → { per identifier: result }. */
export function desiredTickRound() {
  if (run?.round) return run.round;
  const l = run;
  const p = (async () => {
    const result = {};
    if (!projectboxOps() || serverEnds()) return result;
    snapshot.tickRounds += 1;
    // The look-up (E2, transient reasons): the identifier is remembered, the row of now is read.
    for (const [identifier, { projectId, instance, time }] of [...catchUp]) {
      if (l?.ended) break;
      // A throw (SQLITE_BUSY, closed DB, an error of the look-up) NEVER lets the round reject — the entry stays for the next tick.
      try {
        const z = store.projectInstance(projectId, instance);
        const reason = z ? upfrontNo(z) : "no-row";
        if (reason && (TRANSIENT.has(reason) || (time !== undefined && reason.startsWith("state-") && procedureAlive(projectId, instance)))) continue; // still transient — the next tick
        catchUp.delete(identifier);
        if (!reason) await checkBack(z, "tick: caught up", { sinceTime: time });
      } catch (e) { console.error(`[projectbox] desired tick: look-up ${identifier} — ${short(e)} — the entry stays for the next tick`); }
    }
    let rows = [];
    try { rows = store.projectInstancesInState(["ready"]).filter((z) => z.convertedAt); }
    catch (e) { console.error(`[projectbox] desired tick: instances not readable (${short(e)})`); return result; }
    for (const z of rows) {
      if (l?.ended || serverEnds()) break;
      try { result[z.identifier] = await desiredOneRow(z); }
      catch (e) { result[z.identifier] = "error"; console.error(`[projectbox] desired tick ${z.identifier}: ${short(e)} — the old desired state stays`); }
    }
    return result;
  })();
  if (l) {
    l.round = p;
    p.finally(() => { if (l.round === p) l.round = null; }).catch(() => {}); // no unhandled rejection from this chain
  }
  return p;
}
