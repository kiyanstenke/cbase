// The network targets of the project containers. What a network path of the backend — probe, port list, tunnel — must know about an
// instance, and nothing beyond that:
//
//   target = { identifier, projectId, instance, ip, container }
//     identifier  "<projectId>/<instance>" — the same identifier as at the token (projectbox/token.js), in the image of a subagent
//                 (runs/instance.js) and in the environment of the cbase MCP (`CBASE_INSTANCE`, toolchain/mcp-config.js). It is the value
//                 of the query parameter `instance` at /api/ports/running, /api/ports/free and /api/tunnel.
//     ip          the address of the instance in the project network (column `ip`; in the test the second loopback address). Empty if the
//                 row carries none — such a target is known but not reachable.
//     container   the name for `docker exec` (run-instance.js containerOf — for `main` the stable name cbase-p-<id>).
//
// instanceTarget(identifier)  the target for an identifier — EXACTLY WHEN the ops marker stands and the project is converted
//   (run-instance.js runInstance, the same question as every start). Otherwise `null`: without operations or unknown. Throws if the
//   database COULD concern a row and is not readable (runInstance) — "not readable" is not "unknown".
// instanceTargets()  all targets of converted projects, in creation order; without operations `[]`. The same limit as above: if a read
//   error throws and there cannot be any row at all (store.instanceRowPossible), the answer is `[]` — otherwise it throws.
// convertedProjects()  the ids of the projects for which there are targets, as a Set — the set that the conflict computation exempts
//   (store.portConflicts/projectPortConflicts). The same source as the namespaces of the port list, so that "no conflict" and "own
//   namespace" never fall apart. Without operations empty; throws like instanceTargets.
//
// WHY HERE. ports.js and tunnel.js are leaves and do not import the store: tunnel.js gets both questions through
// `attachTunnel(server, { targets })` from server.js, the port routes (projects/routes.js) ask here.
import * as store from "../store.js";
import { MAIN } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { containerOf, runInstance } from "./run-instance.js";

/** The network target of a mapped instance row — `null` without a row. */
export function networkTarget(inst) {
  if (!inst?.projectId) return null;
  const instance = String(inst.instance || MAIN);
  return {
    identifier: inst.identifier || `${inst.projectId}/${instance}`,
    projectId: String(inst.projectId),
    instance,
    ip: String(inst.ip || ""),
    container: containerOf(inst),
  };
}

/** Splits "<projectId>/<instance>" — `null` if it is no identifier. */
export function identifierParts(identifier) {
  if (typeof identifier !== "string") return null;
  const i = identifier.lastIndexOf("/");
  if (i <= 0 || i === identifier.length - 1) return null;
  return { projectId: identifier.slice(0, i), instance: identifier.slice(i + 1) };
}

export function instanceTarget(identifier) {
  const parts = identifierParts(identifier);
  if (!parts || !projectboxOps()) return null;
  return networkTarget(runInstance(parts.projectId, parts.instance));
}

export function instanceTargets() {
  if (!projectboxOps()) return [];
  let rows;
  try {
    rows = store.projectInstances();
  } catch (e) {
    if (!store.instanceRowPossible()) return [];
    throw new Error(`Instances not readable (${e?.message || e}) — no port list and no tunnel past the instances`, { cause: e });
  }
  // A PROJECT is converted (the main instance carries `converted_at`, store.converted) — its instances are targets.
  const converted = new Set(rows.filter((z) => z.instance === MAIN && z.convertedAt).map((z) => z.projectId));
  return rows.filter((z) => converted.has(z.projectId)).map(networkTarget);
}

export function convertedProjects() {
  return new Set(instanceTargets().map((z) => z.projectId));
}
