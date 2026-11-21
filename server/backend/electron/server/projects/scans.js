// Scans per project: services (serviceScans, runServicesScan).
//
// DETECTION IN THE PROJECT CONTAINER:
//   Place      A converted project (instance via runs/instance.js instanceForProject, only in server operation) is detected in
//              the project container: scanServices({ instance, projectId }) → runOnce → runOnceClaude → inProject (hardened:
//              Read/Glob/Grep, empty MCP configuration, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS — providers/connectors/claude.js).
//              Without an instance in B (spawn). Codex and third-party providers do not exist in the container: detection
//              fails visibly ("Detection in the project container only with Claude").
//   Waiting    With an instance it asks (in this order) the storage gate (workflows/storage-gate.js — `waiting: "storage"`),
//              the cap (CBASE_DETECTION_CAP, default 2 at once per user — `waiting: "cap"`) and the start gate via its project
//              (runs/project-lock.js: a oneshot WITH an instance is judged like an agent — `waiting: "project"` during
//              creation, setup, re-creation, layout). The status stays `running` (the clients know no other) and carries
//              `waiting` and `waitText`. It is woken by the transition of main (projectbox/idle.js wakeProject →
//              projectbox/detection.js), by the end of another detection (cap) and by the tick of the storage queue (source
//              "detection", server.js — the main path for storage waiting, the fallback for the others if a wakeup is
//              missed). A waiting detection holds nothing (does not count against idle).
//   After-run  A call during a run is not discarded: afterwards EXACTLY ONE more runs (`afterRun`; several calls make one).
//              A call while the detection is still WAITING merges into it (it has read nothing yet). `onlySupplement`
//              (after a later upload) removes nothing; merged, the full reconciliation wins.
//   Foreign    The fields of a service row arrive truncated (name 80, description 400, start command 1,000), a field that
//   text       looks like a credential is discarded (claude.js looksLikeSecret), and the notice names service and field,
//              never the value.
// The domain side (projectbox/: setup, upload) triggers it via projectbox/detection.js detectServices (server.js
// setServicesDetection); projectbox/ never imports projects/.

import { scanServices } from "../claude.js";
import * as store from "../store.js";
import { T } from "../i18n.js";
import { containerRunning, serviceRunning, recordNotice, sanitizeStartCommand, startHeld } from "../services.js";
import { agentRunFor } from "../settings/agent-models.js";
import { convertedProjects } from "../projectbox/network-targets.js";
import { MAIN } from "../projectbox/creation.js";
import { detectionBegins, detectionEnds, detectionWaiting } from "../projectbox/detection.js";
import { instanceForProject } from "../runs/instance.js";
import { resolveModelRef } from "../providers/index.js";
import { storageSituation } from "../workflows/storage-gate.js";


// ── Service scan: an AI agent inventories the stack of a project ──────────
// Runs fire-and-forget on project creation or on request (re-scan, a reconciliation with the stored services).
const serviceScans = new Map(); // projectId -> { status: running|done|error, startedAt, finishedAt?, count?, conflicts?, notFound?, removed?, error?, waiting?, waitText? }
// The job per project while it waits or runs — { onlySupplement, startedAt, phase: "waiting"|"running", waiting,
// inContainer, afterRun: null | { onlySupplement } }.
const jobs = new Map();
let inContainerRunning = 0; // computing detections in the project container (cap)

// The cap of detections in the project container: per user (one user container = this process) at most this many at once.
// Knob CBASE_DETECTION_CAP (integer ≥ 1), otherwise 2. A cap that says it is one: the status carries `waiting: "cap"` with a
// sentence.
export const DETECTION_CAP = 2;
export function detectionCap() {
  const raw = process.env.CBASE_DETECTION_CAP;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : DETECTION_CAP;
}

// Which services of the project the reconciliation must NOT remove even if the scan no longer names them: those that run — in
// any instance, by the same rule as the list (services.js serviceRunning: port or container answer, a portless one via its
// run; a container with an unreadable daemon counts as running) or are held by the start guard (startHeld) —, and those in
// the desired state of an instance (restore starts them after the next restart, by their id). A verdict that fails is
// unknown, not "not running": the service stays. During a relocation (open journal or an instance in state "relocation" —
// both name service ids) `null`: the reconciliation then removes nothing (store/projects.js reconcileScan).
async function notToRemove(projectId) {
  const rows = store.projectInstancesOf(projectId);
  if (store.openRelocation(projectId) || rows.some((z) => z.state === "relocation")) return null;
  const keep = new Set();
  for (const z of rows) for (const id of Array.isArray(z.desired?.services) ? z.desired.services : []) keep.add(Number(id));
  const instances = [MAIN, ...rows.map((z) => z.instance).filter((i) => i !== MAIN)];
  for (const s of store.listProjectServices(projectId)) {
    if (keep.has(s.id)) continue;
    for (const instance of instances) {
      let running;
      try {
        // A registered container whose daemon is unreadable (`null`) counts as running — serviceRunning would say "no" there.
        const c = s.container ? await containerRunning({ container: s.container, projectId, instance, dir: s.dir || "" }) : false;
        running = c !== false || (await serviceRunning(projectId, s, { instance })) || (await startHeld(projectId, s, { instance }));
      } catch { running = true; }
      if (running) { keep.add(s.id); break; }
    }
  }
  return keep;
}

