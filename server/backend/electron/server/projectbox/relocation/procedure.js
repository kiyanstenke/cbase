// The relocation procedure: an internal path in the backend that brings a project completely into its project container,
// checks strictly, removes ONLY AFTERWARDS and writes a report. No UI; the routes are in ./routes.js (a sub-slice of
// `projectRoutes`). "B" is the user container, "inside" means inside the project container.
//
// WHAT IS HERE (the container side; the data steps 9, 11, 13 and the data part of 15 come in through `steps` from
// ./data.js, the plan from ./collect.js — contract below):
//   startRelocation(projectId, { steps, creation, started, acknowledged })  → the result `{ ok, id, end, step?, error?,
//       report? }` once the relocation is through (finished, back, or left open). Preconditions that change NOTHING throw
//       a `RelocationError` with `status`/`code` (404 without the ops marker — no docker —, 409 for an open journal, an
//       existing instance row, hold reasons of the plan, occupied heavy load, not idle). `started({ id, location })` fires
//       as soon as the journal exists (a route answers then instead of waiting for minutes). A relocation only ever
//       begins by hand (POST …/relocation).
//   relocationStatus(projectId)  the last relocation of the project without values (plan head, step, end, error, report,
//       duration per step).
//   resumeRelocation(projectId, { steps, creation, started })  → { run } — the second way (route POST …/relocation/resume):
//       resume an open journal without a living procedure as the restart grace does; preconditions throw synchronously.
//   relocationRestartGraceSeam({ steps, creation })  → { decider, afterReady } — server.js registers `decider` with
//       ../instances.js setRelocationDecider and `afterReady` with ../restore.js atReady.
//   RELOCATION_JOURNAL, loadRelocationSteps, relocationContext, relocationEffects  the parts the two above consist of —
//       exported for the guard (relocation-procedure.test.js drives a "crashed" state with them).
//
// THE SHARED CONTRACT OF THE RELOCATION MODULES. The procedure builds ONE context object and hands it to every step:
//   ctx = { projectId, project (store row), workspace (store row), plan (planRelocation), journal (../journal.js for THIS
//           relocation), relocationLocation (<data>/relocations/<projectId>/<time>/, 0700, never mounted), inst (the
//           instance row of main, read fresh — null before the creation), docker ({ docker, dockerIn } from ../docker.js),
//           log(text), plus relocationId, row() (the journal row, fresh), steps, creation, report }.
//   data.js:    portDismantling / portDismantlingBack (9), projectRepoStep / projectRepoBack (11), relocateRuntime /
//               runtimeBack (13; return path 1 and the copies of return path 5), cleanUpAfterStart (data part of 15) —
//               async, idempotent, journal BEFORE the effect, an error throws an Error with the field `step`.
//   collect.js: planFor(projectId) → { plan, data }.
//   Without `steps` this procedure loads both files only at run time (dynamic import) — a missing piece is a TypeError
//   before anything takes effect.
//
// THE STEPS (journal names; the journal writes the step BEFORE its effect, and what a step changes is noted BEFORE the
// respective effect):
//   Before the journal: ops marker, project, no open journal, no instance row; heavy load (../heavyLoad.js, one per B),
//     occupancy of the project, living procedure (instances.js withProcedure); plan (collect.js) without a hold reason;
//     step 2: lock, THEN idle (idle.js projectLocks — terminals are ended with a message). Only then does the journal
//     come into being together with the plan; a no up to this point changes nothing.
//   creation (3a)   CLI home and trust entry FIRST (cli-home.js), then instance.js createInstance with state
//                   `relocation` (from here on the row is in `relocation` and holds `busy`). Before that
//                   `insideIds.volumeFound`: if the volume of the project container already lay in B, rw-container
//                   does not remove it.
//   dryrun (3b)     `compose … config --hash '*'` INSIDE the project container against the label `config-hash` of each
//                   container — only services WITHOUT `env_file` are compared (for those with one, `config --hash` is
//                   never the hash of `up`). If a service differs, the step asks Compose's model (`config --format json
//                   --no-interpolate`, once per Compose project) whether it carries `env_file`; then it shows with its
//                   reason in `report.dryrun.withoutHash`, and equality (8) checks it after the stop.
//   stop (4)        container list (state, exit code, restart policy, image, hash, mounts) and old policies into the
//                   journal; `stop -t 30 <id>` in reverse depends_on order; then `update --restart=no` (otherwise a
//                   restart of B would bring an `always` container back); native services through the process group
//                   (services.js endNativeRuns); desired manifest per volume at the stopped source (helper, root) —
//                   only if every volume of the plan EXISTS (`--mount` would silently create a missing one empty), as a
//                   stream into `<location>/manifests/<name>.desired.jsonl` (never as a string in B). Plus two looks at
//                   /proc (./processes.js): BEFORE the first stop without the groups of the native runs, AFTER ending
//                   them without exception — if a process in B still works in the project folder then (or /proc is not
//                   readable), the relocation goes back.
//   images (5)      `docker save <tags>` in B as a STREAM into `docker exec -i cbase-p-<id> docker load`; id per tag checked.
//   volumes (6)     create the named volumes inside with the labels of the source; a helper (source ro, target the
//                   docker volume of the project container) runs `cp -a /source/. volumes/<name>/_data`; helper removed by id.
//   networks (7)    create networks without labels inside (from the pool); those with labels their owner creates on `up`.
//   equality (8)    per Compose set (owner before user) `up --no-start --no-build --pull never <services>`, then hash == label.
//   port-dismantling (9)  data.js.
//   new-hash (10)   (without the override file put aside) Compose decides itself what must be recreated: per Compose
//                   project first the control (`--dry-run … --force-recreate` must report EVERY plan container as
//                   "Recreate"), then the trial run (`--progress json --dry-run up --no-start …`, changes nothing), `up
//                   --no-start` only for the "Recreate" services, then a second trial run that may report nothing. The
//                   desired hash of a recreated container is its label inside (the hash of `up`, env_file content
//                   included), all others keep the label from B (`config --hash` neither sees a changed env_file nor
//                   ever matches the hash of an env_file service).
//   project-repo (11)  data.js.
//   anonymous-volumes (12)  matched through (container, target) of the FINAL containers (after 10); the inner dockerd
//                   filled the target on `up` from the image (copy-up) — it is CLEARED, then copied as in 6; likewise
//                   every named volume whose source is empty (`copy`). In 6 the target must be empty.
//   runtime (13)    data.js.
//   check (14a)     the same container list (created/exited too), same image id, same hash (after 8 or 10), every
//                   volume with a field-equal manifest (manifest.js). A no ⇒ return path.
//   start (14b, THE TURNAROUND)  set `converted_at`, the project container runs, restore.js runInstanceUp (the ONE
//                   start sequence: stages, native services through the wrapper, names). From here on only forward.
//   recheck         list, image id and hash once more (without manifest — the services are running) — after a restart
//                   the relocation removes only after this renewed check.
//   remove (15)     ONLY what provably belongs to this project: old containers by id; volumes only from the journal,
//                   with the Compose label of a project of this relocation and matching labels; images without users
//                   that this project BUILT (label `com.docker.compose.project`; per tag, only while the tag still
//                   points at the id) — a pulled image stays; not the build cache (no filter hits one project);
//                   networks only with the Compose label of a project of this relocation — one without labels stays in
//                   B like a volume without a label; data.js cleanUpAfterStart. What did not work or stays is in the
//                   report (no reason to keep the relocation open).
//   completion      report (without values, duration per step) into the journal and to `<location>/report.json`; row `ready`.
//   Return path (automatic on an error BEFORE the turnaround, in this order):
//     rw-runtime (return path 1 and the copies of 5: data.js runtimeBack — worktrees back FIRST),
//     rw-container (2: helpers, project container, its volume — only with `volumeFound === false` —, its network — by
//     id, only with the project's label),
//     rw-ports (3: data.js portDismantlingBack), rw-old-start (4: old containers in depends_on order, policies back,
//     ended native services restarted with the restored start commands), rw-project-repo (5: data.js projectRepoBack),
//     rw-completion (5: delete the instance row, update /etc/hosts); then the journal ends `back`, the lock is released.
//   THE RETURN PATH ALWAYS ENDS NAMED. The reason is in the journal BEFORE the first return-path step (journal.js
//     `atTurnAround` → column `error` and `report.returnPath.reason`) — a failing return path does not lose it. An error
//     of ONE return-path step does not stop the return path: it goes into `report.returnPath.error` (per step, without
//     values), and the remaining steps run. That is safe because no return-path step deletes anything whose return
//     depends on an earlier one: rw-runtime removes the copies only when ALL worktrees are back (otherwise
//     `runtimeStays`, nothing is removed there), rw-container removes only what is a copy before the turnaround (nothing
//     ran inside; the runtime folder is a bind and stays), rw-ports/rw-old-start delete nothing, rw-project-repo only
//     the repo created in THIS relocation. A `No such container` when starting an old container (Compose `run --rm`:
//     AutoRemove — docker removed it at the stop in 4) is settled and listed in `report.returnPath.gone`. The end is
//     always `back`: row gone, project usable in B, the report names every failed part, `POST …/relocation` works
//     again. That is why deleting the row in rw-completion is NOT a collected part: if it fails, the return path holds
//     there as below (`hold-return-path`, journal open) instead of reporting `back` with a row in `relocation` that no
//     restart grace can decide any more. EXCEPTION — an error that would leave data in an endangered place
//     (`endangered`: the instance carries `converted_at`, something may have arisen inside since the start —
//     rw-runtime, rw-container and rw-completion check that BEFORE any effect): then the return path holds, the row
//     stays in `relocation` with the phase `hold-return-path`, reason and way out (instances.js `relocationWayOut`:
//     POST …/relocation/resume or the next start of B), and `busy` holds.
//
// RESTART GRACE: a journal without a living procedure decides (journal.js `decide`): before the turnaround the return
// path, from the turnaround on forward — first `start` (idempotent: start containers, start sequence), then `recheck`,
// only then `remove`: if the journal is already BEYOND `recheck` (crash in the middle of `remove`), the restart grace
// checks once more before the first `rm` — otherwise it would remove after a double fault without the renewed look. Both
// run INSIDE the error handling of runRelocation (`upfront`): an error there lands in the journal and on the row
// instead of only in the log. The decider enters its procedure SYNCHRONOUSLY (withProcedure), takes the heavy load FIRST
// (before waiting for the cleanup of orphaned helpers, helper.js helperCleanedUp) and only then touches anything; several
// half relocations run one after the other (one queue). `POST …/relocation` of another project waits until the restart
// grace has taken over an open journal (instances.js `relocationElsewhere`, 409 RELOCATION_ELSEWHERE). If resuming
// itself fails (heavy load, occupancy, …), instances.js `relocationResumeFailed` remembers the reason and names the way
// out; `resumeRelocation(projectId)` is the second way. If a step fails AFTER the turnaround, the journal stays open
// and the row becomes `ready` with the reason (the project is running inside, after all) — the next start finishes it
// through the restore and `afterReady` (or the route). If the RETURN PATH fails in an endangering way (see above), the
// row stays in `relocation`/`hold-return-path`.
//
// THE POINT OF NO RETURN: the turnaround is `start`, but the point of no return is `converted_at`. If `start` fails
// before it (project container missing, does not start, its entrypoint does not report `ready` — say after a restart
// of B between 14a and the start), the error carries `turnaroundNotReached` and the procedure takes the return path
// (journal.js) instead of standing in `halt start` forever with stopped old containers.
// THE PLAN IS OLDER THAN THE LOCK: it is made before lock and idle. `stop` reads the set AGAIN afterwards (the rule of
// plan.js, plus every other container on a volume of the plan) and holds on any deviation — before the first stop, so a
// return path without effect.
// THE BOOKKEEPING IS NOT THE TRUTH: the table of native runs (services.js) can be wrong — a duplicate start once
// overwrote pid/pgid of a run, and the real process kept running in B after the relocation, with its working directory
// in the project. So `stop` asks /proc (./processes.js, the same rule as the plan), twice: before the first stop
// (exempting the groups of the native runs, confirmed by start time), and after endNativeRuns without any exception. A
// hit or an unreadable /proc ⇒ return path before the turnaround.
// PORTS AFTER THE START: `start` measures the listening port of each native service in the project container (`lsof`
// as agent: the sockets of the process groups that hold the service's log file open). If it listens on the port of its
// row, fine; if its group listens on EXACTLY one other port until the cap (CBASE_RELOCATION_PORT_MS), the row gets the
// measured port (the old value is in the journal's report first); otherwise the row stays and the report names the
// case (`report.start.ports`, per service `finding`).
//
// INVARIANTS. Without projectboxOps() no docker call (startRelocation throws 404, the decider only logs). Without a
// relocation row and an instance row this procedure changes nothing. docker only through ../docker.js, argument arrays,
// removal by id, `--mount` (helper), never `-e NAME=VALUE`. `.env*` values never arrive here (the plan carries none, the
// data steps back up the originals in the relocation location); messages carry names, ids and the step, never a value —
// stdout of a failed `compose config` is never logged.
//
// Knobs (product caps with a message): CBASE_RELOCATION_<KIND>_MS for call · stop · compose · image · copy · manifest · port.
// Test seam: CBASE_MANIFEST_PROGRAM (the path of the manifest program in B, default /usr/local/bin/cbase-manifest — it is
// bound read-only into the helper at /usr/local/bin/cbase-manifest and called with manifest.js manifestArgv).
// Guards: server/backend/test/relocation-procedure.test.js (data steps injected), relocation-end.test.js (everything real).
import fs from "node:fs";
import path from "node:path";
import * as store from "../../store.js";
import { DIRS } from "../../app-state.js";
import { realPath, inArea } from "../../runtime/real-path.js";
import { serviceLogFile } from "../../runs/runtime-location.js";
import { serverEnds } from "../../runs/server-end.js";
import { endNativeRuns, ServiceRunningError, nativeRuns, startSimple } from "../../services.js";
import { MAIN, LABEL_PROJECT, containerName, networkName, volumeName } from "../creation.js";
import { ONLY_IN_OPS, projectboxOps } from "../ops.js";
import { createCliHome, enterCodexTrust } from "../cli-home.js";
import {
  ComposeConfigError, LABEL, configHashArgs, configModelArgs, configVolumesArgs, servicesWithEnvFile, labelsOf, modelVolumes, dryrunVerdict,
  upWithoutStartArgs, upDryrunArgs,
} from "../compose-config.js";
import { servicesSeam } from "../services.js";
import { docker, dockerIn, dockerKind } from "../docker.js";
import { LABEL_RELOCATION, ownKey } from "../own-labels.js";
import { LABEL_HELPER, LABEL_HELPER_PROJECT, removeHelper, helperCleanedUp, executeHelper, withHelper } from "../helper.js";
import { createInstance, withProjectOccupancy, waitForInside } from "../instance.js";
import {
  procedureAlive, setInstanceState, withProcedure, relocationElsewhere, relocationElsewhereText, relocationWayOut, relocationDecided, relocationResumeError,
  relocationResumeFailed,
} from "../instances.js";
import { JournalTurned, decide, createJournal, run, journalPlan, createRelocationLocation, relocationTime } from "../journal.js";
import { projectLocks, wakeProject } from "../idle.js";
import { bringAlongNames } from "../names.js";
import { HeavyLoadOccupied, withHeavyLoad, heavyLoadStatus } from "../heavyLoad.js";
import { DESIRED_RUNNING, withServicesOfNow, desiredFromInspect } from "../serverEnd.js";
import { runInstanceUp, checkLiveness, desiredAfterRestore } from "../restore.js";
import { MANIFEST_PROGRAM, manifestArgv, checkManifestStream, compareManifestStreams, comparisonRows } from "./manifest.js";
import { diffData, applyReceipts } from "./plan.js";
import { remainingProcesses, processRow } from "./processes.js";

// ── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RELOCATION_JOURNAL = journalPlan({
  forward: [
    "creation", "dryrun", "stop", "images", "volumes", "networks", "equality", "port-dismantling", "new-hash",
    "project-repo", "anonymous-volumes", "runtime", "check", "start", "recheck", "remove", "completion",
  ],
  backward: ["rw-runtime", "rw-container", "rw-ports", "rw-old-start", "rw-project-repo", "rw-completion"],
  pivot: "start",
});

/** The data steps (data.js) and the plan (collect.js) — the contract in the header. */
export const DATA_STEPS = Object.freeze([
  "portDismantling", "portDismantlingBack", "projectRepoStep", "projectRepoBack", "relocateRuntime", "runtimeBack",
  "cleanUpAfterStart",
]);

// `port`: how long `start` waits at most for a native service to listen on the port of its row.
const CAP_DEFAULT = Object.freeze({ call: 120_000, stop: 90_000, compose: 600_000, image: 3_600_000, copy: 3_600_000, manifest: 1_800_000, port: 60_000 });
/** The product cap of a kind: CBASE_RELOCATION_<KIND>_MS, an integer ≥ 100, otherwise the default. */
export function relocationCapMs(kind) {
  const raw = process.env[`CBASE_RELOCATION_${String(kind).toUpperCase()}_MS`];
  const n = Number(raw);
  return raw && Number.isSafeInteger(n) && n >= 100 ? n : CAP_DEFAULT[kind];
}

export class RelocationError extends Error {
  constructor(code, message, status = 409, fields = {}) {
    super(message);
    this.name = "RelocationError";
    this.code = code;
    this.status = status;
    Object.assign(this, fields);
  }
}

const stepError = (step, text, cause) => Object.assign(new Error(text, cause ? { cause } : undefined), { step });
// A return-path error that would leave data in an endangered place — the return path holds (header, "ALWAYS ENDS NAMED").
const endangered = (step, text) => Object.assign(stepError(step, text), { endangered: true });
const RUNNING = new Set(["running", "restarting", "paused"]);
const ANONYM = /^[0-9a-f]{64}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const nameOf = (c) => String(c?.Name || c?.name || "").replace(/^\//, "");
const normId = (id) => String(id || "").replace(/^sha256:/, "");
const idsFrom = (text) => String(text || "").split(/\s+/).filter(Boolean);
const short = (e) => String(e?.message || e || "").split("\n")[0].slice(0, 400);
const isMissing = (e) => /No such (object|container|volume|network|image)|not found|no such volume/i.test(`${e?.stderr || ""}\n${e?.message || ""}`);
// Exactly "this container is gone" — `isMissing` would also match "network … not found" on start, and that is a real error.
const containerGone = (e) => /No such container/i.test(`${e?.stderr || ""}\n${e?.message || ""}`);
const SOURCE = (name) => `/relocation/source/${name}`;
const TARGET = "/relocation/target";
const targetData = (name) => `${TARGET}/volumes/${name}/_data`;

function policyText(p) {
  const name = p?.Name || "no";
  return name === "on-failure" && Number(p?.MaximumRetryCount) > 0 ? `on-failure:${p.MaximumRetryCount}` : name;
}

function checkVolumeName(name) {
  if (!VOLUME_NAME.test(String(name || ""))) throw new Error(`volume name "${String(name).slice(0, 80)}" is not a valid Docker name`);
  return name;
}

// ── Loading the steps ───────────────────────────────────────────────────────────────────────────────────────────────

/** The data steps (and with `withPlan` planFor) — injected or loaded at run time from data.js/collect.js. */
export async function loadRelocationSteps(steps = {}, { withPlan = true } = {}) {
  const s = { ...(steps || {}) };
  if (DATA_STEPS.some((n) => typeof s[n] !== "function")) {
    const m = await import("./data.js");
    for (const n of DATA_STEPS) if (typeof s[n] !== "function") s[n] = m[n];
  }
  if (withPlan && typeof s.planFor !== "function") s.planFor = (await import("./collect.js")).planFor;
  const missing = [...DATA_STEPS, ...(withPlan ? ["planFor"] : [])].filter((n) => typeof s[n] !== "function");
  if (missing.length) throw new TypeError(`relocation: step function missing: ${missing.join(", ")} (data.js/collect.js)`);
  return s;
}

// ── The context ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The context of a relocation from its journal row (contract in the header). `plan` beats the row (the fresh plan). */
export function relocationContext(row, { steps, creation = {}, plan } = {}) {
  if (!row?.id || !row.projectId) throw new TypeError("relocationContext: no journal row");
  const projectId = String(row.projectId);
  const project = store.getProject(projectId);
  if (!project) throw new RelocationError("NO_PROJECT", `project ${projectId} does not exist`, 404);
  const workspace = project.workspaceId ? store.getWorkspace(project.workspaceId) : null;
  const id = row.id;
  const logFile = path.join(row.location, "log.log");
  return {
    projectId, project, workspace, relocationId: id, relocationLocation: row.location,
    plan: plan ?? row.plan ?? null,
    journal: createJournal({ read: () => store.readRelocation(id), write: (f) => store.writeRelocation(id, f) }),
    get inst() { return store.projectInstance(projectId, MAIN); },
    docker: { docker, dockerIn },
    steps, creation: creation || {},
    report: { ...(row.report && typeof row.report === "object" ? row.report : {}) },
    row: () => store.readRelocation(id),
    log(text) {
      const rowText = `${new Date().toISOString()} ${text}`;
      console.log(`[relocation] ${projectId}: ${text}`);
      try { fs.appendFileSync(logFile, `${rowText}\n`, { mode: 0o600 }); } catch { /* the location is missing (restart grace after manual work) — the console is enough */ }
    },
  };
}

// The whole list of an acknowledged write layer (paths as JSON, one line per path) in the relocation location; the report
// carries the file name. Without the collected data (a test seam without `data`) it is null there.
function writeDismissed(ctx, q, plan, data) {
  const c = (plan.container || []).find((x) => x.name === q.container);
  const diff = c && data?.diffs ? data.diffs[c.id] : null;
  if (!Array.isArray(diff)) return null;
  const targets = (c.mounts || []).map((m) => m?.target).filter((z) => typeof z === "string" && z.startsWith("/"));
  const name = `dismissed/${String(q.container).replace(/[^A-Za-z0-9_.-]/g, "_")}.jsonl`;
  try { writeFile(ctx, name, diffData(diff, targets).map((p) => JSON.stringify(p)).join("\n") + "\n"); return name; }
  catch (e) { ctx.log(`list of the discarded write layer of ${q.container} not written: ${short(e)}`); return null; }
}

function writeFile(ctx, name, text) {
  const target = path.join(ctx.relocationLocation, name);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, text, { mode: 0o600 });
  return target;
}

// What was created inside (section `insideIds`): an object whose parts are added one by one — each BEFORE the effect that
// creates it.
async function noteInside(ctx, part) {
  const now = ctx.row()?.insideIds;
  await ctx.journal.note({ insideIds: { ...(now && typeof now === "object" ? now : {}), ...part } });
}
const inside2 = (ctx) => ctx.row()?.insideIds || {};

function setPhase(ctx, phase) {
  const z = store.projectInstance(ctx.projectId, MAIN);
  if (z?.state === "relocation") setInstanceState(ctx.projectId, MAIN, "relocation", { phase, error: z.error || "" });
}

// ── docker: reading ─────────────────────────────────────────────────────────────────────────────────────────────────

async function inspectB(ids) {
  if (!ids.length) return new Map();
  let text;
  try { text = (await docker(["inspect", "--type", "container", ...ids], { capMs: relocationCapMs("call") })).stdout; }
  catch (e) { if (!isMissing(e)) throw e; text = e.stdout; }
  let list = [];
  try { list = JSON.parse(text || "[]"); } catch { list = []; }
  return new Map(list.map((c) => [String(c.Id), c]));
}

async function inspectOne(args) {
  try { return JSON.parse((await docker(args, { capMs: relocationCapMs("call") })).stdout || "[]")[0] || null; }
  catch (e) { if (isMissing(e)) return null; throw e; }
}

async function allContainerB() {
  const ids = idsFrom((await docker(["ps", "-aq", "--no-trunc"], { capMs: relocationCapMs("call") })).stdout);
  return [...(await inspectB(ids)).values()];
}

// The `Config.Labels` of the images of these containers (image id → labels, `{}` without) — a label a container merely
// inherited from its image does not make it one of cbase's (../own-labels.js). An image that cannot be read is missing
// from the map (unknown: the cbase key on the container counts alone).
async function imageLabelsB(container) {
  const ids = [...new Set(container.map((c) => String(c?.Image || "")).filter(Boolean))];
  if (!ids.length) return new Map();
  let text;
  try { text = (await docker(["image", "inspect", ...ids], { capMs: relocationCapMs("call") })).stdout; }
  catch (e) { if (!isMissing(e)) throw e; text = e.stdout; }
  let list = [];
  try { list = JSON.parse(text || "[]"); } catch { list = []; }
  return new Map((Array.isArray(list) ? list : []).filter((i) => i?.Id && i?.Config && typeof i.Config === "object")
    .map((i) => [String(i.Id), i.Config.Labels && typeof i.Config.Labels === "object" ? i.Config.Labels : {}]));
}

async function insideInspect(container) {
  const d = relocationCapMs("call");
  const ids = idsFrom((await dockerIn(container, ["ps", "-aq", "--no-trunc"], { capMs: d })).stdout);
  if (!ids.length) return [];
  return JSON.parse((await dockerIn(container, ["inspect", ...ids], { capMs: d })).stdout || "[]");
}

function hashesFrom(text) {
  const m = new Map();
  for (const row of String(text || "").split("\n")) {
    const [service, hash] = row.trim().split(/\s+/);
    if (service && hash) m.set(service, hash);
  }
  return m;
}

// The containers a relocation replicates: all of the plan except one-off containers (`compose run` — `up` does not create
// them; the report lists them as not transferred).
const replicated = (plan) => (plan?.container || []).filter((c) => !c.oneoff);
const desiredHashesFromPlan = (plan) => Object.fromEntries(replicated(plan).map((c) => [c.name, c.configHash]));

function hashDeviations(insideList, desiredHash) {
  const byName = new Map(insideList.map((c) => [nameOf(c), c]));
  const deviation = [];
  for (const [name, hash] of Object.entries(desiredHash)) {
    const c = byName.get(name);
    if (!c) { deviation.push(`${name}: missing inside`); continue; }
    const actual = c.Config?.Labels?.[LABEL.hash];
    if (!hash || actual !== hash) deviation.push(`${name}: config-hash differs`);
  }
  return deviation;
}

