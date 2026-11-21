// Freezing and volume clone of a copy. ONE step of the build: the queue calls it after it has set the copy to
// `build`/`clone1`; afterwards the build creates the copy container.
//
// freeze(copyId, { home, system, data }) → result (see below)
//   PRECONDITIONS (otherwise it throws without touching anything — a bug of the caller, not a failure of the copy):
//   ops marker; the row in `build`/`clone1`; the project occupancy “copy” held (projectbox/instance.js withProjectOccupancy —
//   the caller); the instance row `copy-<name>` in `create` (stacks/state.js created it with `build`); main `ready` and
//   converted. `home`/`system`/`data` are test seams (default: the home of B, SYSTEM_PATHS, DIRS.data).
//   THE PROCEDURE — BEFORE each step it is in the copy's journal (section `freeze`, stacks/state.js copyJournal; `part` = the
//   step, plus what it creates, BEFORE it creates it). The step markers of the journal belong to the caller — only the
//   section is written here:
//     location  the copy's folder below the data folder including `open/` (stacks/objects.js createCopyLocation — an existing
//               one is an error)
//     volume    the copy's volume with the labels LABEL_PROJECT and LABEL_INSTANCE — an existing one is an error, it does not
//               belong to this build
//     helper    the clone helper (projectbox/helper.js, kind `clone`; helper labels only): main's volume read-only at `/src`,
//               the copy's volume at `/dst`, the project folder rw at its original path, the runtime folder rw (pgid file of
//               the wrapper), `open/` rw, `/usr/local/bin` read-only (cbase-clone and node), `~/.gitconfig` read-only
//     projectRepo  if the project folder carries no project repo (relocated empty), is no repo itself, lies in none and is
//               no longer empty, the repo is created now in the helper (code-snapshot.js projectRepoBeforeCopy, first commit
//               “Project repo created before copy <name>”) — it STAYS even if the copy fails afterwards (like the commit
//               “State before copy”). In the journal as `projectRepo: { created, commit | reason }`.
//     inspect1  all inner containers and volumes of main (dockerIn); phase-1 volumes are those that NO running container
//               mounts (so never a volume shared by a stopped and a running one); into the journal with mounts and
//               `State.StartedAt` per container and the begin of phase 1. The begin is taken BEFORE the `ps`, together with
//               main's own `State.StartedAt` (a mount between `ps` and begin would otherwise fall out of the event window; a
//               restarted main has a new dockerd with an empty buffer)
//     clone1    `cbase-clone copy --phase 1 /src /dst --volumes … --upfront …` while main runs, then `fadvise` on the target
//               and the phase-1 source (`list --phase 1`, WITHOUT the upfront volumes — their source is alive). The copy moves
//               to `build`/`freeze`. `--upfront` are the volumes a running container mounts (all except the phase-1
//               volumes) — they come now already so that the pause does not copy whole databases; phase 1 reports the begin
//               of this upfront copy (`upfront_begin_ns`), kept in the journal as `phase1.upfront`/`phase1.upfrontSince` (ns
//               as text — a number would lose the last digits). The program copies them in a cp of their own and tolerates
//               its messages (a service deletes between readdir and lstat); their count (`upfront_error`) is
//               `phase1.upfrontError` in the journal.
//     lock      `serverEnds()` checked, lock “freeze” (projectbox/idle.js: no new turn of main)
//     services  per registered native service of main (with a start command; “native” is decided by the run — without a
//               container always, with a registered container only if that one does not run and the service does anyway) run
//               and port — through the hook setNativeServicesStatus (server.js: projectbox/services.js nativeServicesStatus)
//               BEFORE the barrier (the probe goes into main by exec and would wait for itself at the closed barrier). In the
//               journal as `services: [{ id, name, port, running }]`; the services of the desired state are EXACTLY the
//               running ones — never main's desired state, which keeps a crashed service. Without the hook `services: null`
//               (unchecked), and no native service starts in the copy (empty is not unknown: never “all from the desired state”).
//     pause     marker in the journal, then `pause(<main>, { beforePause })` (projectbox/docker.js). The barrier is closed
//               from the entry on; `beforePause` (the container still runs):
//                 - waits until no management git runs in main any more (runtime/git-run.js commandsPast; cap
//                   CBASE_COPY_GIT_MS with a message — then there is NO pause and the copy fails). A git that got frozen
//                   would hold `index.lock` and half-written files; the snapshot would see them.
//                 - the desired state — `inspect` of all inner containers immediately before the pause (form
//                   desiredFromInspect, the native services from the step `services`), raw through docker() (dockerIn would
//                   wait at its own barrier);
//                 - `--again` = every phase-1 volume that a running container mounts now, whose container started since
//                   phase 1 (StartedAt), is new or disappeared, that disappeared itself, OR that was mounted since the begin
//                   of phase 1 (`docker events` type=volume event=mount — the only way to see a `--rm` container that ran in
//                   between and is gone). If the answer may be incomplete, EVERY phase-1 volume goes into `--again` — see
//                   mountEvents (measured by the oldest event in the buffer and the start of main, not by the length of the
//                   answer);
//                 - the candidates of the policy protection — every container that does NOT run at freeze time and whose
//                   policy is `always`, `unless-stopped` or `on-failure` (a fresh dockerd starts all three). “Runs” means
//                   `running`/`restarting` as in the desired state — a paused inner container does NOT run (the copy's
//                   dockerd sets it to stopped on restore and would start it through its policy).
//               Desired state, again and candidates are in the journal before the `pause` goes out. The end of the recheck
//               window is only taken AFTER the `pause`.
//     code      the code snapshot (stacks/code-snapshot.js; section `code` of the journal)
//     clear     the helper without any process of main: `stop -t 0` + `start` (projectbox/helper.js emptyHelper) — whatever a
//               hook, fsmonitor or filter of main set loose in the helper ends with its PID 1; then per tar in `open/` size,
//               inode and times against the checked ones (code-snapshot.js checkOpenAfterClear) — otherwise the cap would
//               hold for a tar that someone replaces afterwards. Before clone2: no process of main sees `/dst`.
//     clone2    the copy moves to `build`/`clone2`; `copy --phase 2 /src /dst --volumes … --again … --reconcile … --since …`
//               (the program empties the `--again` volumes in the target itself and RECONCILES the upfront volumes: only
//               what changed since the begin of the upfront copy is replaced — server/backend/cbase-clone, header)
//     thaw      IN the finally: `thawOut` — checked through `inspect .State.Paused` (docker.js); the lock drops afterwards.
//               If it fails, the watchdog of docker.js thaws later, and the copy fails with the reason “thaw: …”
//               (dismantling while main is still frozen — it does not touch main).
//     recheck   (after thawing) `docker events` from the desired state to the pause: a phase-1 volume that was mounted in
//               this window and was not in `--again` invalidates the copy (it fails instead of carrying an old state) — the
//               window between desired state and `pause` is small but not empty. Likewise an answer that does not safely
//               cover the window.
//     policy    `cbase-clone policy-protection /dst <ids>`: the old policies into the journal (the build restores them
//               after the start)
//     fadvise   `fadvise /dst` (never the living source)
//     helper-gone  the helper removed by id
//   RESULT { desired, policy: { <id>: RestartPolicy }, again, phase1: { begin, volumes, upfront }, code, services (see
//     `services`; null = unchecked), times: { clone1Ms, pauseMs, clone2Ms }, template? ({ name, instance } — only from a
//     template) } — the same is in the journal (section `freeze`: desired, again, policy.old, phase1). The copy stands in
//     `build`/`clone2`, its volume is filled, its location carries `objects/`, `layer/*/.git`, `open/`, `snapshot.json`; the
//     helper is gone, main thawed, the lock released.
//   FAILURE at any point (also on a full disk): thaw (if `pause` was called — also a `pause` that failed at the cap but took
//     effect at the daemon), release the lock, THEN dismantlingClone (helper, the copy's volume — only if this build created
//     it —, the location — only if this build created it — including the root helper, last the instance row), the copy
//     `error` with the reason. Then throws `CopyError` (`code: "COPY_BUILD"`, `part`, `dismantled`). The wake-up call to the
//     chat is made through the event `project/copy` (the setter sends it).
//   HEAVY LOAD: if the caller already holds the lock “copy-clone” for this copy, it stays that way; otherwise freeze takes it
//   itself (projectbox/heavyLoad.js — an occupied one throws HeavyLoadOccupied, BEFORE any step) and releases it at the end.
//
// dismantlingClone({ projectId, name, volume, location, helperId, data }) → { removed: [..], error: [..] }
//   The dismantling of what this step creates, usable ON ITS OWN (resuming a half build after a restart): the helper by id
//   (only a helper — removeHelper checks the label), the copy's volume only with the labels of THIS instance, the copy's
//   location (stacks/objects.js removeCopyLocation — root helper for root-owned leftovers; ONLY if the clone helper is gone:
//   otherwise the location stays and `error` names it), last the instance row — ONLY if everything before it is gone (the
//   row records what was left standing; the caller sets the copy to `error`, and stacks/state.js takes the row along to
//   `error`). `volume`/`location` = true means “this build created it” (from the journal); without the value the label or
//   the location counts as proof. Never throws; what fails is in `error`.
//
// COPY FROM A COPY. If the copy carries a `baseInstance` ≠ main, the SOURCE is that instance — the TEMPLATE, a ready copy
// of the same project —, not main. The same steps with three differences; everything else (volume clone, desired state,
// again, recheck, policy protection, pause and thawing) applies to the template instead of main:
//   - PRECONDITION instead of “main ready”: main converted (row with `converted_at` — it is not touched, its project folder
//     stays the lower layer), the template `ready` as a copy AND as an instance row (otherwise 409 TEMPLATE_NOT_READY).
//   - THE HELPER mounts the volumes of the template (`/src`, read-only) and of the copy (`/dst`), `layer/` of the template
//     read-only and the root of the new copy rw at the same path, plus `/usr/local/bin` — no project folder, no `open/`, no
//     `.gitconfig`: no git runs in it. The step `projectRepo` is skipped (`projectRepo: { created: false, reason:
//     "template" }`).
//   - TAKING OVER THE UPPER LAYER instead of the code snapshot: in `clone1` after the volume `cbase-clone layer --phase 1
//     <layer of the template> <layer of the copy>` (its begin `layer_begin_ns` as `phase1.layerSince` into the journal —
//     without it the copy fails, there is no default); then `code` BEFORE the lock (code-snapshot.js templateSnapshot: refs
//     INSIDE the running template, objects as hard links to those of the template, `snapshot.json` with `template`); in
//     the pause no `code` and no `clear` (no process of the template ran in the helper), in `clone2` after the volume
//     `cbase-clone layer --phase 2 … --since <layerSince>` (reconciling what the template changed since phase 1). The post-work
//     after thawing is that of the template.
//   Afterwards the new copy reads nothing from the template's location any more: the template may be cleared away while the
//   new copy lives.
//
// Test seams: CBASE_COPY_ERROR_AT=<part> (a forced error BEFORE the step), CBASE_COPY_<KIND>_MS (caps, see FREEZE_CAP);
// `system.usrLocalBin` (the source of /usr/local/bin in the helper — cbase-clone and node live there).
// Guard: server/backend/test/stacks-freeze.test.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { DIRS } from "../app-state.js";
import { MAIN, LABEL_INSTANCE, LABEL_PROJECT, SYSTEM_PATHS, containerName, copyInstance, copyNameOf, volumeName } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { docker, dockerIn, pause, thawOut } from "../projectbox/docker.js";
import { removeHelper, executeHelper, emptyHelper, startHelper } from "../projectbox/helper.js";
import { projectOccupied } from "../projectbox/instance.js";
import { runInstance } from "../projectbox/run-instance.js";
import { projectLocks } from "../projectbox/idle.js";
import { occupyHeavyLoad, heavyLoadStatus } from "../projectbox/heavyLoad.js";
import { DESIRED_RUNNING, desiredFromInspect } from "../projectbox/serverEnd.js";
import { commandsPast, runningCommandsIn } from "../runtime/git-run.js";
import { gitPostWork } from "../runs/git-post-work.js";
import { locationFor } from "../runs/runtime-location.js";
import { serverEnds } from "../runs/server-end.js";
import { codeSnapshot, projectRepoBeforeCopy, checkOpenAfterClear, templateSnapshot } from "./code-snapshot.js";
import { removeCopyLocation, createCopyLocation } from "./objects.js";
import { copyLocation } from "./location.js";
import { CopyError, copyJournal, setCopyState } from "./state.js";
import { T } from "../i18n.js";

