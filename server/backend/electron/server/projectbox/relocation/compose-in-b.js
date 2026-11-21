// Compose containers in B next to converted projects — a leaf of its own. New projects arise in operations WITH an instance row, nothing
// has to relocate by itself any more. What remains is this finding for the operator's status check.
//
// WHAT. `composeInB()` names per CONVERTED project (instance row MAIN) every container in the daemon of B whose Compose `working_dir`
// lies in its project folder — `[{ projectId, name, container, running }]`. After the relocation no stack container of a converted
// project runs in B any more; one that (again) RUNS there is a finding (a `docker compose up` past cbase). A stopped one (`running:
// false`) is mostly a leftover that the relocation deliberately left in B (one-shot containers, changed labels — ./procedure.js) and
// stands there only as a notice (`ps -a` also lists stopped ones). If docker does not answer (or the ops marker is missing — the seam
// then throws `NO_OPS`), the result is `null` — unknown, not "none" (`[]`).
//
// THE CAP of the `ps` is SHORT: an operator's status tool reads the route with `curl --max-time 5` (compose-in-b-limits.js); with
// the 120-s default of the seam, a sluggish docker in B (say right after a swap, while the restore runs) dropped the WHOLE answer, also
// its synchronous part. At the cap only `composeInB` is unknown (`null`), the message names the cap.
//
// Read by GET /api/projectbox/ops-status (./routes.js projectboxOpsRoutes, field `composeInB`). Guard:
// server/backend/test/compose-in-b.test.js.
import * as store from "../../store.js";
import { realPath, inArea } from "../../runtime/real-path.js";
import { PS_TEMPLATE, containerFromPs } from "../../services.js";
import { MAIN } from "../creation.js";
import { docker } from "../docker.js";

export { COMPOSE_IN_B_CAP_MS, OPS_STATUS_CURL_MAX_TIME_S } from "./compose-in-b-limits.js";
import { COMPOSE_IN_B_CAP_MS } from "./compose-in-b-limits.js";

// ONE `docker ps -a` in B — the fields of services.js PS_TEMPLATE, never `{{json .}}` (it fetched the sizes) — → the list (services.js
// containerFromPs, `folder` = working_dir after realpath). Throws if docker does not answer.
async function containerInB({ capMs }) {
  const r = await docker(["ps", "-a", "--no-trunc", "--format", PS_TEMPLATE], { capMs });
  return containerFromPs(r.stdout);
}

// The containers of the list whose Compose `working_dir` lies in the project folder — with state.
function containerInProject(list, path) {
  let root;
  try { root = realPath(path); } catch { return []; }
  return list.filter((c) => c.folder && inArea(c.folder, [root])).map((c) => ({ name: c.name, running: c.running === true }));
}

/** `[{ projectId, name, container, running }]` per converted project, or `null` if docker in B is not readable (see header). */
export async function composeInB() {
  try {
    const list = await containerInB({ capMs: COMPOSE_IN_B_CAP_MS });
    const out = [];
    for (const p of store.listAllProjects()) {
      if (!p.path || !store.projectInstance(p.id, MAIN)) continue;
      for (const c of containerInProject(list, p.path)) out.push({ projectId: p.id, name: p.name, container: c.name, running: c.running });
    }
    return out;
  } catch (e) {
    if (e?.code !== "NO_OPS") console.warn(`[ops-status] containers in B not readable (${e?.message || e}) — composeInB unknown`);
    return null;
  }
}
