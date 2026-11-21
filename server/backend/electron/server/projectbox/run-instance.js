// The source of the run instance. server.js sets it in `runs/instance.js` (setInstanceSource) and the container question in
// `runtime/inProject.js` (setInProjectSeam) — `runs/` and `runtime/` do not import `projectbox/`.
//
// runInstance(projectId, instance = "main")  the instance in which a start runs NOW: the mapped row (store.projectInstance), EXACTLY
//   WHEN the ops marker stands (ops.js) AND the project is converted (`converted_at` of the main instance, store.converted). Otherwise
//   `null` — without an instance row or without operations every start stays `spawn`. The state of the instance (ready, stopped,
//   error) does NOT decide here: a stopped container is started by the restore, the lock of a run sits in doRun; an exec against a
//   stopped container fails with the message of the docker CLI instead of silently running in B.
//   NOT READABLE THROWS: if the database throws (SQLITE_BUSY, missing table), this question throws too — "not readable" is not "not
//   converted" (empty is not unknown), and `null` would mean: the start runs in B at the old path, possibly in parallel with the
//   relocation. The callers fail visibly with that (turn, agent, route: 500, fence: rejected). Asked only through the source that
//   startServer sets after initStore.
//   THE LIMIT: it throws only if an instance row COULD concern this project (store.instanceRowPossible — the set in memory, without the
//   database that just threw). If the project carries none, the answer is `null`: in B without a row no start fails on a read error.
// containerOf(inst)  the project container a `docker exec` goes to: for the main instance ALWAYS the stable name `cbase-p-<projectId>`
//   (cleanUp.js projectContainerName — ONE place for the name; the creation assigns it with `--name` and checks beforehand that it does
//   not exist). The id of the row is a SNAPSHOT — a core holds the instance of its image for hours, and after a recreation (old container
//   removed by id, new one under the same name) a start from that core (say `cbase_agent_send` to a finished agent) would go to the old
//   id — "No such container". The name carries across every recreation. Removal stays by id only; `exec` is no removal. The same for EVERY
//   instance — a copy is called `cbase-k-<pid>-<name>` (creation.js containerName) and is created again under the same name after a
//   recreation like the main; an invalid instance throws. An instance with `helperId` means the HELPER container with that id (the
//   clone helper of a copy: the code snapshot runs there via gitRun/commandRun as agent, stacks/code-snapshot.js) — never an instance
//   row, only an object of the caller; the id is checked like a name (no leading "-").
import * as store from "../store.js";
import { MAIN, containerName } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { projectContainerName } from "./cleanUp.js";

export function runInstance(projectId, instance = MAIN) {
  if (!projectId || !projectboxOps()) return null;
  try {
    if (!store.converted(String(projectId))) return null;
    return store.projectInstance(String(projectId), String(instance || MAIN)) || null;
  } catch (e) {
    if (!store.instanceRowPossible(String(projectId))) {
      console.error(`[project] instance of project ${projectId} not readable (${e?.message || e}) — no instance row that could concern it: today's way`);
      return null;
    }
    throw new Error(`Instance of project ${projectId} not readable (${e?.message || e}) — no start in B at the old path`, { cause: e });
  }
}

export const containerOf = (inst) => {
  if (inst?.helperId !== undefined) {
    const id = String(inst.helperId || "");
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new TypeError(`containerOf: invalid helper id “${id}”`);
    return id;
  }
  return (inst?.instance || MAIN) === MAIN ? projectContainerName(inst?.projectId) : containerName(inst?.projectId, inst.instance);
};