// A teardown in main (a worktree created by a subagent or a graph run) that hit the FROZEN main (“is paused”) is kept in
// main's post-work (runs/git-post-work.js) — `atReady` reports nothing for it, because main was never stopped. It runs after
// thawing. Not awaited (the build does not depend on it); the set of open jobs counts it, and a throw of an unreadable
// instance does not break the thawing — it goes to the console. The same for the frozen template of a copy from a copy
// (`source`).
function postWorkTheSource(pid, source = MAIN) {
  try {
    const inst = runInstance(pid, source);
    if (inst) gitPostWork(inst);
  } catch (e) { console.error(`[stacks] post-work of ${pid}/${source} after thawing: ${e?.message || e}`); }
}

export const SOURCE = "/src";
export const TARGET = "/dst";
export const CLONE_PROGRAM = "/usr/local/bin/cbase-clone";

// Caps — ESTIMATED, NOT MEASURED. Knob CBASE_COPY_<KIND>_MS.
//   clone1   phase 1 while main runs (images and stopped volumes)
//   clone2   phase 2 INSIDE the pause: the rest; the pause aims at ≈ 30 s
//   fadvise  one `fadvise` over the target
//   call     `ps`, `inspect`, `events`, `volume`, `list`, `policy-protection`
//   git      waiting for running management git before the `pause` (their own deadline is 120 s)
export const FREEZE_CAP = Object.freeze({ clone1: 4 * 3_600_000, clone2: 900_000, fadvise: 1_800_000, call: 60_000, git: 180_000 });
export function freezeCapMs(kind) {
  const raw = process.env[`CBASE_COPY_${String(kind).toUpperCase()}_MS`];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : FREEZE_CAP[kind];
}
// How many events a dockerd keeps in memory for `events --since` (moby daemon/events: eventsLimit). Only an explanation:
// whether events are missing is told by the oldest one in the buffer, not by the length of the answer (see mountEvents) —
// `--until` excludes later ones that still take up slots.
export const EVENT_BUFFER = 256;
export const POLICY_PROTECTION = Object.freeze(["always", "unless-stopped", "on-failure"]);

