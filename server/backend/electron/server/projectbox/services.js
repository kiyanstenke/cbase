// The domain side of the services in the project container. services.js is a leaf and does not know the store — what it must
// know about a converted project it gets through `setServicesSeam` from server.js, and the seam stands HERE:
//
// servicesSeam()  → { instanceFor, updateDesired, projectServices, copies } for services.js setServicesSeam:
//   instanceFor(projectId, instance)   the network target of the instance in which a service runs NOW (network-targets.js
//                            networkTarget via run-instance.js runInstance): `{ identifier, projectId, instance, ip, container }` EXACTLY
//                            WHEN the ops marker stands and the project is converted — else `null`, and every service takes today's way.
//                            Without an instance the main (runInstance has the same default). Throws like runInstance when the database
//                            COULD concern a row and is not readable ("not readable" is not "not converted").
//   updateDesired          carryForwardServiceDesired (below).
//   projectServices(projectId)  `{ name, workspaceId, path, services: [{ …service row, cwd }] }` or null — for services.js
//                            startDesiredServices: the same rows and the same working folder as the start button (projects/routes.js →
//                            coding-jobs.js serviceCwd).
//   copies(projectId)      names the copies of a converted project that should run: rows `copy-<name>` with `converted_at` (a copy in the
//                            build does not carry it yet), ascending. Without an ops marker, without a relocation and without a row that
//                            could concern the project (store.instanceRowPossible — without a database), `[]`: the monitor then asks
//                            nothing per pass and project as long as there is no copy.
//
// carryForwardServiceDesired(projectId, svcId, running, { instance })  the snapshot `desired` of an instance, field `services`: the ids of
//   the native services that cbase started in the project container (ascending, no duplicates). services.js calls it at EVERY plain start
//   (`running: true`) and EVERY stop (`false`) of a service through cbase — not at a crash and not when clearing a dead run: `desired` is
//   the intent, and a status look during the stop chain at server end would otherwise take it back before the restore reads it. Only
//   `services` changes; `container` and `time` stay those of the last container snapshot. If there is none yet, the shape of
//   `desiredFromInspect` without containers arises. Without an instance row it does nothing (returns null); unchanged it does not write.
//   Returns `desired` afterwards.
//
// nativeServicesStatus(projectId, { instance })  which REGISTERED native services of the instance run NOW: `[{ id, name, port, running }]`,
//   ascending by id. "Runs" means: the run lives or the port is open — services.js serviceStatus (`running`) or a run that holds a start
//   (`holdsStart`: the group lives, not listening yet). Never the desired state (`desired.services` keeps a crashed service). The RUN
//   decides "native", not the registration: a service with a start command and without a container is always in it (also `running:
//   false`); one with a registered container only if that container does NOT run in the instance and the service runs anyway (the
//   frontend via `npm run dev` next to a compose entry — services.js probeStatus knows the same case). If the container runs, the desired
//   state of the containers carries it, and it is no native service. For freezing a copy (stacks/freeze.js setNativeServicesStatus, set in
//   server.js) and clearing away (stacks/clearAway.js, stop the running ones of the copy); an unknown project throws.
import * as store from "../store.js";
import { serviceCwd } from "../projects/coding-jobs.js";
import { containerRunning, serviceStatus } from "../services.js";
import { MAIN } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { runInstance } from "./run-instance.js";
import { networkTarget } from "./network-targets.js";
import { desiredFromInspect } from "./serverEnd.js";

export function carryForwardServiceDesired(projectId, svcId, running, { instance = MAIN } = {}) {
  const id = Number(svcId);
  if (!projectId || !Number.isInteger(id)) return null;
  const inst = store.projectInstance(String(projectId), String(instance || MAIN));
  if (!inst) return null;
  const old = inst.desired && typeof inst.desired === "object" ? inst.desired : null;
  const prior = (Array.isArray(old?.services) ? old.services : []).map(Number).filter(Number.isInteger);
  const ids = new Set(prior);
  if (running) ids.add(id); else ids.delete(id);
  const services = [...ids].sort((a, b) => a - b);
  if (old && services.length === prior.length && services.every((d, i) => d === prior[i])) return old;
  const desired = old ? { ...old, services } : desiredFromInspect([], { services });
  store.changeProjectInstance(inst.projectId, inst.instance, { desired });
  return desired;
}

function projectServices(projectId) {
  const proj = store.getProject(String(projectId));
  if (!proj) return null;
  return {
    name: proj.name || "",
    workspaceId: proj.workspaceId ?? null,
    path: proj.path || "",
    services: store.listProjectServices(proj.id).map((s) => ({ ...s, cwd: serviceCwd(proj, s) })),
  };
}

export function copiesOf(projectId) {
  const pid = String(projectId ?? "");
  if (!pid || !projectboxOps() || !store.instanceRowPossible(pid)) return [];
  if (!store.converted(pid)) return [];
  return store.projectInstancesOf(pid)
    .filter((i) => i.instance !== MAIN && i.convertedAt)
    .map((i) => i.instance)
    .sort();
}

export async function nativeServicesStatus(projectId, { instance = MAIN } = {}) {
  const info = projectServices(projectId);
  if (!info) throw new Error(`Services: project ${projectId} unknown`);
  const pid = String(projectId);
  const out = [];
  let asked = false;
  for (const s of (info.services || []).filter((d) => d.startCommand)) {
    // The run decides "native", not the registration: the scanner registers a compose container even where the start command is
    // `npm run dev` (the frontend ran, the copy did not start it). If the registered container runs, the desired state of the
    // containers carries it; otherwise the service counts if it runs natively (port open or run alive — the same precedence as
    // probeStatus).
    // If the state of the inner daemon is unknown, the computation fails: a container service with an open port would otherwise count as
    // running natively and be started in the copy next to its own container.
    const c = s.container ? await containerRunning({ container: s.container, projectId: pid, projectPath: info.path, instance, fresh: !asked, dir: s.dir || "" }) : false;
    if (s.container) asked = true;
    if (c === null) throw new Error(`Services: state of the inner Docker of project ${pid} unknown — which service runs natively cannot be said`);
    if (c) continue;
    const st = await serviceStatus(pid, s.id, { port: s.port ?? null, projectPath: info.path, instance });
    const running = Boolean(st?.running || st?.holdsStart);
    if (s.container && !running) continue; // neither container nor native: no native service that was not running
    out.push({ id: s.id, name: s.name, port: Number.isInteger(s.port) ? s.port : null, running });
  }
  return out.sort((a, b) => a.id - b.id);
}

export function servicesSeam() {
  return {
    instanceFor: (projectId, instance) => networkTarget(runInstance(projectId, instance)),
    updateDesired: carryForwardServiceDesired,
    projectServices,
    copies: copiesOf,
  };
}
