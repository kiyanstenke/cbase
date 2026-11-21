// The dismantling of a half-built copy. Two callers, one path:
//   - the build itself (stacks/build.js) when a step after the freeze fails (`reason` "error");
//   - the queue (stacks/queue.js, wired via setCopyDismantling in server.js) after the restart of an orphaned build and
//     after a procedure that ended without a final state.
// It occupies nothing itself — the occupancy is held by the caller (build: the project occupancy "copy"; after a
// restart: the instance occupancy "copy-dismantling").
//
// dismantleCopy({ copy, instance, journal, reason, rootCause }, { data }) → { removed, error: [], stayed }; THROWS if
//   something stayed. `rootCause` (optional, from the build: `{ step, code }`) only goes into the journal.
//   In this order, each by id and only with the labels of THIS instance:
//     1. copy containers: `ps -a` filtered by the project and instance label, of those only the ones that carry the
//        labels ON the container (projectbox/erase.js onlyOwn — ONE filter with the delete), `rm -f` by id;
//     2. its network: `network ls` with the same labels, `network rm` by id;
//     3. what the freeze created (stacks/freeze.js dismantlingClone: helper, volume of the copy, the location with its
//        layer via the root helper, LAST the instance row) — with what the journal (`data.freeze`) carries as "this
//        build created it": without the section it touches neither volume nor location (they are not its own then);
//     4. the token of the identifier (projectbox/token.js forgetToken);
//     5. the block in /etc/hosts (projectbox/names.js bringAlongNames — without the row the copy's name drops).
//   Without the ops marker it calls no docker: then it only takes the instance row — if the journal reported container,
//   volume or location, it THROWS with the sentence of what stayed. Into the journal (section `dismantling`): reason,
//   root cause, what was removed, errors.
// Guards: server/backend/test/stacks-creation.test.js (full dismantling after a missing ref),
// server/backend/test/stacks-queue.test.js (after a restart, via the wiring).
import * as store from "../store.js";
import { T } from "../i18n.js";
import { DIRS } from "../app-state.js";
import { LABEL_INSTANCE, LABEL_PROJECT } from "../projectbox/creation.js";
import { projectboxOps } from "../projectbox/ops.js";
import { DockerError, docker } from "../projectbox/docker.js";
import { onlyOwn } from "../projectbox/erase.js";
import { bringAlongNames } from "../projectbox/names.js";
import { forgetToken } from "../projectbox/token.js";
import { dismantlingClone } from "./freeze.js";
import { CopyError } from "./state.js";

const ids = (text) => String(text || "").split(/\s+/).filter(Boolean);
const missing = (e) => e instanceof DockerError && /No such (object|container|network)|not found/i.test(`${e.stderr}\n${e.message}`);
const text = (e) => String(e?.message || e || "unknown").split("\n")[0].slice(0, 400);

export async function dismantleCopy({ copy, instance, journal, reason = "", rootCause = null }, { data = null } = {}) {
  const pid = String(copy.projectId);
  const name = copy.name;
  const identifier = store.instanceIdentifier(pid, instance);
  const one = store.stackCopy(copy.id)?.journal?.data?.freeze || copy.journal?.data?.freeze || null;
  const removed = [];
  const error = [];
  const stayed = []; // containers that carry the labels only from their image: not copy containers, not an error
  const attempts = async (what, fn) => { try { if (await fn()) removed.push(what); } catch (e) { error.push(`${what}: ${text(e)}`); } };

  if (!projectboxOps()) {
    const open = one && (one.location || one.volume || one.helperId) ? [T("helper/volume/location of the freeze")] : [];
    const row = store.projectInstance(pid, instance);
    if (row?.containerId) open.push(`Container ${String(row.containerId).slice(0, 12)}`);
    if (open.length) error.push(T`without the ops marker no docker — left standing: ${open.join(", ")}`);
    else await attempts(T`instance row ${identifier}`, () => store.deleteProjectInstance(pid, instance) > 0);
  } else {
    const filter = ["--filter", `label=${LABEL_PROJECT}=${pid}`, "--filter", `label=${LABEL_INSTANCE}=${instance}`];
    // 1. Container
    let container = [];
    try {
      const { own, inherited } = await onlyOwn(ids((await docker(["ps", "-aq", "--no-trunc", ...filter])).stdout));
      container = own;
      for (const id of inherited) stayed.push(T`Container ${id.slice(0, 12)} carries the labels only from its image — not a copy container, stays`);
    } catch (e) { error.push(T`searching containers: ${text(e)}`); }
    for (const id of container) {
      await attempts(`Container ${id.slice(0, 12)}`, async () => {
        try { await docker(["rm", "-f", id]); return true; } catch (e) { if (missing(e)) return false; throw e; }
      });
    }
    // 2. network
    let networks = [];
    try { networks = ids((await docker(["network", "ls", "-q", "--no-trunc", ...filter])).stdout); } catch (e) { error.push(T`searching networks: ${text(e)}`); }
    for (const id of networks) {
      await attempts(T`network ${id.slice(0, 12)}`, async () => {
        try { await docker(["network", "rm", id]); return true; } catch (e) { if (missing(e)) return false; throw e; }
      });
    }
    // 3. helper, volume, location (with its layer), last the instance row — only if container and network are gone (the
    // volume hangs on the container, and the row would otherwise no longer hold on to anything).
    if (!error.length) {
      const r = await dismantlingClone({
        projectId: pid, name, data: data || DIRS.data,
        volume: one?.volume === true, location: one?.location === true, helperId: one?.helperId || null,
      });
      removed.push(...r.removed);
      error.push(...r.error);
    }
    forgetToken(identifier);
    // 5. the block in /etc/hosts — the creation wrote the copy's name; without the instance row the name drops (as on
    // delete, projectbox/erase.js). Also after an incomplete dismantling (then the row still stands, and the block does
    // not change); a failure there is a notice, not an error of the dismantling.
    try { bringAlongNames(); } catch (e) { console.warn(`[stacks] dismantling ${identifier}: names not updated: ${text(e)}`); }
  }
  try { await journal?.note({ dismantling: { reason, ...(rootCause ? { rootCause } : {}), removed, error, stayed } }); }
  catch (e) { error.push(`Journal: ${text(e)}`); }
  if (error.length) {
    throw new CopyError(T`Dismantling ${identifier} incomplete: ${error.join("; ")}`, { code: "COPY_DISMANTLING", status: 500 });
  }
  return { removed, error, stayed };
}
