// Port conflicts in the transition. Until all projects are relocated, both exist side by side: unconverted projects share the loopback
// of B and can quarrel about a port — for them the conflict display and the old prompt sentence stay as they are. A converted project
// listens in the own namespace of its project container: its ports belong to it, the defaults of its repo apply, nothing is reassigned.
// The conflict computation itself stands in the data layer (store.portConflicts/projectPortConflicts), the set of converted projects in
// network-targets.js (convertedProjects) — here stands what the tools SAY and DO about it.
//
// PORT_HINT  the sentence in the RESULT of cbase_ports_list (via GET /api/ports) and cbase_service_update (via PATCH
//   /api/project-services/:id) at every service of a converted project. The tool description stays static (mcp/tools/services.js
//   "machine-wide") — otherwise prompt, cache and mcp-catalog snapshot of ALL chats would change.
// portsWithHint(claims, converted)  GET /api/ports: every claim of a converted project carries `hint`. Without a converted project the
//   same list (the same array) — byte-equal to before.
// portChange({ service, port, converted })  PATCH: may the field `port` of the service get this value?
//   not converted ⇒ yes (as before) · unchanged ⇒ yes · converted ⇒ only if something already listens on the new port IN the instance
//   (checkPort on its IP): that is no reassigning, the registration follows the run. Without this way a wrongly registered port (a
//   return path that could not recognize it) could not even be corrected by hand. `null` (remove the port) has no port on which
//   something could listen — rejected; whoever wants to get rid of the service deletes it. An instance without an address cannot be
//   measured — rejected, with a reason.
//   Answer: `{ ok: true }` or `{ ok: false, status: 409, error }`.
import { checkPort } from "../ports.js";
import { MAIN } from "./creation.js";
import { instanceTarget } from "./network-targets.js";

export const PORT_HINT = "Project in its own container: its ports belong to the project, the defaults of its repo apply, ports are not reassigned. There is no conflict with ports of other projects (own network namespace); cbase_service_update changes `port` here only to a port on which the service already listens in the container.";

export function portsWithHint(claims, converted) {
  if (!converted?.size) return claims;
  return claims.map((a) => (converted.has(String(a.projectId)) ? { ...a, hint: PORT_HINT } : a));
}

export async function portChange({ service, port, converted }) {
  if (!service || !converted?.has(String(service.projectId))) return { ok: true };
  if (port === (service.port ?? null)) return { ok: true };
  const header = `${PORT_HINT} Rejected:`;
  if (port === null) return { ok: false, status: 409, error: `${header} the port of a service in the project container is not removed — if the service no longer exists, cbase_service_delete.` };
  const target = instanceTarget(`${service.projectId}/${MAIN}`);
  if (!target?.ip) return { ok: false, status: 409, error: `${header} the instance of the project has no address — whether anything listens on ${port} there cannot be measured.` };
  if (!(await checkPort(port, undefined, { host: target.ip }))) {
    return { ok: false, status: 409, error: `${header} nothing listens on ${port} in the project container — only a port on which the service already runs there is followed.` };
  }
  return { ok: true };
}