// ── compose in the project container ────────────────────────────────────────────────────────────────────────────────
// `compose config` prints resolved values, and a Compose error can name a value. A failed call therefore passes on ONLY
// kind, exit code and the first stderr line — never stdout, never the docker error object — and every value from the
// `.env*` files of the set (the `--env-file` files, otherwise `<folder>/.env`, plus every `.env*` directly in the folder)
// is blacked out in it. The files are foreign data (writable in the project container): they are read only for blacking
// out, none over 1 MiB, no symlink. Values from `env_file:` of a Compose file are not on this list (a named residual risk).
// RATHER BLACK OUT TOO MUCH. Taking only `KEY=value` literally is not enough — `KEY=secret # prod` would put
// "secret # prod" on the list while compose-go interpolates "secret". So per line ALL readings go on it
// (`envInterpretations`): the whole rest, without quotes, the content up to the closing quote (across lines too, with
// and without `\n` resolution, and each line of it), without the comment from `#` after whitespace AND from any `#`,
// `KEY: value` like `KEY=value`, and every fragment of three characters or more (split at whitespace, quotes, `#`,
// `${…}`/`$NAME`). An error line gets harder to read that way, but a value never becomes visible. The parser in
// env-key.js deliberately hands out no values.
export function envInterpretations(text) {
  const values = new Set();
  const take = (w) => { const x = String(w ?? "").trim(); if (x.length >= 3) values.add(x); };
  const chunks = (w) => { for (const t of String(w).split(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|[\s"'`#]+/)) take(t); };
  const rows = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*(.*)$/);
    if (!m) continue;
    const rest = m[1];
    take(rest);
    take(rest.replace(/^(["'`])(.*)\1$/, "$2"));
    take(rest.replace(/\s+#.*$/, ""));
    take(rest.replace(/#.*$/, ""));
    chunks(rest);
    const q = rest[0];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    // The content up to the closing (unescaped) quote — across lines, like compose-go.
    let content = rest.slice(1);
    let j = i;
    const end = (t) => { for (let k = 0; k < t.length; k++) { if (t[k] === "\\" && q === '"') { k++; continue; } if (t[k] === q) return k; } return -1; };
    let e = end(content);
    while (e < 0 && j + 1 < rows.length) { j++; content += `\n${rows[j]}`; e = end(content); }
    const value = e < 0 ? content : content.slice(0, e);
    for (const w of [value, q === '"' ? value.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c)) : value]) {
      take(w);
      for (const z of w.split("\n")) { take(z); chunks(z); }
    }
    for (let k = i + 1; k <= j; k++) take(rows[k]);
  }
  return values;
}

function envValues(g) {
  const files = new Set(g.envFiles?.length ? g.envFiles : [path.join(g.folder, ".env")]);
  try { for (const n of fs.readdirSync(g.folder)) if (n.startsWith(".env")) files.add(path.join(g.folder, n)); } catch { /* no folder */ }
  const values = new Set();
  for (const f of files) {
    let text;
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile() || st.size > 1 << 20) continue;
      text = fs.readFileSync(f, "utf8");
    } catch { continue; }
    for (const w of envInterpretations(text)) values.add(w);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

async function composeIn(ctx, step, g, args) {
  try {
    return await dockerIn(containerName(ctx.projectId), args, { capMs: relocationCapMs("compose") });
  } catch (e) {
    let row = String(e?.stderr || "").split("\n").map((z) => z.trim()).find(Boolean) || "";
    for (const w of envValues(g)) row = row.split(w).join("***");
    const kind = args.includes("--dry-run") ? "up --dry-run" : args.includes("--hash") ? "config --hash" : args.includes("config") ? "config --format json" : "up --no-start";
    const reason = e?.code === "CAP" ? "cap hit" : `Exit ${e?.code ?? "?"}`;
    throw stepError(step, `compose ${kind} (${g.project}) in the project container failed (${reason})${row ? `: ${row.slice(0, 300)}` : ""}`);
  }
}

// ── Helper: manifest and copy ───────────────────────────────────────────────────────────────────────────────────────

// The manifest program lies in B under /usr/local/bin (Dockerfile, stage backend) and is bound READ-ONLY into the helper
// at the same path — in B, in the helper and in the project container THE SAME program measures. Test seam:
// CBASE_MANIFEST_PROGRAM is the source in B (on a Mac /usr/local/bin/cbase-manifest does not exist).
const manifestMount = () => ({ type: "bind", source: process.env.CBASE_MANIFEST_PROGRAM || MANIFEST_PROGRAM, target: MANIFEST_PROGRAM, onlyRead: true });

const helperLabels = (ctx) => ({ [LABEL_RELOCATION]: String(ctx.relocationId) });

// The manifest goes as a STREAM into its file in the relocation location (docker.js `stdoutFile`) and is checked line by
// line — never as one string in B (a volume with 1 million entries: ≈ 258 MB of text, as a map ≈ 1.7 GB of heap).
const manifestFile = (ctx, name, page) => path.join(ctx.relocationLocation, "manifests", `${name}.${page}.jsonl`);

async function withStream(file, fn) {
  const stream = fs.createReadStream(file);
  try { return await fn(stream); } finally { stream.destroy(); }
}

async function measure(h, root, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await executeHelper(h, manifestArgv(root), { capMs: relocationCapMs("manifest"), stdoutFile: file });
  const m = await withStream(file, checkManifestStream);
  if (!m.ok) throw new Error(`manifest of ${root} invalid: ${m.error}`);
  return m;
}

// A volume that `--mount type=volume` is to mount must EXIST — docker would silently create a missing one EMPTY, turning
// "missing" into "empty" (desired empty, copy empty, check green, and an empty unlabelled volume in B).
async function volumesExist(step, names) {
  const missing = [];
  for (const n of names) if (!(await inspectOne(["volume", "inspect", n]))) missing.push(n);
  if (missing.length) throw stepError(step, `volume(s) vanished since the plan: ${missing.join(", ")} — not mounted (docker would silently create a missing volume empty)`);
}

// `cp -a` only lays things ON TOP — what lies in the target and is missing in the source would stay. The inner dockerd
// fills an anonymous volume on creation (`up --no-start`) from the image path (copy-up; owner and mode of the root
// likewise), and an empty named one too. Hence one target mode per pair:
//   "check"  (step 6, freshly created named volume) the target MUST be empty, otherwise a step error — nothing deleted
//            (a non-empty target is a leftover nobody can account for; the return path removes the project container
//            with its volume, the next attempt starts empty)
//   "clear"  (step 12, after the `up`) clear the target (`find -xdev -mindepth 1 -delete`), then check for emptiness —
//            what lies there came from the image of this relocation, the source in B stays untouched
//   `onlyIfSourceEmpty`  (step 12, named volumes) only when the SOURCE is empty: only then was the target empty on `up`
//            and could the copy-up fill it; a source with content was already copied in step 6 and stays as it is.
// The root of the target gets its mode, owner and times back from the source (`cp -a <source>/. <target>`).
const findOne = (dir) => ["find", dir, "-mindepth", "1", "-maxdepth", "1", "-print", "-quit"];
async function empty(h, dir) {
  const r = await executeHelper(h, findOne(dir), { capMs: relocationCapMs("call") });
  return String(r.stdout || "").trim() === "";
}

// Copy pairs { source: volume in B, target: volume inside, targetMode, onlyIfSourceEmpty? } with `cp -a` — one helper,
// source read-only.
async function copy(ctx, pairs, step) {
  if (!pairs.length) return;
  const sources = [...new Set(pairs.map((p) => checkVolumeName(p.source)))];
  await volumesExist(step, sources);
  const mounts = [
    ...sources.map((q) => ({ type: "volume", source: q, target: SOURCE(q), onlyRead: true })),
    { type: "volume", source: volumeName(ctx.projectId), target: TARGET, onlyRead: false },
  ];
  await withHelper({ kind: "relocation", projectId: ctx.projectId, mounts, labels: helperLabels(ctx) }, async (h) => {
    for (const p of pairs) {
      checkVolumeName(p.target);
      const target = targetData(p.target);
      if (!["clear", "check"].includes(p.targetMode)) throw new TypeError(`copy: target mode "${p.targetMode}"`);
      if (p.onlyIfSourceEmpty && !(await empty(h, SOURCE(p.source)))) continue;
      if (p.targetMode === "clear") await executeHelper(h, ["find", target, "-xdev", "-mindepth", "1", "-delete"], { capMs: relocationCapMs("copy") });
      if (!(await empty(h, target))) throw stepError(step, `the target inside for ${p.source} (${p.target}) is not empty before the copy${p.targetMode === "check" ? " — a leftover in the volume of the project container; nothing deleted, the return path removes it" : ""}`);
      await executeHelper(h, ["cp", "-a", "--", `${SOURCE(p.source)}/.`, target], { capMs: relocationCapMs("copy") });
      ctx.log(`volume ${p.source} → inside ${p.target} copied${p.onlyIfSourceEmpty ? " (empty source, again after the copy-up)" : ""}`);
    }
  });
}

// ── Forward ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function stepCreation(ctx) {
  const { projectId, project, workspace, creation } = ctx;
  // CLI home and trust entry BEFORE the creation (the creation only checks that the home exists).
  createCliHome(projectId, creation.home ? { home: creation.home } : {});
  enterCodexTrust({ ...(creation.home ? { configPath: path.join(creation.home, ".codex", "config.toml") } : {}), wsPath: workspace?.path, projectPath: project.path });
  const z = store.projectInstance(projectId, MAIN);
  if (z?.containerId && z.state === "relocation") { ctx.log("creation: the project container already exists"); return; }
  // If the volume of the project container already lay in B BEFORE the creation (left over from an earlier instance; the
  // plan holds on it, `project-volume-existing`), the return path does not remove it — noted BEFORE the effect, once.
  if (inside2(ctx).volumeFound === undefined) {
    const v = await inspectOne(["volume", "inspect", volumeName(projectId)]);
    await noteInside(ctx, { volumeFound: Boolean(v) });
    if (v) ctx.log(`creation: the volume ${volumeName(projectId)} already lay in B — the return path does not remove it`);
  }
  await createInstance(projectId, { ...creation, state: "relocation", occupancyHeld: true });
  ctx.log("project container created");
}

// `config --hash` is the hash that `up` writes into the label only for services WITHOUT `env_file` (with env_file NEVER
// equal, and blind to its content). A differing service WITH env_file is therefore no finding of the dry run — it shows
// with its reason in `report.dryrun.withoutHash` (names only), and equality (8) compares it after the stop with the hash
// of `up` (return path on a deviation). How "has env_file" is recognised: Compose's own model (compose-config.js
// `configModelArgs`) — asked only when a service differs, once per Compose project; its output is never logged, only the
// service names remain. A service `config --hash` does not name at all, or one without a label, stays a finding (the
// hash is missing, not just the oracle).
//
// A volume WITHOUT a Compose label (plan.js `volume-without-label`) only moves along when Compose's model of its Compose
// project names it as its own volume (resolved name, not `external`) — Compose keeps using an existing unlabelled volume
// with a warning and never sets a label. And every existing volume in B that the model names as its own must move along:
// otherwise `up` would create an empty one inside while the old state stayed in B (two states). For this the model is
// asked ONCE per Compose project (even without a differing service); only names leave it. If a volume name there carries
// a `$` (under `--no-interpolate` an interpolated `name:` stays literal), the step asks for the volumes a second time
// with interpolation (compose-config.js `configVolumesArgs`). The verdict is pure: `volumeVerdict` (below).
async function stepDryrun(ctx) {
  const byName = new Map(replicated(ctx.plan).map((x) => [x.name, x]));
  const inB = new Set(String((await docker(["volume", "ls", "-q"], { capMs: relocationCapMs("call") })).stdout || "").split("\n").map((s) => s.trim()).filter(Boolean));
  const deviation = [];
  const withoutHash = [];
  const groups = [];
  for (const g of ctx.plan.compose || []) {
    const r = await composeIn(ctx, "dryrun", g, configHashArgs(g));
    const actual = hashesFrom(r.stdout);
    const deviating = [];
    for (const name of g.container || []) {
      const x = byName.get(name);
      if (!x) continue;
      if (!x.configHash || actual.get(x.service) !== x.configHash) deviating.push(x);
    }
    let withEnvFile;
    let vols;
    try {
      const model = (await composeIn(ctx, "dryrun", g, configModelArgs(g))).stdout;
      withEnvFile = servicesWithEnvFile(model);
      vols = modelVolumes(model);
      if ([...vols.keys()].some((n) => n.includes("$"))) vols = modelVolumes((await composeIn(ctx, "dryrun", g, configVolumesArgs(g))).stdout);
    } catch (e) { throw e instanceof ComposeConfigError ? stepError("dryrun", `dry run (${g.project}): ${e.message}`) : e; }
    for (const x of deviating) {
      if (x.configHash && actual.has(x.service) && withEnvFile.has(x.service)) withoutHash.push({ name: x.name, service: x.service, project: g.project, reason: "env_file" });
      else deviation.push(`${x.name} (service ${x.service}, Compose project ${g.project})`);
    }
    groups.push({ project: g.project, container: g.container || [], vols });
  }
  const verdict = volumeVerdict({ named: ctx.plan.volumes?.named || [], groups, inB });
  ctx.report.dryrun = { withoutHash, volumesWithoutLabel: verdict.checked };
  await ctx.journal.note({ report: ctx.report });
  if (deviation.length) throw stepError("dryrun", `dry run: config --hash differs from the label — ${deviation.join(", ")}`);
  if (verdict.error.length) throw stepError("dryrun", `dry run: volumes — ${verdict.error.join("; ")}`);
  ctx.log(`dry run: hashes equal${withoutHash.length ? `; without hash comparison (env_file, equality checks them): ${withoutHash.map((x) => x.name).join(", ")}` : ""}${verdict.checked.length ? `; volumes without a Compose label checked against the model: ${verdict.checked.map((x) => x.volume).join(", ")}` : ""}`);
}

/** The verdict of the dry run on the volumes (header of stepDryrun), pure. `named` the plan rows (`withoutLabel` =
 *  Compose project), `groups` per file set { project, container: [name], vols: modelVolumes(…) }, `inB` the volume names
 *  in B. A volume without a label must appear as its own (not `external`) in the model of EVERY file set of its project
 *  whose containers mount it; in the other file sets of the same project it just must not be `external` (a project with
 *  two `-f` sets does not name every volume in both). A name that still carries a `$` after interpolation cannot be
 *  checked. → { error: [text], checked: [{ volume, project, key }] } */
export function volumeVerdict({ named = [], groups = [], inB = new Set() } = {}) {
  const error = [];
  const checked = [];
  const pullsWith = new Set(named.map((v) => v.name));
  for (const g of groups) {
    for (const name of g.vols.keys()) if (name.includes("$")) error.push(`${name}: not resolved in the model of ${g.project} — cannot be checked`);
  }
  for (const v of named.filter((x) => x.withoutLabel)) {
    const own = groups.filter((g) => g.project === v.withoutLabel);
    const hang = own.filter((g) => (v.container || []).some((n) => g.container.includes(n)));
    if (!hang.length) { error.push(`${v.name} (without a Compose label): no file set of ${v.withoutLabel} has a container that mounts it`); continue; }
    const prior = error.length;
    for (const g of own) {
      const m = g.vols.get(v.name);
      if (hang.includes(g) && !m) error.push(`${v.name} (without a Compose label): the model of ${g.project} does not name it`);
      else if (m?.external) error.push(`${v.name} (without a Compose label): \`external\` in the model of ${g.project} — its owner is not this project`);
    }
    if (error.length === prior) checked.push({ volume: v.name, project: v.withoutLabel, key: hang[0].vols.get(v.name).key });
  }
  for (const g of groups) {
    for (const [name, m] of g.vols) {
      if (!m.external && inB.has(name) && !pullsWith.has(name)) error.push(`${name}: the model of ${g.project} names it as its own volume, it lies in B and would not move along (no container mounts it)`);
    }
  }
  return { error: [...new Set(error)], checked };
}

// The plan was made BEFORE lock and idle (a turn or a terminal could run `compose up -d worker` in between). This step
// runs after both — it reads the set again: every container whose working_dir lies under the project folder (the same
// rule as plan.js and collect.js), and every OTHER container that mounts a volume of the plan (`volume-shared` only knew
// the containers at plan time). What is not in the plan is a deviation — nothing is stopped yet then, the return path has
// nothing to bring back. A container of cbase (own label ON the container, ../own-labels.js — one inherited from the
// image does not count, `image` holds the image labels) is NOT exempt but a deviation just the same, as soon as it mounts
// a volume of the plan or its `working_dir` lies in the project folder (like plan.js `container-excluded`).
function deviationsFromPlan(ctx, all, image = new Map()) {
  const plan = ctx.plan;
  const root = realPath(plan.projectPath || ctx.project.path);
  const inPlan = new Set(plan.container.map((c) => String(c.id)));
  const planVolumes = new Set([...(plan.volumes?.named || []), ...(plan.volumes?.anonym || [])].map((v) => v.name));
  const deviation = [];
  for (const c of all) {
    const l = labelsOf(c);
    if (inPlan.has(String(c.Id))) continue;
    const own = ownKey(l, image.has(String(c.Image)) ? image.get(String(c.Image)) : null);
    const ownNote = own.length ? ` (left out as a container of cbase: ${own.join(", ")})` : "";
    const wd = l[LABEL.folder];
    if (wd && inArea(realPath(wd), [root])) { deviation.push(`${nameOf(c)}${ownNote}: ${own.length ? "working_dir in the project" : "added since the plan (working_dir in the project)"}`); continue; }
    const shared = [...new Set((c.Mounts || []).filter((m) => m?.Type === "volume" && planVolumes.has(m.Name)).map((m) => m.Name))];
    if (shared.length) deviation.push(`${nameOf(c)}${ownNote}: mounts ${shared.join(", ")} — a volume of this relocation`);
  }
  return deviation;
}

async function stopStep(ctx) {
  const plan = ctx.plan;
  const all = await allContainerB();
  const deviation = deviationsFromPlan(ctx, all, await imageLabelsB(all));
  if (deviation.length) throw stepError("stop", `the containers deviate from the plan (read again after lock and idle): ${deviation.join("; ")} — the relocation holds, nothing stopped`);
  const inPlan = new Set(plan.container.map((c) => String(c.id)));
  const now = new Map(all.filter((c) => inPlan.has(String(c.Id))).map((c) => [String(c.Id), c]));
  const gone = plan.container.filter((c) => !now.has(c.id)).map((c) => c.name);
  if (gone.length) throw stepError("stop", `container(s) vanished since the plan: ${gone.join(", ")}`);
  // First look (before any effect): does a process in B work in the project folder that does not belong to the groups of
  // the native runs this step is about to end? One may have started since the plan, and a terminal the lock ended may
  // have left a survivor behind (nohup). A descendant of one of these groups in a group of its own does not count here
  // (it may end with the group) — that is the second look.
  await noProcessesDarin(ctx, nativeRuns(ctx.projectId).map((l) => l.pid), "before the first stop — nothing stopped", { descendantsCount: false });
  const list = plan.container.map((c) => {
    const i = now.get(c.id);
    return {
      id: c.id, name: c.name, service: c.service, composeProject: c.composeProject, state: i.State?.Status || c.state,
      exitCode: i.State?.ExitCode ?? c.exitCode ?? null, restart: policyText(i.HostConfig?.RestartPolicy), image: c.image,
      composeImage: c.composeImage, configHash: c.configHash, oneoff: Boolean(c.oneoff), mounts: c.mounts || [],
    };
  });
  const policies = Object.fromEntries(list.map((c) => [c.id, c.restart]));
  const native = nativeRuns(ctx.projectId).map((l) => l.serviceId);
  // Journal BEFORE the effect: what ran, with which policy, which native services — the return path restores exactly that.
  await ctx.journal.note({ container: { list, native }, policies });
  const byName = new Map(list.map((c) => [c.name, c]));
  const followUp = [...plan.stopFollowUp, ...list.map((c) => c.name).filter((n) => !plan.stopFollowUp.includes(n))];
  for (const name of followUp) {
    const c = byName.get(name);
    if (!c || !RUNNING.has(c.state)) continue;
    await docker(["stop", "-t", "30", c.id], { capMs: relocationCapMs("stop") });
    ctx.log(`stopped: ${c.name}`);
  }
  const withPolicy = list.filter((c) => c.restart && c.restart !== "no").map((c) => c.id);
  if (withPolicy.length) await docker(["update", "--restart=no", ...withPolicy], { capMs: relocationCapMs("call") });
  if (native.length) {
    const r = await endNativeRuns(ctx.projectId, native);
    ctx.log(`native services ended: ${r.ended.join(", ")}${r.hart.length ? ` (hard: ${r.hart.join(", ")})` : ""}`);
  }
  // Second look — after ending the native runs, WITHOUT exception: now nothing works in the project folder in B any more,
  // or the relocation goes back (before the turnaround; the return path restarts containers and native services).
  await noProcessesDarin(ctx, [], "after ending the native services");
  await desiredManifests(ctx);
}

// A relocation leaves no process behind in B that works in the project (./processes.js) — nor one in a worktree that
// step 13 moves. Unknown (/proc not readable) holds just like a hit. The message names only pid, program and start time
// per process.
async function noProcessesDarin(ctx, exempt, when, { descendantsCount = true } = {}) {
  const additional = (ctx.plan?.worktrees?.move || []).map((w) => w?.path).filter(Boolean);
  const all = await remainingProcesses({ projectPath: ctx.plan?.projectPath || ctx.project.path, additional, exempt });
  const p = all === null ? null : all.filter((x) => descendantsCount || !x.descendant);
  if (p === null) throw stepError("stop", `the processes of B are not readable (/proc) — whether one works in the project folder is unknown (${when}); the relocation holds`);
  if (p.length) {
    throw stepError("stop", `processes in B work in the project folder or in a worktree the relocation moves (working directory, program or an open file lies in there; ${when}): ${p.map(processRow).join("; ")} — way out: end them or run them as a service in cbase, close an open terminal in the project, then try again; the relocation holds`);
  }
}

async function desiredManifests(ctx) {
  const vols = [...new Set([...(ctx.plan.volumes?.named || []).map((v) => v.name), ...(ctx.plan.volumes?.anonym || []).map((v) => v.name)])];
  if (!vols.length) return;
  vols.forEach(checkVolumeName);
  await volumesExist("stop", vols);
  const mounts = [...vols.map((n) => ({ type: "volume", source: n, target: SOURCE(n), onlyRead: true })), manifestMount()];
  await withHelper({ kind: "relocation", projectId: ctx.projectId, mounts, labels: helperLabels(ctx) }, async (h) => {
    for (const n of vols) await measure(h, SOURCE(n), manifestFile(ctx, n, "desired"));
  });
  ctx.log(`desired manifest of ${vols.length} volume(s) at the stopped source`);
}

async function stepImages(ctx) {
  const images = ctx.plan.images || [];
  if (!images.length) return;
  const withoutTag = images.filter((i) => !i.tags?.length).map((i) => normId(i.id).slice(0, 12));
  if (withoutTag.length) throw stepError("images", `image(s) without a tag: ${withoutTag.join(", ")} — a stream without names would arrive inside without a tag`);
  await noteInside(ctx, { images: images.map((i) => i.id) });
  const tags = [...new Set(images.flatMap((i) => i.tags))];
  const c = containerName(ctx.projectId);
  // The stream (mandatory): `docker save` in B → `docker exec -i <c> docker load` inside, never through a file.
  const source = dockerKind(["save", ...tags], { stdio: ["ignore", "pipe", "pipe"] });
  let errorText = "";
  source.stderr.on("data", (b) => { if (errorText.length < 4096) errorText += b; });
  const end = new Promise((resolve) => {
    source.on("error", (e) => resolve({ code: null, reason: e.message }));
    source.on("close", (code, signal) => resolve({ code, reason: signal ? `ended by ${signal}` : `Exit ${code}` }));
  });
  try {
    await docker(["exec", "-i", "-u", "agent", c, "docker", "load"], { stdin: source.stdout, capMs: relocationCapMs("image") });
  } catch (e) {
    try { source.kill("SIGKILL"); } catch { /* already gone */ }
    await end;
    throw e;
  }
  const r = await end;
  if (r.code !== 0) throw stepError("images", `docker save: ${errorText.split("\n").find(Boolean) || r.reason}`);
  for (const i of images) {
    const id = (await dockerIn(c, ["image", "inspect", "--format", "{{.Id}}", i.tags[0]], { capMs: relocationCapMs("call") })).stdout.trim();
    if (normId(id) !== normId(i.id)) throw stepError("images", `image ${i.tags[0]} arrived inside with a different id`);
  }
  ctx.log(`${images.length} image(s) transferred as a stream`);
}

async function stepVolumes(ctx) {
  const named = ctx.plan.volumes?.named || [];
  if (!named.length) return;
  named.forEach((v) => checkVolumeName(v.name));
  await noteInside(ctx, { volumes: named.map((v) => v.name) });
  const c = containerName(ctx.projectId);
  for (const v of named) {
    const labels = Object.entries(v.labels || {}).flatMap(([k, w]) => ["--label", `${k}=${w}`]);
    await dockerIn(c, ["volume", "create", ...labels, v.name], { capMs: relocationCapMs("call") });
  }
  await copy(ctx, named.map((v) => ({ source: v.name, target: v.name, targetMode: "check" })), "volumes");
}

async function stepNetworks(ctx) {
  const networks = ctx.plan.networks?.itself || [];
  if (!networks.length) return;
  await noteInside(ctx, { networks });
  const c = containerName(ctx.projectId);
  for (const n of networks) {
    try { await dockerIn(c, ["network", "create", n], { capMs: relocationCapMs("call") }); }
    catch (e) { if (!/already exists/i.test(`${e?.stderr || ""}${e?.message || ""}`)) throw e; }
  }
  ctx.log(`${networks.length} network(s) without labels created inside`);
}

async function stepEquality(ctx) {
  const c = containerName(ctx.projectId);
  // The ids only come into being on `up` — BEFORE it the names of the containers it creates go into the journal (the ids
  // afterwards). rw-container removes the whole project container anyway; the report of a crash right in between names them.
  await noteInside(ctx, { containerNames: replicated(ctx.plan).map((x) => x.name) });
  for (const g of ctx.plan.compose || []) {
    await composeIn(ctx, "equality", g, upWithoutStartArgs(g, g.services));
  }
  const list = await insideInspect(c);
  await noteInside(ctx, { container: list.map((x) => x.Id) });
  const deviation = hashDeviations(list, desiredHashesFromPlan(ctx.plan));
  if (deviation.length) throw stepError("equality", `equality (12a) not given: ${deviation.join(", ")}`);
  ctx.log("equality: hash == label for every container");
}

// The place of a (perhaps already missing) file with the real path of its folder — a comparison across symlinks.
function realLocation(p) {
  const abs = path.resolve(p);
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}

function composeArgs(g, files) {
  const args = ["-p", g.project, "--project-directory", g.folder];
  for (const d of files) args.push("-f", d);
  for (const e of g.envFiles || []) args.push("--env-file", e);
  return args;
}

// A trial run inside (compose-config.js `upDryrunArgs`/`dryrunVerdict`): Compose's own verdict on the containers `names` —
// stdout AND stderr, because Compose writes its progress to stderr. Unreadable output is an error.
async function dryrun(ctx, k, names, { allNew = false } = {}) {
  const r = await composeIn(ctx, "new-hash", k, upDryrunArgs(k, k.services, { allNew }));
  try { return dryrunVerdict(`${r.stdout || ""}\n${r.stderr || ""}`, names); }
  catch (e) { throw e instanceof ComposeConfigError ? stepError("new-hash", `12b (${k.project}): ${e.message}`) : e; }
}
const verdictText = (u) => [
  u.fresh.length ? `to be recreated ${u.fresh.join(", ")}` : "", u.missing.length ? `missing inside ${u.missing.join(", ")}` : "",
  u.foreign.length ? `not in the plan ${u.foreign.join(", ")}` : "", u.unclear.length ? `unclear ${u.unclear.map((x) => `${x.name} (${x.words.join("/")})`).join(", ")}` : "",
].filter(Boolean).join("; ");

// Step 10 (12b): which containers must be recreated is decided by Compose in a trial run — not by `config --hash` (for a
// service with env_file never the hash of `up`, and blind to the content of the env_file that the port dismantling may
// change). Per Compose project, with exactly the files, the project name and the services of the `up`:
//   1. the CONTROL with `--force-recreate`: every plan container must report "Recreate", otherwise the output is not
//      readable (an empty output would otherwise silently mean "nothing new" — say after a change of format or stream);
//   2. the trial run: "Recreate" ⇒ to be recreated; "Creating" of a plan container ⇒ it is missing inside (error); a
//      container outside the plan with a change, or an unknown word ⇒ error;
//   3. `up --no-start` only for the services to be recreated (their names are in the journal BEFOREHAND, `insideIds.createNew`);
//   4. a second trial run: no plan container may report anything any more.
// Then the desired hash (`insideIds.desiredHash`, read by 14a, `recheck` and the restart grace): for every recreated
// container its label inside (the hash of `up`), for all others the label from B (equality in 8 confirmed it inside) —
// and the list inside must match.
async function stepNewHash(ctx) {
  const plan = ctx.plan;
  const projectPath = plan.projectPath || ctx.project.path;
  // The override files the dismantling (9) put aside: named in the plan AND no longer there. Compared through the REAL
  // folder: the Compose labels carry the path Compose saw, the plan the one of the store — if either points through a
  // symlink, the file put aside would otherwise not drop out, and Compose would fail on it ("no such file") ⇒ a return
  // path without cause.
  const dropped = new Set((plan.dismantling?.overrides || []).map((o) => path.resolve(projectPath, o.file)).filter((p) => !fs.existsSync(p)).map(realLocation));
  const desiredHash = desiredHashesFromPlan(plan);
  const byName = new Map(replicated(plan).map((x) => [x.name, x]));
  const c = containerName(ctx.projectId);
  const changedAll = [];
  const newAll = [];
  for (const g of plan.compose || []) {
    const names = (g.container || []).filter((n) => byName.has(n));
    if (!names.length) continue;
    const files = (g.files || []).filter((d) => !dropped.has(realLocation(d)));
    if (!files.length) throw stepError("new-hash", `Compose project ${g.project}: without the override file no Compose file remains`);
    const k = { ...g, files, args: composeArgs(g, files) };
    const control = await dryrun(ctx, k, names, { allNew: true });
    const blind = names.filter((n) => !control.fresh.includes(n));
    if (blind.length) throw stepError("new-hash", `12b (${g.project}): the control with --force-recreate does not report ${blind.join(", ")} as "Recreate" — the verdict of Compose is not readable, nothing recreated`);
    const otherwise = verdictText({ ...control, fresh: [] });
    if (otherwise) throw stepError("new-hash", `12b (${g.project}), control: ${otherwise}`);
    const prior = await dryrun(ctx, k, names);
    if (prior.missing.length || prior.foreign.length || prior.unclear.length) throw stepError("new-hash", `12b (${g.project}): ${verdictText(prior)}`);
    if (prior.fresh.length) {
      const services = prior.fresh.map((n) => byName.get(n).service);
      await noteInside(ctx, { createNew: [...new Set([...(inside2(ctx).createNew || []), ...prior.fresh])] });
      await composeIn(ctx, "new-hash", k, upWithoutStartArgs(k, services));
      changedAll.push(...[...new Set(services)].map((d) => `${g.project}/${d}`));
      newAll.push(...prior.fresh);
    }
    const after = await dryrun(ctx, k, names);
    const open = verdictText(after);
    if (open) throw stepError("new-hash", `12b (${g.project}): after recreating Compose still reports: ${open}`);
  }
  const list = await insideInspect(c);
  const inside = new Map(list.map((x) => [nameOf(x), x]));
  for (const n of newAll) {
    const h = inside.get(n)?.Config?.Labels?.[LABEL.hash];
    if (!h) throw stepError("new-hash", `12b: ${n} carries no label config-hash inside after recreating`);
    desiredHash[n] = h;
  }
  await noteInside(ctx, { desiredHash });
  const deviation = hashDeviations(list, desiredHash);
  if (deviation.length) throw stepError("new-hash", `12b: ${deviation.join(", ")}`);
  ctx.report.newlyCreated = changedAll;
  ctx.log(changedAll.length ? `12b: recreated ${changedAll.join(", ")}` : "12b: no service changed");
}

async function stepAnonym(ctx) {
  const anon = ctx.plan.volumes?.anonym || [];
  if (!anon.length && !(ctx.plan.volumes?.named || []).length) return;
  const list = anon.length ? await insideInspect(containerName(ctx.projectId)) : [];
  const byName = new Map(list.map((x) => [nameOf(x), x]));
  const pairs = anon.map((a) => {
    const x = byName.get(a.container);
    const m = (x?.Mounts || []).find((mm) => mm.Type === "volume" && mm.Destination === a.target);
    if (!m?.Name) throw stepError("anonymous-volumes", `no anonymous volume inside for ${a.container}:${a.target}`);
    return { source: a.name, target: m.Name, container: a.container, path: a.target };
  });
  if (pairs.length) await noteInside(ctx, { anonym: pairs });
  // The copy-up filled anonymous targets on `up` — ALWAYS clear them; named ones only when their source is empty (see copy).
  await copy(ctx, [
    ...pairs.map((p) => ({ source: p.source, target: p.target, targetMode: "clear" })),
    ...(ctx.plan.volumes?.named || []).map((v) => ({ source: v.name, target: v.name, targetMode: "clear", onlyIfSourceEmpty: true })),
  ], "anonymous-volumes");
}

async function stepCheck(ctx) {
  const plan = ctx.plan;
  const c = containerName(ctx.projectId);
  const list = await insideInspect(c);
  const desired = replicated(plan);
  const deviation = [];
  const namesInside = new Set(list.map(nameOf));
  const namesDesired = new Set(desired.map((x) => x.name));
  for (const n of namesDesired) if (!namesInside.has(n)) deviation.push(`${n}: missing inside`);
  for (const n of namesInside) if (!namesDesired.has(n)) deviation.push(`${n}: surplus inside`);
  const byName = new Map(list.map((x) => [nameOf(x), x]));
  for (const x of desired) {
    const i = byName.get(x.name);
    if (i && normId(i.Image) !== normId(x.image)) deviation.push(`${x.name}: image id differs`);
  }
  const desiredHash = inside2(ctx).desiredHash || desiredHashesFromPlan(plan);
  deviation.push(...hashDeviations(list, desiredHash).filter((a) => !a.endsWith("missing inside")));
  // Manifests: every volume field-equal (without directory size and blocks — manifest.js).
  const pairs = [
    ...(plan.volumes?.named || []).map((v) => ({ desired: v.name, target: v.name })),
    ...((inside2(ctx).anonym) || []).map((a) => ({ desired: a.source, target: a.target })),
  ];
  const rows = [];
  if (pairs.length) {
    const mounts = [{ type: "volume", source: volumeName(ctx.projectId), target: TARGET, onlyRead: true }, manifestMount()];
    await withHelper({ kind: "relocation", projectId: ctx.projectId, mounts, labels: helperLabels(ctx) }, async (h) => {
      for (const p of pairs) {
        checkVolumeName(p.target);
        const isFile = manifestFile(ctx, p.target, "actual");
        await measure(h, targetData(p.target), isFile);
        const desiredFile = manifestFile(ctx, p.desired, "desired");
        if (!fs.existsSync(desiredFile)) { deviation.push(`${p.desired}: desired manifest missing`); continue; }
        // Both manifests as streams, line by line in a merge — never fully in memory.
        const res = await withStream(desiredFile, (desired) => withStream(isFile, (actual) => compareManifestStreams(desired, actual)));
        rows.push(...comparisonRows(res, p.desired));
        if (!res.equal) deviation.push(`${p.desired}: manifest differs`);
      }
    });
  }
  ctx.report.check = { container: desired.length, volumes: pairs.length, rows, passed: deviation.length === 0, deviations: deviation };
  await ctx.journal.note({ report: ctx.report });
  if (deviation.length) throw stepError("check", `check failed: ${deviation.join("; ")}`);
  ctx.log(`check passed: ${desired.length} container(s), ${pairs.length} volume(s)`);
}

// The project container runs and its dockerd answers (after a restart of B it is stopped) — idempotent.
async function saveProjectContainer(ctx) {
  const name = containerName(ctx.projectId);
  const c = await inspectOne(["inspect", "--type", "container", name]);
  if (!c) throw stepError("start", `the project container ${name} is missing`);
  if (c.Config?.Labels?.[LABEL_PROJECT] !== ctx.projectId) throw stepError("start", `${name} does not carry the label of this project`);
  const id = String(c.Id);
  if (c.State?.Status !== "running") {
    await docker(["start", id], { capMs: relocationCapMs("call") });
    const { status } = await waitForInside(id);
    if (status.phase !== "ready") throw stepError("start", `entrypoint reports phase=${status.phase}`);
  }
  return id;
}

// ── The ports of the native services after the start (header) ──────────────────────────────────────────────────────────
// `lsof` in the project container as agent (it is installed there; the services run as agent). Exit 1 without output means
// "nothing found"; everything else is "not measurable" and throws. Only integers are read from the output (pid, pgid,
// port) — never a path or name that B would follow.
async function lsofIn(container, args) {
  try {
    return (await docker(["exec", "-u", "agent", container, "lsof", "-nP", ...args], { capMs: relocationCapMs("call") })).stdout || "";
  } catch (e) {
    if (e?.code === 1 && !containerGone(e) && !/is not running/i.test(String(e?.stderr || ""))) return String(e?.stdout || "");
    throw e;
  }
}
function lsofRows(text) {
  const out = [];
  let pgid = null;
  for (const z of String(text || "").split("\n")) {
    if (z.startsWith("p")) pgid = null;
    else if (z.startsWith("g")) { const n = Number(z.slice(1)); pgid = Number.isSafeInteger(n) && n > 0 ? n : null; }
    else if (z.startsWith("n")) {
      const m = /:(\d{1,5})$/.exec(z.slice(1));
      const port = m ? Number(m[1]) : NaN;
      out.push({ pgid, port: port >= 1 && port <= 65535 ? port : null });
    }
  }
  return out;
}
const lsofGroups = (text) => new Set(String(text || "").split("\n").filter((z) => z.startsWith("g")).map((z) => Number(z.slice(1))).filter((n) => Number.isSafeInteger(n) && n > 0));
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function nativePortsRemeasure(ctx, containerId, native) {
  const pid = ctx.projectId;
  const rows = new Map(store.listProjectServices(pid).map((s) => [Number(s.id), s]));
  const result = [];
  const toMeasure = [];
  for (const id of native) {
    const s = rows.get(Number(id));
    if (!s) result.push({ id, finding: "without-row" });
    else if (s.port === null || s.port === undefined) result.push({ id, name: s.name, finding: "without-port" });
    else toMeasure.push(s);
  }
  if (!toMeasure.length) return result;
  const cap = relocationCapMs("port");
  const until = Date.now() + cap;
  let state = new Map();
  try {
    for (;;) {
      const listen = lsofRows(await lsofIn(containerId, ["-iTCP", "-sTCP:LISTEN", "-F", "pgn"]));
      const all = new Set(listen.map((x) => x.port).filter(Boolean));
      state = new Map();
      for (const s of toMeasure) {
        if (all.has(Number(s.port))) { state.set(s.id, { listens: true }); continue; }
        const groups = lsofGroups(await lsofIn(containerId, ["-F", "pg", "--", serviceLogFile(pid, s.id, MAIN)]));
        const own = [...new Set(listen.filter((x) => x.port && groups.has(x.pgid)).map((x) => x.port))].sort((a, b) => a - b);
        state.set(s.id, { listens: false, own });
      }
      if ([...state.values()].every((x) => x.listens)) break;
      if (Date.now() >= until) {
        ctx.log(`start: cap of ${cap} ms hit — not every native service listens on the port of its row (CBASE_RELOCATION_PORT_MS)`);
        break;
      }
      await pause(Math.min(1_000, Math.max(50, Math.floor(cap / 20))));
    }
  } catch (e) {
    for (const s of toMeasure) result.push({ id: s.id, name: s.name, port: s.port, finding: "not-measurable", reason: short(e) });
    return result;
  }
  for (const s of toMeasure) {
    const x = state.get(s.id) || { listens: false, own: [] };
    if (x.listens) { result.push({ id: s.id, name: s.name, port: s.port, finding: "listens" }); continue; }
    if (x.own.length === 1) {
      const entry = { id: s.id, name: s.name, prior: s.port, measured: x.own[0], finding: "implemented" };
      // Journal BEFORE the effect: the old value is in the report before the row gets the measured one.
      ctx.report.start = { ...(ctx.report.start || {}), ports: [...result, entry] };
      await ctx.journal.note({ report: ctx.report });
      store.updateProjectService(s.id, { port: entry.measured });
      ctx.log(`start: service "${s.name}" listens on ${entry.measured} instead of ${s.port} — the row now carries the measured port`);
      result.push(entry);
      continue;
    }
    result.push({ id: s.id, name: s.name, port: s.port, finding: x.own.length ? "ambiguous" : "listens-not", ...(x.own.length ? { measured: x.own } : {}) });
  }
  return result;
}

async function stepStart(ctx) {
  const pid = ctx.projectId;
  const row = store.projectInstance(pid, MAIN);
  // Until `converted_at` is set, the point of no return is not reached (nothing ran inside) — an error up to then carries
  // `turnaroundNotReached`, and journal.js takes the return path.
  const beforeTheTurnaround = (e) => { if (e && typeof e === "object") e.turnaroundNotReached = true; return e; };
  if (!row) throw beforeTheTurnaround(stepError("start", "no instance row"));
  if (row.state !== "relocation") { ctx.log(`start: the row is in "${row.state}" — the restore has started it`); return; }
  let id;
  let desired;
  try {
    id = await saveProjectContainer(ctx);
    const old = new Map((ctx.row()?.container?.list || []).map((c) => [c.name, c]));
    const native0 = (ctx.row()?.container?.native || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    // `desired` in full: all containers including created/exited, the state from BEFORE the relocation, and the native
    // services that ran in 4 (ids as whole numbers, ascending).
    desired = row.desired?.container?.length ? row.desired : desiredFromInspect(await insideInspect(id), { services: native0 });
    if (desired !== row.desired) for (const x of desired.container) { const a = old.get(x.name); if (a) x.state = DESIRED_RUNNING.has(a.state) ? "running" : a.state; }
  } catch (e) {
    throw row.convertedAt ? e : beforeTheTurnaround(e);
  }
  const native = (ctx.row()?.container?.native || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  setInstanceState(pid, MAIN, "relocation", { phase: "start", convertedAt: row.convertedAt || Date.now(), containerId: id, desired });
  const { findings, notices, liveness } = await runInstanceUp(pid, store.projectInstance(pid, MAIN), { containerId: id, desired, state: "relocation" });
  let newDesired = null;
  try {
    newDesired = desiredAfterRestore(desired, await insideInspect(id), { notArrived: findings.flatMap((b) => [b.id, b.name]) });
    await checkLiveness(id, liveness); // a life that restarted in between yields no desired state (the observer brings it back)
  } catch (e) { newDesired = null; ctx.log(`start: snapshot not written (${short(e)}) — the desired state of the relocation applies`); }
  const finding = [findings.length ? `service(s) failed: ${findings.map((b) => `${b.name} (${b.reason})`).join(", ")}` : "", ...notices].filter(Boolean).join("; ");
  setInstanceState(pid, MAIN, "relocation", { phase: "started", error: finding, ...(newDesired ? { desired: withServicesOfNow(pid, MAIN, newDesired) } : {}) });
  ctx.report.start = { findings: findings.map((b) => ({ name: b.name, reason: b.reason })), notices, native };
  await ctx.journal.note({ report: ctx.report });
  // The native services listen again — on the port of their row, otherwise on the measured one (header).
  if (native.length) {
    setPhase(ctx, "ports");
    const ports = await nativePortsRemeasure(ctx, id, native);
    ctx.report.start = { ...ctx.report.start, ports };
    await ctx.journal.note({ report: ctx.report });
    const conspicuous = ports.filter((p) => p.finding !== "listens" && p.finding !== "without-port");
    if (conspicuous.length) ctx.log(`start: ports — ${conspicuous.map((p) => `${p.name || p.id}: ${p.finding}`).join(", ")}`);
  }
  ctx.log(`started${finding ? ` — ${finding}` : ""}`);
}

async function stepRecheck(ctx) {
  const plan = ctx.plan;
  const list = await insideInspect(containerName(ctx.projectId));
  const byName = new Map(list.map((x) => [nameOf(x), x]));
  const deviation = [];
  for (const x of replicated(plan)) {
    const i = byName.get(x.name);
    if (!i) { deviation.push(`${x.name}: missing inside`); continue; }
    if (normId(i.Image) !== normId(x.image)) deviation.push(`${x.name}: image id differs`);
  }
  deviation.push(...hashDeviations(list, inside2(ctx).desiredHash || desiredHashesFromPlan(plan)).filter((a) => !a.endsWith("missing inside")));
  if (deviation.length) throw stepError("recheck", `renewed check before removing: ${deviation.join("; ")}`);
}

async function removeStep(ctx) {
  const plan = ctx.plan;
  const list = ctx.row()?.container?.list || [];
  const d = relocationCapMs("call");
  const b = { container: [], volumes: [], images: [], networks: [], not: [], approved: 0 };
  // 1. The old containers, by id — only those still belonging to the Compose project from the journal. One-off containers
  //    (`compose run`) do not move along (`up` does not create them) — they stay in B and are listed in the report.
  for (const c of list) {
    if (c.oneoff) { b.not.push(`container ${c.name}: one-off container, not transferred — stays`); continue; }
    const i = await inspectOne(["inspect", "--type", "container", c.id]);
    if (!i) { b.container.push(c.name); continue; }
    if ((i.Config?.Labels?.[LABEL.project] || "") !== (c.composeProject || "")) { b.not.push(`container ${c.name}: labels no longer match`); continue; }
    try {
      if (RUNNING.has(i.State?.Status)) await docker(["stop", "-t", "30", c.id], { capMs: relocationCapMs("stop") });
      await docker(["rm", c.id], { capMs: d });
      b.container.push(c.name);
    } catch (e) { b.not.push(`container ${c.name}: ${short(e)}`); }
  }
  // ONLY what provably belongs to this project alone is removed — the Compose label of a Compose project of this
  // relocation. Whatever someone else may still own (an `external` volume, a pulled image named by the Compose file of
  // another project that is currently down) stays in B and is listed in the report.
  const projects = new Set((plan.compose || []).map((g) => g.project));
  // 2. Volumes only from the journal (plan) and with a matching label.
  const volumeWay = async (name, reason, bytes) => {
    const v = await inspectOne(["volume", "inspect", name]);
    if (!v) return;
    const no = reason(v.Labels || {});
    if (no) { b.not.push(`volume ${name}: ${no}`); return; }
    try { await docker(["volume", "rm", name], { capMs: d }); b.volumes.push(name); b.approved += Number(bytes) || 0; }
    catch (e) { b.not.push(`volume ${name}: ${short(e)}`); }
  };
  const sameLabels = (a, bb) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(bb || {}).sort());
  for (const v of plan.volumes?.named || []) {
    // Without the Compose label of a project of this relocation (created by hand, `external`, another Compose project)
    // another project may own it — it stays, even if the plan (volume-extern) should have held. A volume WITHOUT a label
    // that the dry run checked against the model stays in B too — the model only proves that THIS project uses it, not
    // that no other project that is currently down names it under this name; the report names it with its size, and it
    // is released by hand.
    await volumeWay(v.name, (l) => (v.withoutLabel ? `without a Compose label — stays in B (${Number(v.bytes) || 0} bytes; another project may own it under this name), release it by hand`
      : !projects.has(l[LABEL.project]) ? "without the Compose label of this project — stays (owner unclear)"
        : !sameLabels(l, v.labels) ? "labels do not match" : ""), v.bytes);
  }
  for (const a of plan.volumes?.anonym || []) {
    if (!ANONYM.test(a.name)) { b.not.push(`volume ${a.name}: not an anonymous name`); continue; }
    await volumeWay(a.name, (l) => (Object.hasOwn(l, "com.docker.volume.anonymous") || !Object.keys(l).length ? "" : "labels do not match"), a.bytes);
  }
  // 3. Images without users — only what this project BUILT (Compose writes `com.docker.compose.project` onto every image
  //    it builds), per tag, and only while the tag still points at the id. A pulled image (postgres, minio/minio:latest —
  //    perhaps no longer pullable) may be named by the Compose file of another project whose containers are currently
  //    missing: it stays, and the report names it with its size.
  const rest = await allContainerB();
  const used = new Set(rest.map((c) => normId(c.Image)));
  for (const img of plan.images || []) {
    const shortId = normId(img.id).slice(0, 12);
    if (used.has(normId(img.id))) { b.not.push(`image ${shortId}: still in use`); continue; }
    let image;
    try { image = await inspectOne(["image", "inspect", `sha256:${normId(img.id)}`]); } catch (e) { b.not.push(`image ${shortId}: ${short(e)}`); continue; }
    if (!image) continue;
    if (!projects.has(image.Config?.Labels?.[LABEL.project])) {
      b.not.push(`image ${shortId} (${(img.tags || []).join(", ") || "no tag"}): not built by this project — stays (${Number(img.bytes) || 0} B)`);
      continue;
    }
    let all = true;
    for (const tag of img.tags || []) {
      try {
        const i = await inspectOne(["image", "inspect", tag]);
        if (!i || normId(i.Id) !== normId(img.id)) { all = false; b.not.push(`image tag ${tag}: no longer points at the image of the relocation`); continue; }
        await docker(["rmi", tag], { capMs: d });
      } catch (e) { all = false; b.not.push(`image tag ${tag}: ${short(e)}`); }
    }
    if (!all) continue;
    b.images.push(shortId);
    b.approved += Number(img.bytes) || 0;
  }
  // 4. Build cache: NOT touched. No filter of `docker builder prune` hits one project: cache entries carry no Compose
  //    labels, and dockerd 20.10 accepts `--filter label=…` but does not apply it — the call would empty the unused cache
  //    of ALL projects in B. By hand: `docker builder prune`.
  b.buildCache = "not touched — no filter hits this project alone (by hand: docker builder prune)";
  // 5. Networks of the project only, without connected containers — and only with the Compose label of a project of this
  //    relocation (the same principle as for the volumes above). A network WITHOUT labels (`plan.networks.itself`: created
  //    by hand, `external` in the Compose file) may be run as `external` by another project whose containers are currently
  //    down — it would go too, and that project would not come up again (the plan reports `network-coupling-ends` only
  //    for existing containers). It stays in B and is listed in the report, released by hand; inside, step 7 created its
  //    counterpart.
  const connected = new Set(rest.flatMap((c) => Object.keys(c.NetworkSettings?.Networks || {})));
  for (const name of plan.networks?.itself || []) {
    let present = true;
    try { present = Boolean(await inspectOne(["network", "inspect", name])); } catch { /* unknown — it stays anyway */ }
    if (present) b.not.push(`network ${name}: without a Compose label — stays in B (another project may run it as external), release it by hand`);
  }
  const networks = (plan.networks?.owner || []).filter((n) => projects.has(n.project)).map((n) => ({ name: n.network, project: n.project }));
  for (const n of networks) {
    const i = await inspectOne(["network", "inspect", n.name]);
    if (!i) continue;
    if ((i.Labels?.[LABEL.project] ?? null) !== n.project) { b.not.push(`network ${n.name}: labels do not match`); continue; }
    if (connected.has(n.name)) { b.not.push(`network ${n.name}: still connected`); continue; }
    try { await docker(["network", "rm", String(i.Id)], { capMs: d }); b.networks.push(n.name); }
    catch (e) { b.not.push(`network ${n.name}: ${short(e)}`); }
  }
  ctx.report.remove = b;
  await ctx.journal.note({ report: ctx.report });
  // 6. The data part (data.js): .env backup, override, old copies.
  await ctx.steps.cleanUpAfterStart(ctx);
  ctx.log(`removed: ${b.container.length} container(s), ${b.volumes.length} volume(s), ${b.images.length} image(s), ${b.networks.length} network(s)${b.not.length ? `; not: ${b.not.length}` : ""}`);
}

export function durationPerStep(log) {
  const open = new Map();
  const out = [];
  for (const e of Array.isArray(log) ? log : []) {
    const k = `${e.direction}/${e.step}`;
    if (e.what === "announced") open.set(k, e.at);
    else if (e.what === "done" && open.has(k)) { out.push({ direction: e.direction, step: e.step, ms: e.at - open.get(k) }); open.delete(k); }
  }
  return out;
}

function reportOf(ctx) {
  const plan = ctx.plan || {};
  return {
    ...ctx.report,
    duration: durationPerStep(ctx.row()?.log),
    notTransferred: {
      withoutLabel: (plan.withoutLabel || []).map((x) => x?.name || x?.container || x),
      onceContainer: (plan.container || []).filter((c) => c.oneoff).map((c) => c.name),
      worktreesStay: plan.worktrees?.stay || [],
    },
    hints: [...new Set((plan.hints || []).map((h) => h.kind))],
    slot: plan.slot || null,
  };
}

async function stepCompletion(ctx) {
  const report = reportOf(ctx);
  ctx.report = report;
  await ctx.journal.note({ report });
  try { writeFile(ctx, "report.json", `${JSON.stringify(report, null, 2)}\n`); } catch (e) { ctx.log(`report not written as a file: ${short(e)}`); }
  const z = store.projectInstance(ctx.projectId, MAIN);
  if (z && z.state !== "ready") setInstanceState(ctx.projectId, MAIN, "ready", { phase: "", error: z.error || "" });
  ctx.log("relocation finished");
}

// ── Return path ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The return-path bookkeeping in the report (`report.returnPath`): reason, failed parts per step, settled-because-gone, hold.
function returnPathReport(ctx) {
  const rb = ctx.report.returnPath && typeof ctx.report.returnPath === "object" ? ctx.report.returnPath : {};
  ctx.report.returnPath = { reason: rb.reason ?? (ctx.row()?.error || null), ...rb, error: Array.isArray(rb.error) ? rb.error : [], gone: Array.isArray(rb.gone) ? rb.gone : [] };
  return ctx.report.returnPath;
}

// Before any effect of a deleting return-path step: if the instance carries `converted_at`, something may already have
// run inside — what arose there would exist nowhere else. No return path may delete it (header, EXCEPTION).
function returnPathMayDelete(ctx, step) {
  const z = store.projectInstance(ctx.projectId, MAIN);
  if (z?.convertedAt) throw endangered(step, `the instance is already converted (converted_at ${new Date(z.convertedAt).toISOString()}) — a return path would remove what arose inside since the start; nothing removed`);
}

async function rwRuntime(ctx) {
  returnPathMayDelete(ctx, "rw-runtime");
  const r = await ctx.steps.runtimeBack(ctx);
  if (r && typeof r === "object") {
    ctx.report.returnPathRuntime = r;
    // Worktrees that did not come back: the runtime folder stays (data.js removes nothing there, and no later return-path
    // step touches it — it is a bind, not part of the project container). A part that did not come back.
    if (r.runtimeStays) {
      throw stepError("rw-runtime", `worktree(s) not back (${(r.error || []).length}) — the runtime folder ${r.runtimeStays} stays, nothing is removed there`);
    }
  }
}

async function rwContainer(ctx) {
  returnPathMayDelete(ctx, "rw-container");
  const pid = ctx.projectId;
  const d = relocationCapMs("call");
  const error = [];
  // Each part on its own: a failed one does not hold up the others (everything here is a copy before the turnaround).
  const part = async (what, fn) => { try { await fn(); } catch (e) { error.push(`${what}: ${short(e)}`); } };
  await part("helper", async () => {
    const helper = idsFrom((await docker(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${LABEL_HELPER_PROJECT}=${pid}`, "--filter", `label=${LABEL_HELPER}=relocation`], { capMs: d })).stdout);
    for (const h of helper) await removeHelper(h);
  });
  await part(containerName(pid), async () => {
    const c = await inspectOne(["inspect", "--type", "container", containerName(pid)]);
    if (!c) return;
    if (c.Config?.Labels?.[LABEL_PROJECT] !== pid) throw new Error("does not carry the label of this project — not removed");
    await docker(["rm", "-f", String(c.Id)], { capMs: relocationCapMs("stop") });
  });
  await part(volumeName(pid), async () => {
    // Only a volume THIS relocation created (`volumeFound === false`) — without the note (an older journal, a crash before
    // the creation) it stays; one that was found stays always.
    const found = inside2(ctx).volumeFound;
    if (found !== false) { ctx.log(`return path: the volume ${volumeName(pid)} stays (${found === true ? "it already lay in B before the relocation" : "whether it was there before is unknown"})`); return; }
    const v = await inspectOne(["volume", "inspect", volumeName(pid)]);
    if (!v) return;
    if (v.Labels?.[LABEL_PROJECT] !== pid) throw new Error("does not carry the label of this project — not removed");
    await docker(["volume", "rm", volumeName(pid)], { capMs: d });
  });
  await part(networkName(pid), async () => {
    const n = await inspectOne(["network", "inspect", networkName(pid)]);
    if (!n) return;
    if (n.Labels?.[LABEL_PROJECT] !== pid) throw new Error("does not carry the label of this project — not removed");
    await docker(["network", "rm", String(n.Id)], { capMs: d });
  });
  if (error.length) throw stepError("rw-container", `return path: ${error.join("; ")}`);
  ctx.log("return path: helpers, project container, volume and network removed");
}

async function rwOldStart(ctx) {
  const pid = ctx.projectId;
  const j = ctx.row() || {};
  const list = j.container?.list || [];
  const byName = new Map(list.map((c) => [c.name, c]));
  const followUp = [...(ctx.plan?.startFollowUp || []).map((n) => byName.get(n)).filter(Boolean), ...list.filter((c) => !(ctx.plan?.startFollowUp || []).includes(c.name))];
  const error = [];
  const gone = new Set();
  for (const c of followUp) {
    if (!RUNNING.has(c.state)) continue;
    // `No such container`: docker removed it itself at the stop in 4 (AutoRemove, `compose run --rm`) — settled, in the
    // report. Any other error is a part that did not come back; the remaining containers start anyway.
    try { await docker(["start", c.id], { capMs: relocationCapMs("call") }); }
    catch (e) { if (containerGone(e)) gone.add(c.name); else error.push(`${c.name}: ${short(e)}`); }
  }
  for (const [id, p] of Object.entries(j.policies || {})) {
    if (!p || p === "no") continue;
    try { await docker(["update", `--restart=${p}`, id], { capMs: relocationCapMs("call") }); }
    catch (e) {
      const c = list.find((x) => x.id === id);
      if (containerGone(e)) gone.add(c?.name || id.slice(0, 12)); else error.push(`Policy ${c?.name || id.slice(0, 12)}: ${short(e)}`);
    }
  }
  if (gone.size) {
    const rb = returnPathReport(ctx);
    rb.gone = [...new Set([...rb.gone, ...[...gone].map((n) => `container ${n}: removed by docker at the stop (AutoRemove) — cannot be brought back`)])];
    await ctx.journal.note({ report: ctx.report });
    ctx.log(`return path: gone (AutoRemove): ${[...gone].join(", ")}`);
  }
  // The native services ended in 4, with the start commands restored (by rw-ports) — in B (the row is not converted,
  // startSimple starts there).
  const native = (j.container?.native || []).map(String);
  if (native.length) {
    const run2 = new Set(nativeRuns(pid).map((l) => String(l.serviceId)));
    const info = servicesSeam().projectServices(pid);
    for (const id of native) {
      if (run2.has(id)) continue;
      const svc = (info?.services || []).find((s) => String(s.id) === id);
      if (!svc?.startCommand) { error.push(`native service ${id}: no start command`); continue; }
      try { startSimple({ projectId: pid, service: svc, cwd: svc.cwd, projectName: info.name, workspaceId: info.workspaceId ?? null }); }
      catch (e) { if (!(e instanceof ServiceRunningError)) error.push(`native service ${id}: ${short(e)}`); } // running counts as started
    }
  }
  if (error.length) throw stepError("rw-old-start", `return path: ${error.join("; ")}`);
  ctx.log("return path: old containers started, policies restored");
}

// Deleting the instance row IS the end of the return path — if it fails (the database does not write), the return path
// does not end. Collected like the other parts, the journal would end `back` with the row left in `relocation` WITHOUT a
// journal: `busy` and the start lock would hold forever, a new relocation would fail on the row, and the next start
// would put the project into `error`. Instead the return path holds here (`holds`: phase `hold-return-path` with reason
// and way out); the journal stays open, and the way out (POST …/relocation/resume or the next start) repeats only this
// step — all others are done.
async function rwCompletion(ctx) {
  returnPathMayDelete(ctx, "rw-completion");
  try {
    const z = store.projectInstance(ctx.projectId, MAIN);
    if (z) store.deleteProjectInstance(ctx.projectId, MAIN);
  } catch (e) {
    throw Object.assign(stepError("rw-completion", `the instance row is not deleted (${short(e)}) — the return path only ends without it`, e), { holds: true });
  }
  try { bringAlongNames(); } catch (e) { ctx.log(`names not updated: ${short(e)}`); }
}

// A return-path step that did not fully succeed: the part goes into the report (once per step, a repeated one replaces
// it), and the return path continues. Only an `endangered` (header) and a `holds` (rwCompletion) stop it.
function returnPathCollects(ctx, name, fn) {
  return async () => {
    try { return await fn(); } catch (e) {
      if (e?.endangered || e?.holds) throw e;
      const text = short(e);
      const rb = returnPathReport(ctx);
      rb.error = [...rb.error.filter((f) => f.step !== name), { step: name, text }];
      await ctx.journal.note({ report: ctx.report });
      ctx.log(`return path: "${name}" incomplete — ${text} (continuing; what did not come back is not deleted)`);
      return undefined;
    }
  };
}

/** The effect per step (both directions). Each sets the phase of the row (words only — it shows in the project's work). */
export function relocationEffects(ctx) {
  const s = ctx.steps;
  const w = {
    creation: () => stepCreation(ctx),
    dryrun: () => stepDryrun(ctx),
    stop: () => stopStep(ctx),
    images: () => stepImages(ctx),
    volumes: () => stepVolumes(ctx),
    networks: () => stepNetworks(ctx),
    equality: () => stepEquality(ctx),
    "port-dismantling": () => s.portDismantling(ctx),
    "new-hash": () => stepNewHash(ctx),
    "project-repo": () => s.projectRepoStep(ctx),
    "anonymous-volumes": () => stepAnonym(ctx),
    runtime: () => s.relocateRuntime(ctx),
    check: () => stepCheck(ctx),
    start: () => stepStart(ctx),
    recheck: () => stepRecheck(ctx),
    remove: () => removeStep(ctx),
    completion: () => stepCompletion(ctx),
    "rw-runtime": returnPathCollects(ctx, "rw-runtime", () => rwRuntime(ctx)),
    "rw-container": returnPathCollects(ctx, "rw-container", () => rwContainer(ctx)),
    "rw-ports": returnPathCollects(ctx, "rw-ports", () => s.portDismantlingBack(ctx)),
    "rw-old-start": returnPathCollects(ctx, "rw-old-start", () => rwOldStart(ctx)),
    "rw-project-repo": returnPathCollects(ctx, "rw-project-repo", () => s.projectRepoBack(ctx)),
    "rw-completion": returnPathCollects(ctx, "rw-completion", () => rwCompletion(ctx)),
  };
  return Object.fromEntries(Object.entries(w).map(([n, fn]) => [n, async () => {
    setPhase(ctx, n);
    ctx.log(`step ${n}`);
    return fn();
  }]));
}

// ── Running ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// The procedure turns around NOW (journal.js `atTurnAround`): the reason is in the journal (column `error`,
// `report.returnPath`) and on the row BEFORE the first return-path step does anything. If it throws (the database does
// not write), no return path runs.
function returnPathBegins(ctx, { step, error, cause }) {
  const reason = cause === "error"
    ? `step "${step}": ${short(error)}`
    : `restart grace before the turnaround${step ? ` (interrupted in step "${step}")` : ""}: return path`;
  ctx.report.returnPath = { reason, step: step || null, cause, at: Date.now(), error: [], gone: [] };
  store.writeRelocation(ctx.relocationId, { error: reason, data: { report: ctx.report } });
  const z = store.projectInstance(ctx.projectId, MAIN);
  if (z?.state === "relocation") setInstanceState(ctx.projectId, MAIN, "relocation", { phase: "returnPath", error: `return path — ${reason}` });
  ctx.log(`return path begins — ${reason}`);
}

// The end of a return path: ALWAYS `back` (header) — the reason stays, every failed part is in the report and the journal.
function back(ctx, step) {
  const id = ctx.relocationId;
  const rb = returnPathReport(ctx);
  const reason = rb.reason || "restart grace before the turnaround: return path";
  const parts = rb.error;
  const error = parts.length ? `${reason} — return path partial: ${parts.map((f) => `${f.step}: ${f.text}`).join("; ")}` : reason;
  ctx.report = { ...reportOf(ctx), end: "back", error: reason, ...(parts.length ? { returnPathPartial: true } : {}) };
  ctx.log(`back — ${error}`);
  try { store.writeRelocation(id, { data: { report: ctx.report } }); } catch { /* only the report */ }
  store.endRelocation(id, "back", { error });
  return { ok: false, id, end: "back", step, error: reason, ...(parts.length ? { returnPathError: parts } : {}), ...(rb.gone.length ? { gone: rb.gone } : {}) };
}

// An endangering return-path error (or the journal no longer writes): the row stays in `relocation`, phase
// `hold-return-path`, with reason and way out — `busy` holds, but named (header).
function holdReturnPath(ctx, state, e) {
  const pid = ctx.projectId;
  const id = ctx.relocationId;
  const rb = returnPathReport(ctx);
  const text = `return path held in "${state?.step || "?"}": ${short(e?.code === "JOURNAL_RETURN_PATH_FAILED" ? e.cause : e)}`;
  const wayOut = relocationWayOut(pid);
  rb.hold = { step: state?.step || null, text, at: Date.now() };
  ctx.log(`stands still — ${text}${rb.reason ? ` (reason of the return path: ${rb.reason})` : ""} — ${wayOut}`);
  try { store.writeRelocation(id, { data: { report: ctx.report } }); } catch { /* the log carries it */ }
  if (store.projectInstance(pid, MAIN)) {
    setInstanceState(pid, MAIN, "relocation", { phase: "hold-return-path", error: `${text}${rb.reason ? ` — reason of the return path: ${rb.reason}` : ""} — ${wayOut}` });
  }
  return { ok: false, id, end: "open", direction: "backward", step: state?.step || null, error: text, reason: rb.reason || null, wayOut };
}

// `upfront`: what the restart grace does BEFORE resuming (start, renewed check) — inside the same error handling.
async function runRelocation(ctx, { fresh, upfront = null }) {
  const pid = ctx.projectId;
  const id = ctx.relocationId;
  let r;
  try {
    if (upfront) await upfront();
    r = await run(RELOCATION_JOURNAL, ctx.journal, relocationEffects(ctx), { fresh, atTurnAround: (w) => returnPathBegins(ctx, w) });
  } catch (e) {
    if (e instanceof JournalTurned) return back(ctx, e.step);
    const state = ctx.journal.snapshot();
    if (state?.direction === "backward") return holdReturnPath(ctx, state, e);
    const step = e?.step && RELOCATION_JOURNAL.forward.includes(e.step) ? e.step : state?.step || "?";
    const error = `step "${step}" (${state?.direction || "?"}): ${short(e)}`;
    ctx.log(`stands still — ${error}`);
    try { store.writeRelocation(id, { error }); } catch { /* ended or gone — the error is in the log */ }
    const z = store.projectInstance(pid, MAIN);
    if (state?.direction === "forward" && z?.convertedAt) {
      // After the turnaround: the project runs inside. The journal stays open; the next start (or the route) finishes it.
      setInstanceState(pid, MAIN, "ready", { phase: "", error: `relocation not completed (step ${step}): ${short(e)} — the rest follows after the next start; ${relocationWayOut(pid)}` });
    } else if (z) {
      setInstanceState(pid, MAIN, "relocation", { phase: `halt ${step}`.trim(), error: `${error} — ${relocationWayOut(pid)}` });
    }
    return { ok: false, id, end: "open", direction: state?.direction || null, step, error };
  }
  if (r.direction === "backward") return back(ctx, null);
  store.endRelocation(id, "finished");
  return { ok: true, id, end: "finished", report: ctx.row()?.report ?? null };
}

// ── The entry ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function startRelocation(projectId, { steps, creation = {}, started, acknowledged = [] } = {}) {
  const pid = String(projectId ?? "");
  if (!projectboxOps()) throw new RelocationError("NO_OPS", ONLY_IN_OPS, 404);
  if (serverEnds()) throw new RelocationError("SERVER_ENDS", "the server is shutting down — no relocation", 503);
  const project = store.getProject(pid);
  if (!project) throw new RelocationError("NO_PROJECT", `project ${pid} does not exist`, 404);
  const ws = project.workspaceId ? store.getWorkspace(project.workspaceId) : null;
  if (!ws?.path || !project.path) throw new RelocationError("NO_PROJECT", `project ${pid} has no path or no workspace with a path`, 404);
  const precondition = () => {
    const open = store.openRelocation(pid);
    if (open) throw new RelocationError("RELOCATION_OPEN", `a relocation is already open for project ${pid} (${open.id}, step "${open.step || "—"}")`, 409, { relocationId: open.id });
    const z = store.projectInstance(pid, MAIN);
    if (z) throw new RelocationError("INSTANCE_EXISTS", `project ${pid} already has an instance row (${z.state}) — a relocation begins without one`, 409);
    // A half relocation of ANOTHER project that nobody has decided on yet, or whose procedure is alive, needs the heavy
    // load first (instances.js relocationElsewhere).
    const elsewhere = relocationElsewhere(pid);
    if (elsewhere) throw new RelocationError("RELOCATION_ELSEWHERE", relocationElsewhereText(elsewhere), 409, { elsewhere });
  };
  precondition();
  const s = await loadRelocationSteps(steps, { withPlan: true });
  let planData = null;
  try {
    return await withHeavyLoad("relocation", { projectId: pid }, () => withProjectOccupancy(pid, "relocation", () => withProcedure(pid, MAIN, async () => {
      precondition(); // an await lay in between
      const { plan, data } = (await s.planFor(pid)) || {};
      planData = data || null;
      if (!plan || typeof plan !== "object") throw new RelocationError("NO_PLAN", "the plan is missing", 500);
      // The caller acknowledges a write layer explicitly (plan.js `applyReceipts`); a receipt without a matching hold
      // reason (count grown, wrong name) rejects the start — never silently skipped.
      const q = applyReceipts(plan.holdReasons || [], acknowledged);
      if (q.mismatched.length) {
        throw new RelocationError("RECEIPT_MISMATCHED", `receipts without a matching hold reason: ${q.mismatched.map((x) => `${x.kind} ${x.container} (${x.count})`).join(", ")} — read the plan again`, 409, { holdReasons: plan.holdReasons || [] });
      }
      if (q.open.length) {
        throw new RelocationError("HOLD", `the plan holds: ${[...new Set(q.open.map((h) => h.kind))].join(", ")}`, 409, { holdReasons: q.open });
      }
      if (q.dismissed.length) plan.acknowledged = q.dismissed;
      // Step 2: lock, THEN idle (projectLocks checks in this order and ends the terminals with a message).
      const lock = projectLocks(pid, { reason: "relocation" });
      if (!lock.ok) throw new RelocationError("NOT_IDLE", `project ${pid} is not idle`, 409, { open: lock.open || [] });
      try {
        const location = createRelocationLocation({ data: DIRS.data, projectId: pid, time: relocationTime() });
        const row = store.createRelocation({ projectId: pid, instance: MAIN, location });
        relocationDecided(row.id, pid);
        const ctx = relocationContext(row, { steps: s, creation, plan });
        // What is acknowledged and thereby discarded goes into the report (container, count, checksum, folders, examples —
        // paths only), the WHOLE list as a file in the relocation location (five examples can hide what lies behind them).
        if (plan.acknowledged?.length) {
          ctx.report.dismissed = plan.acknowledged.map((q) => ({ ...q, list: writeDismissed(ctx, q, plan, planData) }));
        }
        await ctx.journal.note({ plan, ...(plan.acknowledged?.length ? { report: ctx.report } : {}) });
        try { writeFile(ctx, "plan.json", `${JSON.stringify(plan, null, 2)}\n`); } catch (e) { ctx.log(`plan not written as a file: ${short(e)}`); }
        ctx.log(`relocation ${row.id} begins`);
        try { started?.({ id: row.id, location }); } catch { /* the caller's business */ }
        return await runRelocation(ctx, { fresh: true });
      } finally {
        lock.resolve();
      }
    })));
  } catch (e) {
    if (e instanceof HeavyLoadOccupied) throw new RelocationError("HEAVY_LOAD_OCCUPIED", e.message, 409, { occupied: e.occupied });
    if (e?.code === "OCCUPIED") throw new RelocationError("OCCUPIED", e.message, 409);
    throw e;
  }
}

export function relocationStatus(projectId) {
  const all = store.relocationsOf(String(projectId ?? ""));
  const j = all[all.length - 1];
  if (!j) return null;
  const plan = j.plan && typeof j.plan === "object" ? j.plan : null;
  const open = j.endedAt === null;
  const alive = open && procedureAlive(j.projectId, j.instance);
  const failed = open ? relocationResumeError(j.projectId, j.instance) : null;
  return {
    id: j.id, projectId: j.projectId, instance: j.instance, location: j.location, open, direction: j.direction,
    step: j.step, done: j.done, end: j.end, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt,
    count: all.length,
    plan: plan ? { canRelocate: plan.canRelocate, holdReasons: plan.holdReasons || [], hints: plan.hints || [], slot: plan.slot || null, downtime: plan.downtime || null } : null,
    report: j.report ?? null,
    duration: durationPerStep(j.log),
    // An open journal without a living procedure stands still — why (if resuming failed) and the way out.
    ...(open ? { alive, ...(failed ? { resumeError: failed } : {}), ...(alive ? {} : { wayOut: relocationWayOut(j.projectId) }) } : {}),
  };
}

// ── Restart grace ───────────────────────────────────────────────────────────────────────────────────────────────────

// Several half relocations (after a restart) run ONE AFTER THE OTHER — the heavy load is one per B.
let queue = Promise.resolve();
function inQueue(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function setGone(projectId, { steps, creation, reason, started }) {
  if (!projectboxOps()) {
    console.error(`[relocation] ${projectId}: half relocation (${reason}) without the ops marker — no docker, left as it is`);
    return { ok: false, end: "open", error: ONLY_IN_OPS };
  }
  // The heavy load FIRST — before waiting for the cleanup of the helpers (docker ps, takes time); otherwise a new
  // relocation would grab it in that gap, and this half one would find it occupied.
  return withHeavyLoad("relocation", { projectId }, async () => {
    await helperCleanedUp();
    const j = store.openRelocation(projectId);
    if (!j) {
      const z = store.projectInstance(projectId, MAIN);
      if (z?.state === "relocation") {
        setInstanceState(projectId, MAIN, "error", { error: "relocation without an open journal — the state cannot be decided, check by hand" });
      }
      return { ok: false, end: null, error: "no open journal" };
    }
    relocationDecided(j.id, projectId);
    const s = await loadRelocationSteps(steps, { withPlan: false });
    return withProjectOccupancy(projectId, "relocation", async () => {
      let lock = { ok: false };
      try { lock = projectLocks(projectId, { reason: "relocation" }); } catch (e) { console.warn(`[relocation] ${projectId}: lock in the restart grace: ${short(e)}`); }
      if (!lock.ok) console.warn(`[relocation] ${projectId}: restart grace without a lock (${(lock.open || []).map((o) => o.reason).join(", ") || "—"}) — the state "relocation" holds the starts back`);
      try {
        const ctx = relocationContext(j, { steps: s, creation });
        const { direction, from } = decide(RELOCATION_JOURNAL, j);
        ctx.log(`restart grace (${reason}): ${direction}${from ? ` from "${from}"` : ""}`);
        try { started?.({ id: j.id, direction, from }); } catch { /* the caller's business */ }
        // From the turnaround on: first start (idempotent), then the renewed check, only then remove. If the journal is
        // already beyond `recheck` (crash in `remove`), it checks once more here. Both inside the error handling of
        // runRelocation.
        const upfront = direction === "forward" && from && from !== "start"
          ? async () => {
            await stepStart(ctx);
            if (from === "remove") { setPhase(ctx, "recheck"); await stepRecheck(ctx); }
          }
          : null;
        return await runRelocation(ctx, { fresh: false, upfront });
      } finally {
        // Without a lock (the queued work of the project counted as open) nobody wakes the turns that the state
        // `relocation` held back: the return path DELETES the row (no transition to ready/error, so no state wakeup), and
        // there is no lock to release. Otherwise a message sent during the relocation would never run after a crash and
        // the return path in the restart grace. wakeProject checks itself whether the row is still working.
        if (lock.ok) lock.resolve();
        else { try { wakeProject(projectId); } catch (e) { console.warn(`[relocation] ${projectId}: wakeup after the restart grace: ${short(e)}`); } }
      }
    });
  });
}

// Resume a half relocation (restart grace, after-ready, route): the procedure begins SYNCHRONOUSLY (withProcedure), and a
// failure BEFORE runRelocation (heavy load, occupancy, context, …) is not only in the log — instances.js remembers it
// together with the way out.
function resumeWith({ steps, creation }, projectId, reason, started) {
  const p = withProcedure(projectId, MAIN, () => inQueue(() => setGone(projectId, { steps, creation, reason, started })));
  p.catch((e) => {
    console.error(`[relocation] ${projectId}: resuming (${reason}) failed: ${short(e)}`);
    relocationResumeFailed(projectId, MAIN, e);
  });
  return p;
}

/**
 * The second way: resume a half relocation by hand — the route POST …/relocation/resume. Throws a `RelocationError`
 * BEFORE anything begins (404 without the ops marker, 409 without an open journal, with a living procedure or occupied
 * heavy load); otherwise `{ run }` — the promise of the resumption (the same as in the restart grace: before the
 * turnaround the return path, from the turnaround on forward). `started({ id, direction, ab })` fires as soon as the
 * heavy load is held and the decision is made.
 */
export function resumeRelocation(projectId, { steps, creation, started } = {}) {
  const pid = String(projectId ?? "");
  if (!projectboxOps()) throw new RelocationError("NO_OPS", ONLY_IN_OPS, 404);
  if (serverEnds()) throw new RelocationError("SERVER_ENDS", "the server is shutting down — no relocation", 503);
  const j = store.openRelocation(pid);
  if (!j) throw new RelocationError("NO_OPEN_RELOCATION", `no relocation is open for project ${pid} — nothing to resume`, 409);
  if (procedureAlive(pid, MAIN)) throw new RelocationError("RELOCATION_RUNNING", `the relocation of project ${pid} is already running`, 409);
  const occupied = heavyLoadStatus();
  if (occupied) throw new RelocationError("HEAVY_LOAD_OCCUPIED", `heavy load occupied: "${occupied.kind}" for ${occupied.projectId}/${occupied.instance} is running`, 409, { occupied });
  return { run: resumeWith({ steps, creation }, pid, "route", started) };
}

/**
 * The connections of the restart grace: `decider` for instances.js `setRelocationDecider` (enters the procedure
 * SYNCHRONOUSLY), and `afterReady` for restore.js `atReady` (a journal after the turnaround whose row the restore
 * started is finished afterwards). `steps`/`creation` for tests (otherwise data.js).
 */
export function relocationRestartGraceSeam({ steps, creation } = {}) {
  const resume = (projectId, reason) => resumeWith({ steps, creation }, projectId, reason);
  return {
    decider({ projectId, instance } = {}) {
      if (!projectId) return undefined;
      if ((instance || MAIN) !== MAIN) { console.error(`[relocation] ${projectId}/${instance}: half relocation of an instance other than "main" — not in stage 1`); return undefined; }
      return resume(String(projectId), "restartGrace");
    },
    afterReady({ projectId, instance } = {}) {
      if (!projectId || (instance || MAIN) !== MAIN || !projectboxOps()) return undefined;
      const j = store.openRelocation(String(projectId));
      if (!j || procedureAlive(String(projectId), MAIN)) return undefined;
      let r;
      try { r = decide(RELOCATION_JOURNAL, j); } catch { return undefined; }
      if (r.direction !== "forward") return undefined;
      return resume(String(projectId), "after-ready");
    },
  };
}