// The names of a list for the text of a notice: at most five, followed by the count of the rest.
const namesRows = (list) => [
  ...list.slice(0, 5).map((d) => d.name),
  ...(list.length > 5 ? [T`… and ${list.length - 5} more`] : []),
];

// `onlySupplement`: remove nothing — the later upload via projectbox/detection.js detectServices.
function runServicesScan(proj, { onlySupplement = false } = {}) {
  const pid = String(proj?.id ?? "");
  if (!pid) return;
  const supplement = onlySupplement === true;
  const open = jobs.get(pid);
  if (open) {
    // Run after instead of discarding: if it still waits, the call merges into it; if it computes, exactly one more runs after.
    if (open.phase === "waiting") open.onlySupplement = open.onlySupplement && supplement;
    else open.afterRun = { onlySupplement: (open.afterRun ? open.afterRun.onlySupplement : true) && supplement };
    return;
  }
  const startedAt = Date.now();
  jobs.set(pid, { onlySupplement: supplement, startedAt, phase: "waiting", waiting: null, inContainer: false, afterRun: null });
  // The route sets the status "running" BEFORE it answers — also for a detection that waits right away.
  serviceScans.set(pid, { status: "running", startedAt });
  attempts(pid);
}

// Begin a waiting job — `true` if it computes now (the start gate still asks runOnce afterwards; if it holds it, it waits
// again). Called on the call, by the wakeup at the lock, by the end of another detection and by the tick.
function attempts(pid) {
  const a = jobs.get(pid);
  if (!a || a.phase !== "waiting") return false;
  detectionWaiting(pid, null);
  let proj, instance, run;
  try {
    proj = store.getProject(pid);
    if (!proj) { jobs.delete(pid); serviceScans.delete(pid); return false; } // the project is gone
    instance = instanceForProject(pid);
    run = agentRunFor("services");
    if (instance && resolveModelRef(run.model).providerId !== "claude") {
      throw new Error(T("Detection in the project container only with Claude"));
    }
  } catch (e) { end(pid, a, { error: e }); return false; }
  if (instance) {
    const situation = storageSituation();
    if (!situation.free) return wait(pid, a, "storage", situation.reason);
    const cap = detectionCap();
    if (inContainerRunning >= cap) {
      return wait(pid, a, "cap", T`waiting: at most ${cap} service detections at once in project containers`);
    }
  }
  a.phase = "running";
  a.waiting = null;
  a.inContainer = Boolean(instance);
  if (a.inContainer) inContainerRunning += 1;
  detectionBegins(pid);
  serviceScans.set(pid, { status: "running", startedAt: a.startedAt });
  const dismissed = [];
  scanServices({ cwd: proj.path, ...run, instance, projectId: instance ? pid : null, atDismissed: (v) => dismissed.push(v) })
    .then((services) => reconcile(proj, a, services, dismissed))
    .then((result) => end(pid, a, { result }))
    .catch((e) => {
      // The start gate held it (project lock, `kind` "wait"): back to waiting, woken by the transition of main.
      if (e?.project?.kind === "wait" && a.phase === "running") {
        notMoreComputing(pid, a);
        wait(pid, a, "project", e.message);
        return;
      }
      end(pid, a, { error: e });
    });
  return true;
}

function wait(pid, a, reason, text) {
  a.phase = "waiting";
  a.waiting = reason;
  serviceScans.set(pid, { status: "running", startedAt: a.startedAt, waiting: reason, waitText: String(text || "").slice(0, 300) });
  if (reason === "project") detectionWaiting(pid, () => attempts(pid));
  return false;
}