// The native services of main at freeze time. fn(projectId) → Promise<[{ id, name, port, running }]>.
let nativeServicesStatus = null;
/** The hook (server.js: projectbox/services.js nativeServicesStatus). `null` ⇒ unchecked, none starts in the copy. */
export function setNativeServicesStatus(fn) { nativeServicesStatus = typeof fn === "function" ? fn : null; }

class BuildError extends Error {
  constructor(message, part, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "BuildError";
    this.part = part;
  }
}

const list = (text) => String(text || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
const running = (c) => c?.State?.Running === true || DESIRED_RUNNING.has(c?.State?.Status) || c?.State?.Status === "paused";

/** The containers of a view in the form of the journal (never the environment). */
export function containerFrom(inspect) {
  return (Array.isArray(inspect) ? inspect : []).map((c) => ({
    id: String(c?.Id || ""),
    name: String(c?.Name || "").replace(/^\//, ""),
    running: running(c),
    status: String(c?.State?.Status || ""),
    startedAt: String(c?.State?.StartedAt || ""),
    restart: String(c?.HostConfig?.RestartPolicy?.Name || "no") || "no",
    volumes: [...new Set((c?.Mounts || []).filter((m) => m?.Type === "volume" && m?.Name).map((m) => String(m.Name)))].sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** The volumes phase 1 may copy while running — those that NO running container mounts. */
export function phase1Volumes(volumes, container) {
  const occupied = new Set(container.filter((c) => c.running).flatMap((c) => c.volumes));
  return [...new Set(volumes)].filter((v) => !occupied.has(v)).sort();
}

/** The volumes that must NOT go into phase 1 (a running container mounts them) — they come upfront and are reconciled in the
 *  pause (server/backend/cbase-clone `--upfront`/`--reconcile`) instead of being copied whole there. */
export function upfrontVolumes(volumes, phase1) {
  const p1 = new Set(phase1);
  return [...new Set(volumes)].filter((v) => !p1.has(v)).sort();
}

/** Which phase-1 volumes come once more in phase 2 (with the reason). `mounted`: volumes with a mount event since phase 1. */
export function againVolumes(phase1, { container, volumes }, { mounted = new Set(), incomplete = false } = {}) {
  const old = new Map(phase1.container.map((c) => [c.id, c]));
  const now = new Set(container.map((c) => c.id));
  const existing = new Set(volumes);
  const reasons = {};
  for (const v of phase1.volumes) {
    const user = container.filter((c) => c.volumes.includes(v));
    let g = null;
    if (incomplete) g = "events-incomplete";
    else if (!existing.has(v)) g = "disappeared";
    else if (user.some((c) => c.running)) g = "running";
    else if (user.some((c) => !old.has(c.id))) g = "new-container";
    else if (user.some((c) => old.get(c.id).startedAt !== c.startedAt)) g = "started";
    else if (phase1.container.some((c) => c.volumes.includes(v) && !now.has(c.id))) g = "container-gone";
    else if (mounted.has(v)) g = "mounted";
    if (g) reasons[v] = g;
  }
  return { again: Object.keys(reasons).sort(), reasons };
}

/** The containers whose policy a fresh dockerd would start although they did not run at freeze time. “Ran” as in the desired
 *  state (DESIRED_RUNNING) — a PAUSED one does not count: `running` treats it as running for the volumes, in the desired state
 *  it is “paused”, and the copy's dockerd would set it to stopped on restore and start it through the policy. */
export const policyCandidates = (container) => container.filter((c) => !DESIRED_RUNNING.has(c.status) && POLICY_PROTECTION.includes(c.restart)).map((c) => c.id).sort();

async function insideView(execute) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ids = list((await execute(["ps", "-aq", "--no-trunc"])).stdout);
      // A container that disappears between `ps` and `inspect` makes `inspect` fail — then ONE new attempt.
      const inspect = ids.length ? JSON.parse((await execute(["inspect", ...ids])).stdout || "[]") : [];
      const volumes = list((await execute(["volume", "ls", "-q"])).stdout);
      return { container: containerFrom(inspect), inspect, volumes };
    } catch (e) { last = e; }
  }
  throw last;
}

// The volumes mounted in the window [sinceMs, untilMs] (`docker events`), and whether the answer SAFELY covers the window.
// moby keeps the newest EVENT_BUFFER events of ALL kinds; `--until` leaves out later ones that still take up slots — so the
// length of the answer says nothing about an overflow. The WHOLE buffer up to `untilMs` is asked (`--since 1`), and the
// answer is complete only
//   - if its oldest event lies BEFORE the window (the buffer only drops older ones — what happened from the window on is
//     there), or if the buffer holds nothing at all up to `untilMs` (a quiet daemon; lost would then only be something that
//     ≥ 256 later events displaced in the milliseconds between `untilMs` and the query), AND
//   - if main's dockerd stayed the same: `mainStart` (main's `State.StartedAt`, read AFTER the query) is the one from the
//     begin of the window — a restarted main has a new dockerd with an empty buffer.
// `--until` to the millisecond (moby ParseTimestamps: the fraction is nanoseconds; in whole seconds the rest of the second
// fell out of the window). The time of an event is `timeNano` (+ 500 ns: the imprecision of a double at 10^18 then never
// drops below the whole millisecond); without `timeNano` the answer is not safe.
const msOf = (e) => (Number.isFinite(e?.timeNano) ? Math.floor((e.timeNano + 500) / 1e6) : null);
export const unixTime = (ms) => `${Math.floor(ms / 1000)}.${String(Math.floor(ms) % 1000).padStart(3, "0")}`;
async function mountEvents(execute, { sinceMs, untilMs, startPrior, mainStart }) {
  const r = await execute(["events", "--since", "1", "--until", unixTime(untilMs), "--format", "{{json .}}"]);
  const startNow = await mainStart();
  const all = String(r.stdout || "").split("\n").filter((z) => z.trim()).map((z) => JSON.parse(z));
  const times = all.map(msOf);
  let reason = null;
  if (startNow !== startPrior) reason = "restart";
  else if (!eventsComplete(times, sinceMs)) reason = times.includes(null) ? "without-time" : "buffer";
  const mounted = new Set(all.filter((e, i) => e?.Type === "volume" && e?.Action === "mount" && e?.Actor?.ID && (times[i] === null || times[i] >= sinceMs)).map((e) => String(e.Actor.ID)));
  const oldest = times.length && !times.includes(null) ? Math.min(...times) : null;
  return { mounted, incomplete: reason !== null, reason, count: all.length, oldest, start: startNow };
}
/** The pure rule of mountEvents: does a buffer with these times (ms, `null` = without a time) cover the window from `sinceMs`? */
export function eventsComplete(timesMs, sinceMs) {
  if (timesMs.includes(null)) return false;
  return !timesMs.length || Math.min(...timesMs) < sinceMs;
}

function forced(part) {
  if (process.env.CBASE_COPY_ERROR_AT === part) throw new BuildError(T`forced error before “${part}” (test seam CBASE_COPY_ERROR_AT)`, part);
}

async function volumeLabels(name) {
  try {
    const r = await docker(["volume", "inspect", "--format", "{{json .Labels}}", name], { capMs: freezeCapMs("call") });
    return JSON.parse(r.stdout || "null") || {};
  } catch (e) {
    if (/no such volume|No such object|not found/i.test(`${e?.stderr || ""}\n${e?.message || ""}`)) return null;
    throw e;
  }
}

// Is the template (copy AND instance row) ready? → null or the sentence why not.
function templateNotReady(pid, template) {
  const vk = store.liveStackCopy(pid, template.name);
  const vi = store.projectInstance(pid, template.instance);
  if (vk?.state === "ready" && vi?.state === "ready") return null;
  return T`the template “${template.name}” of ${pid} is not ready (copy ${vk ? vk.state : "gone"}, instance ${vi ? vi.state : T("no row")}) — no copy from it`;
}

export async function dismantlingClone({ projectId, name, volume, location: locationCreated, helperId, data = null }) {
  const pid = String(projectId);
  const instance = copyInstance(name);
  const removed = [];
  const error = [];
  const attempts = async (what, fn) => { try { if (await fn()) removed.push(what); return true; } catch (e) { error.push(`${what}: ${e?.message || e}`); return false; } };
  // If the helper is NOT removed (a throw included), the location stays — the helper mounts `open/` rw and may still run; B
  // would otherwise delete recursively in a tree a container writes to (projectbox-rm-in-b.test.js). A helper that no longer
  // exists counts as removed.
  const helperGone = helperId ? await attempts(T`Helper ${String(helperId).slice(0, 12)}`, () => removeHelper(String(helperId))) : true;
  if (volume !== false) {
    const vname = volumeName(pid, instance);
    await attempts(`Volume ${vname}`, async () => {
      const l = await volumeLabels(vname);
      if (!l) return false;
      if (l[LABEL_PROJECT] !== pid || l[LABEL_INSTANCE] !== instance) throw new Error(T`does not carry the labels of this copy — stays`);
      await docker(["volume", "rm", vname], { capMs: freezeCapMs("call") });
      return true;
    });
  }
  if (locationCreated !== false) {
    const location = copyLocation({ data: data || DIRS.data, projectId: pid, name });
    if (!helperGone) {
      if (lstatOrNull(location.root.base)) error.push(T`Location ${location.root.base}: stays — helper not removed`);
    } else await attempts(T`Location ${location.root.base}`, async () => {
      if (!lstatOrNull(location.root.base)) return false;
      const r = await removeCopyLocation({ location, projectId: pid, instance });
      if (!r.removed) throw new Error(T("was left behind"));
      return true;
    });
  }
  // The row records what was left standing — it only goes when everything before it is gone (see header).
  if (!error.length) await attempts(T`Instance row ${pid}/${instance}`, () => store.deleteProjectInstance(pid, instance) > 0);
  return { removed, error };
}

export async function freeze(copyId, { home = os.homedir(), system = null, data = null } = {}) {
  if (!projectboxOps()) throw new CopyError(T`copies exist only in server mode`, { code: "NO_OPS", status: 404 });
  const k = store.stackCopy(copyId);
  if (!k) throw new TypeError(`freeze: no copy ${copyId}`);
  if (k.state !== "build" || k.phase !== "clone1") throw new TypeError(`freeze: the copy ${k.projectId}/${k.name} is in “${k.state}”/“${k.phase}”, not in build/clone1`);
  const pid = k.projectId;
  const name = k.name;
  const instance = copyInstance(name);
  if (projectOccupied(pid) !== "copy") throw new TypeError(`freeze: without the project occupancy “copy” (project ${pid}: ${projectOccupied(pid) ?? "free"})`);
  const inst = store.projectInstance(pid, instance);
  if (inst?.state !== "create") throw new TypeError(`freeze: the instance ${pid}/${instance} is ${inst ? `in “${inst.state}”` : "missing"} — the build keeps it in “create” since clone1`);
  // The source — main or the template (header, “COPY FROM A COPY”).
  const source = k.baseInstance && k.baseInstance !== MAIN ? String(k.baseInstance) : MAIN;
  const main = store.projectInstance(pid, MAIN);
  let template = null;
  if (source === MAIN) {
    if (main?.state !== "ready" || !main.convertedAt) throw new CopyError(T`main of ${pid} is not ready (${main?.state ?? T("no row")}) — no copy`, { code: "MAIN_NOT_READY", status: 409 });
  } else {
    if (!main?.convertedAt) throw new CopyError(T`main of ${pid} is not converted (${main?.state ?? T("no row")}) — no copy`, { code: "MAIN_NOT_READY", status: 409 });
    const vName = copyNameOf(source); // throws for an invalid instance
    template = { name: vName, instance: source, location: copyLocation({ data: data || DIRS.data, projectId: pid, name: vName }) };
    const notReady = templateNotReady(pid, template);
    if (notReady) throw new CopyError(notReady, { code: "TEMPLATE_NOT_READY", status: 409 });
  }
  const projectPath = store.getProject(pid)?.path;
  if (!projectPath) throw new TypeError(`freeze: project ${pid} has no path`);

  // Heavy load: the caller's or an own one (header).
  const holder = heavyLoadStatus();
  const ownHeavyLoad = !(holder?.kind === "copy-clone" && holder.projectId === pid && holder.instance === instance)
    ? occupyHeavyLoad("copy-clone", { projectId: pid, instance })
    : null;

  const location = copyLocation({ data: data || DIRS.data, projectId: pid, name });
  // The container that gets frozen: main or the template.
  const mainName = containerName(pid, source);
  const journal = copyJournal(k.id);
  const state = { part: "", location: false, volume: false, helperId: null, pause: false };
  const note = async (part, more = {}) => {
    Object.assign(state, more, { part });
    await journal.note({ freeze: { ...state } });
    forced(part);
  };
  const call = () => ({ capMs: freezeCapMs("call") });
  const times = {};
  let helper = null;
  let part = "";
  try {
    // location — what is already there does not belong to this build: check first, then “created” into the journal, then create.
    await note(part = "location");
    if (lstatOrNull(location.root.base)) throw new BuildError(T`Location ${location.root.base} already exists — a leftover of an earlier copy, not of this build; nothing created`, "location");
    await note(part = "location", { location: true });
    createCopyLocation(location);
    // volume — the same
    const vname = volumeName(pid, instance);
    await note(part = "volume");
    if (await volumeLabels(vname)) throw new BuildError(T`Volume ${vname} already exists — a leftover, not of this build; nothing created`, "volume");
    await note(part = "volume", { volume: true });
    await docker(["volume", "create", "--label", `${LABEL_PROJECT}=${pid}`, "--label", `${LABEL_INSTANCE}=${instance}`, vname], call());
    // helper
    const runtime = locationFor({ projectId: pid, converted: true });
    fs.mkdirSync(runtime.processes, { recursive: true });
    const usrLocalBin = (system || SYSTEM_PATHS).usrLocalBin;
    // From a template (header): no project folder, no runtime folder, no `open/`, no `.gitconfig` — instead the template's
    // `layer/` read-only and the root of the new copy (the clone program creates its `layer/` there).
    const mounts = template ? [
      { type: "volume", source: volumeName(pid, source), target: SOURCE, onlyRead: true },
      { type: "volume", source: vname, target: TARGET },
      { type: "bind", source: template.location.root.layers, target: template.location.root.layers, onlyRead: true },
      { type: "bind", source: location.root.base, target: location.root.base },
      { type: "bind", source: usrLocalBin, target: SYSTEM_PATHS.usrLocalBin, onlyRead: true },
    ] : [
      { type: "volume", source: volumeName(pid), target: SOURCE, onlyRead: true },
      { type: "volume", source: vname, target: TARGET },
      { type: "bind", source: projectPath, target: projectPath },
      { type: "bind", source: runtime.root, target: runtime.root },
      { type: "bind", source: location.root.open, target: location.root.open },
      { type: "bind", source: usrLocalBin, target: SYSTEM_PATHS.usrLocalBin, onlyRead: true },
    ];
    const gitconfig = path.join(home, ".gitconfig");
    if (!template && lstatOrNull(gitconfig)?.isFile()) mounts.push({ type: "bind", source: gitconfig, target: gitconfig, onlyRead: true });
    await note(part = "helper");
    helper = await startHelper({ kind: "clone", projectId: pid, instance, mounts, capMs: freezeCapMs("call") });
    await note(part = "helper", { helperId: helper.id });
    const clone = (args, kind = "call") => executeHelper(helper, ["python3", CLONE_PROGRAM, ...args], { capMs: freezeCapMs(kind) });

    // projectRepo: a folder relocated empty that carries something since gets its project repo — before the pause.
    await note(part = "projectRepo");
    const projectRepo = template ? { created: false, reason: "template" } : await projectRepoBeforeCopy({ projectId: pid, name, projectPath, helper });
    if (projectRepo.created) console.log(`[stacks] copy ${pid}/${instance}: project repo created, first commit ${projectRepo.commit.slice(0, 12)}`);
    await note(part = "projectRepo", { projectRepo });

    // inspect1 + phase-1 set. The begin BEFORE the `ps`, the start of main in between (see header).
    await note(part = "inspect1");
    const mainStart = async () => String((await docker(["inspect", "--type", "container", "-f", "{{.State.StartedAt}}", mainName], call())).stdout || "").trim();
    const begin = Date.now();
    const start1 = await mainStart();
    const image1 = await insideView((args) => dockerIn(mainName, args, call()));
    const p1 = phase1Volumes(image1.volumes, image1.container);
    // The others — mounted by a running container — come upfront and are reconciled in the pause.
    const upfront = upfrontVolumes(image1.volumes, p1);
    const phase1 = { begin: new Date(begin).toISOString(), beginMs: begin, volumes: p1, upfront, upfrontSince: null, container: image1.container, mainStart: start1 };
    await note(part = "clone1", { phase1 });
    const volArgs = (vs, flag = "--volumes") => (vs.length ? [flag, ...vs] : []);
    let t0 = Date.now();
    const k1 = await clone(["copy", "--phase", "1", SOURCE, TARGET, ...volArgs(phase1.volumes), ...volArgs(upfront, "--upfront")], "clone1");
    times.clone1Ms = Date.now() - t0;
    if (upfront.length) {
      const since = /(?:^|\s)upfront_begin_ns=(\d+)(?:\s|$)/.exec(String(k1.stdout || ""))?.[1];
      // Without the begin the reconciliation would not know from when a change counts — no default (a missing field is no statement).
      if (!since) throw new BuildError(T`Phase 1 did not name the begin of the upfront copy (output “${String(k1.stdout || "").trim().slice(0, 200)}”)`, "clone1");
      phase1.upfrontSince = since;
      // The messages of the own cp of the upfront volumes are tolerated (the reconciliation in the pause reconciles every
      // entry) — counted into the journal. Without the field (an older program) nothing is recorded, not a zero.
      const upfrontError = /(?:^|\s)upfront_error=(\d+)(?:\s|$)/.exec(String(k1.stdout || ""))?.[1];
      if (upfrontError !== undefined) {
        phase1.upfrontError = Number(upfrontError);
        if (phase1.upfrontError > 0) console.log(`[stacks] copy ${pid}/${instance}: upfront copy with ${phase1.upfrontError} tolerated message(s) from cp — the reconciliation in the pause evens them out`);
      }
      await journal.note({ freeze: { ...state } });
    }
    if (template) {
      // The upper layers of the template, phase 1 while the template runs — its begin is the threshold of the reconciliation
      // in the pause. Without it phase 2 would not know from when a change counts (a missing field is no statement).
      const s1 = await clone(["layer", "--phase", "1", template.location.root.layers, location.root.layers], "clone1");
      const out = String(s1.stdout || "");
      const since = /(?:^|\s)layer_begin_ns=(\d+)(?:\s|$)/.exec(out)?.[1];
      if (!since) throw new BuildError(T`Phase 1 of the layer did not name its begin (output “${out.trim().slice(0, 200)}”)`, "clone1");
      phase1.layerSince = since;
      const errorCount = /(?:^|\s)layer_error=(\d+)(?:\s|$)/.exec(out)?.[1];
      if (errorCount !== undefined) phase1.layerError = Number(errorCount);
      await journal.note({ freeze: { ...state } });
    }
    const sources1 = list((await clone(["list", "--phase", "1", SOURCE, ...volArgs(phase1.volumes)])).stdout).map((x) => path.posix.join(SOURCE, x));
    for (let i = 0; i === 0 || i < sources1.length; i += 200) await clone(["fadvise", ...(i === 0 ? [TARGET] : []), ...sources1.slice(i, i + 200)], "fadvise");

    // code from the template (header) — BEFORE the lock: the refs are read by a command INSIDE the running template, which
    // would wait for itself at the closed barrier. The template must still be ready.
    let code = null;
    if (template) {
      await note(part = "code");
      const notReady = templateNotReady(pid, template);
      if (notReady) throw new BuildError(notReady, "code");
      code = await templateSnapshot({
        projectId: pid, name, projectPath, location, template: { ...template, inst: store.projectInstance(pid, source) }, base: k.base ?? null,
        note: (c) => journal.note({ code: c }),
      });
    }

    // freeze
    setCopyState(k.id, "build", { phase: "freeze" });
    await note(part = "lock");
    if (serverEnds()) throw new BuildError(T("the server is ending — no freezing"), "lock");
    const lock = projectLocks(pid, { reason: "freeze", instance: source });
    if (!lock.ok) throw new BuildError(T`Lock “freeze” could not be set: ${(lock.open || []).map((o) => o.text).join("; ") || lock.error || "?"}`, "lock");
    let pausedMs = 0;
    let beforePauseMs = 0;
    let start2 = "";
    let desired = null;
    let again = [];
    let candidates = [];
    let tauError = null;
    let runningServices = [];
    let services = null;
    try {
      // services — before the barrier; a throw of the hook fails the copy (unknown is not “none ran”).
      await note(part = "services");
      if (nativeServicesStatus) {
        const raw = await nativeServicesStatus(pid, { instance: source });
        services = (Array.isArray(raw) ? raw : []).map((d) => ({ id: Number(d?.id), name: String(d?.name ?? ""), port: Number.isInteger(d?.port) ? d.port : null, running: d?.running === true }))
          .filter((d) => Number.isInteger(d.id)).sort((a, b) => a.id - b.id);
        runningServices = services.filter((d) => d.running).map((d) => d.id);
      }
      await note(part = "services", { services });
      await note(part = "pause", { pause: true });
      await pause(mainName, {
        capMs: freezeCapMs("call"),
        beforePause: async () => {
          // Let running management git of main finish (the barrier holds new ones).
          if (runningCommandsIn(mainName)) {
            const past = commandsPast(mainName);
            let tick;
            const cap = new Promise((_, no) => { tick = setTimeout(() => no(new BuildError(T`after ${freezeCapMs("git") / 1000} s ${runningCommandsIn(mainName)} management git still ran in main (cap CBASE_COPY_GIT_MS, estimated) — not frozen`, "pause")), freezeCapMs("git")); });
            try { await Promise.race([past, cap]); } finally { clearTimeout(tick); past.abort(); }
          }
          // The desired state immediately before the pause, raw (dockerIn would wait at its own, now closed barrier).
          const raw = (args) => docker(["exec", "-u", "agent", mainName, "docker", ...args], call());
          const image2 = await insideView(raw);
          beforePauseMs = Date.now();
          // Up to NOW to the millisecond (an `--until` in the future would wait at the closed barrier); the rest up to the
          // pause is seen by the recheck (from exactly this point in time).
          const events = await mountEvents(raw, { sinceMs: phase1.beginMs, untilMs: beforePauseMs, startPrior: start1, mainStart });
          start2 = events.start;
          desired = desiredFromInspect(image2.inspect, { services: runningServices, time: beforePauseMs });
          const n = againVolumes(phase1, image2, events);
          again = n.again;
          candidates = policyCandidates(image2.container);
          await note(part = "pause", { desired, again: n.reasons, policy: { candidates }, events: { count: events.count, incomplete: events.incomplete, reason: events.reason } });
        },
      });
      // The end of the recheck window AFTER the `pause` — until then the container still ran.
      pausedMs = Date.now();
      // code — from a template already before the lock; no process ran in the helper there, nothing to clear.
      if (!template) {
        await note(part = "code");
        code = await codeSnapshot({
          projectId: pid, name, projectPath, location, helper, base: k.base,
          note: (c) => journal.note({ code: c }),
        });
        // clear: no process of main stays in the helper, then the tars against the checked ones.
        await note(part = "clear");
        await emptyHelper(helper, { capMs: freezeCapMs("call") });
        checkOpenAfterClear(location);
      }
      // clone2
      setCopyState(k.id, "build", { phase: "clone2" });
      await note(part = "clone2");
      t0 = Date.now();
      await clone(["copy", "--phase", "2", SOURCE, TARGET, ...volArgs(phase1.volumes), ...volArgs(again, "--again"),
        ...(phase1.upfront.length ? ["--reconcile", ...phase1.upfront, "--since", phase1.upfrontSince] : [])], "clone2");
      // The reconciliation of the upper layers — what the template changed since phase 1.
      if (template) await clone(["layer", "--phase", "2", template.location.root.layers, location.root.layers, "--since", phase1.layerSince], "clone2");
      times.clone2Ms = Date.now() - t0;
    } finally {
      // Every exit thaws — also after a `pause` that failed at the cap (docker.js then thaws without an entry).
      if (state.pause) {
        try { await thawOut(mainName); } catch (e) { tauError = e; }
        if (!tauError) postWorkTheSource(pid, source);
        times.pauseMs = pausedMs ? Date.now() - pausedMs : 0;
        state.thawed = !tauError;
        await journal.note({ freeze: { ...state } }).catch(() => {});
      }
      lock.resolve();
    }
    if (tauError) {
      part = "thaw"; // the reason is named after the step that failed, not after clone2
      throw new BuildError(T`Thawing ${template ? T`the template “${template.name}”` : T("main##thawing")} failed: ${tauError.message} — the watchdog thaws later`, "thaw", tauError);
    }

    // Recheck: the window between desired state and pause — from the `--until` of the desired state until after the `pause`.
    await note(part = "recheck");
    const late = await mountEvents((args) => dockerIn(mainName, args, call()), { sinceMs: beforePauseMs, untilMs: pausedMs, startPrior: start2, mainStart });
    const missed = phase1.volumes.filter((v) => late.mounted.has(v) && !again.includes(v));
    if (missed.length || late.incomplete) {
      throw new BuildError(T`between desired state and pause ${missed.length ? T`volume ${missed.join(", ")}` : T`possibly a volume (events not safe: ${late.reason})`} was mounted — the clone would carry an old state, discarded`, "recheck");
    }

    // policy
    await note(part = "policy");
    let old = {};
    if (candidates.length) old = JSON.parse((await clone(["policy-protection", TARGET, ...candidates])).stdout || "{}");
    await note(part = "fadvise", { policy: { candidates, old } });
    await clone(["fadvise", TARGET], "fadvise");
    await note(part = "helper-gone");
    await removeHelper(helper.id);
    await note(part = "finished", { helperId: null });
    return { desired, policy: old, again, phase1: { begin: phase1.begin, volumes: phase1.volumes, upfront: phase1.upfront }, code, times, services, ...(template ? { template: { name: template.name, instance: source } } : {}) };
  } catch (e) {
    const reason = `${part ? `${part}: ` : ""}${e?.message || e}`;
    console.error(`[stacks] copy ${pid}/${instance}: freezing failed (${reason}) — dismantling`);
    const r = await dismantlingClone({ projectId: pid, name, volume: state.volume, location: state.location, helperId: state.helperId || helper?.id || null, data });
    const back = r.error.length ? T` — dismantling incomplete: ${r.error.join("; ")}` : "";
    // Only here does the setter announce the return path — at server end the build afterwards puts the copy back into the
    // queue or wakes itself (build.js); every other `error` wakes at server end too.
    try { setCopyState(k.id, "error", { error: `${reason}${back}`.slice(0, 2000) }, { returnPathAtServerEnd: true }); } catch (x) { console.error(`[stacks] copy ${k.id}: error not set: ${x?.message || x}`); }
    throw Object.assign(new CopyError(T`Copy ${name} of ${pid}: ${reason}${back}`, { code: "COPY_BUILD", status: 500, rootCause: e }), { part, dismantled: !r.error.length });
  } finally {
    ownHeavyLoad?.();
  }
}