// Out of "computing": idle no longer counts it, and a slot under the cap is free (the oldest one waiting for it).
function notMoreComputing(pid, a) {
  if (a.phase !== "running") return;
  a.phase = "off"; // once: the caller then sets "waiting" (wait) or clears it (end)
  detectionEnds(pid);
  if (a.inContainer) {
    inContainerRunning = Math.max(0, inContainerRunning - 1);
    queueMicrotask(() => {
      for (const [p, w] of jobs) {
        if (w.phase === "waiting" && w.waiting === "cap" && attempts(p)) break;
      }
    });
  }
  a.inContainer = false;
}

function end(pid, a, { error = null, result = null } = {}) {
  notMoreComputing(pid, a);
  if (jobs.get(pid) === a) jobs.delete(pid);
  detectionWaiting(pid, null);
  serviceScans.set(pid, error
    ? { status: "error", startedAt: a.startedAt, finishedAt: Date.now(), error: String(error?.message || error).slice(0, 300) }
    : result);
  if (!a.afterRun) return;
  let proj = null;
  try { proj = store.getProject(pid); } catch (e) { console.error(`[scan] ${pid}: after-run not started:`, e?.message || e); }
  if (proj) runServicesScan(proj, a.afterRun);
}

async function reconcile(proj, a, services, dismissed) {
  // SYNTAX-check the scan's start commands (shell -n) — repair or empty broken ones instead of registering guaranteed failed
  // starts; report emptied ones via a notice.
  const dropped = [];
  for (const s of services) {
    const r = sanitizeStartCommand(s.startCommand);
    if (r.dropped) dropped.push(`${s.name}: ${s.startCommand}`);
    s.startCommand = r.cmd;
  }
  if (dropped.length) {
    recordNotice({
      kind: "down",
      title: T("Scan: invalid start commands discarded"),
      body: [proj.name, ...dropped.slice(0, 5)].join("\n"),
      projectId: proj.id, projectName: proj.name, workspaceId: proj.workspaceId ?? null,
    });
  }
  // Fields that looked like a credential — service and field, never the value.
  if (dismissed.length) {
    const rows = dismissed.map((v) => `${v.name || T`Service ${v.seq}`}: ${v.fields.join(", ")}`);
    recordNotice({
      kind: "down",
      title: T("Scan: fields with a possible secret discarded"),
      body: [proj.name, ...rows.slice(0, 5), ...(rows.length > 5 ? [T`… and ${rows.length - 5} more`] : [])].join("\n"),
      projectId: proj.id, projectName: proj.name, workspaceId: proj.workspaceId ?? null,
    });
  }
  // Reconcile instead of replace (store/projects.js reconcileScan): a detected service keeps its id (desired.services, the
  // run key in services.js), a manually registered one stays with its content. A row created by the scan that it did not
  // name this time drops — unless it runs or is in the desired state (otherwise every re-scan would pile up a startable
  // duplicate under a new name). The notice says both instead of doing it silently.
  // `onlySupplement`: nothing drops — the verdict "running" is not needed then.
  const { notFound, removed } = a.onlySupplement
    ? store.reconcileScan(proj.id, services, { onlySupplement: true })
    : store.reconcileScan(proj.id, services, { keep: await notToRemove(proj.id) });
  if (notFound.length) {
    recordNotice({
      kind: "info",
      title: T("Scan: registered services not found — they stay"),
      body: [proj.name, ...namesRows(notFound)].join("\n"),
      projectId: proj.id, projectName: proj.name, workspaceId: proj.workspaceId ?? null,
    });
  }
  if (removed.length) {
    recordNotice({
      kind: "info",
      title: T("Scan: services no longer found — removed"),
      body: [proj.name, ...namesRows(removed)].join("\n"),
      projectId: proj.id, projectName: proj.name, workspaceId: proj.workspaceId ?? null,
    });
  }
  // Conflicts = ports this project shares with ANOTHER project according to the scan (only noted for the warning icons).
  // The ONE computation without converted projects: a converted one has no conflicts.
  const conflicts = store.projectPortConflicts(convertedProjects())[proj.id] ?? [];
  return { status: "done", startedAt: a.startedAt, finishedAt: Date.now(), count: services.length, conflicts, notFound, removed };
}

// The source "detection" of the storage queue (registered in server.js): every waiting detection that counts in storage
// waiting (`storage`); the same pass also tries the others as a fallback (a missed wakeup).
function detectionCandidates() {
  return [...jobs]
    .filter(([, a]) => a.phase === "waiting" && a.waiting)
    .map(([pid, a]) => ({ waitingSince: a.startedAt, storage: a.waiting === "storage", attempts: () => ({ started: attempts(pid) }) }));
}

export { detectionCandidates, runServicesScan, serviceScans };
