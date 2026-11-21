// The names `<project>.cbase` of the project containers. Chats without a project, the workspace terminal and the workspace browser
// run in B and reach a converted project under its name: one line `<ip> <name>.cbase` per instance in the block of /etc/hosts
// (projectbox/hosts-file.js).
//
// THE RULE: `slugifyTitle(proj.name)` (store/_util.js) + `.cbase`. On a collision in the same user container — also across
// workspaces, the database is one per user — the first free one of `-2`, `-3`, … in creation order (the same rule as
// workflows/shortName.js). The name stands in the instance row (`dns_name`, store/project-instances.js) and stays FIXED after
// creation: a renamed project keeps it, a recreation too. Two DNS limits beyond the rule: a label has at most 63 characters
// (slugifyTitle cuts to 64) — cut so that the ending `-N` fits; and an empty slug (a name of punctuation only) is `project`.
// THE COPIES: a copy `copy-<name>` is called `<name>.<label of the main's name>.cbase` — `k1.shop.cbase` next to `shop.cbase`. Unique
// without a rule of its own: the main's name is unique across all projects, a copy's name across the copies of its project
// (stacks/), and a main name has only ONE label before the ending. It is assigned like the main's, synchronously at creation
// (instance.js); without a stored name of the main none yet (bringAlongNames fetches it later, mains first).
//
// dnsNameOf(projectId, instance = "main")   the name of the instance: the stored one, else for the main the first free one by the
//     rule, for a copy the form above (null while the main carries no stored one) — NOT stored, the creation does that in the same
//     synchronous step, projectbox/instance.js, so that no second creation draws the same name in between; the unique index catches
//     it otherwise. An invalid instance throws (creation.js copyNameOf).
// hostsEntries()         per row with address and name `{ ip, name }`, in creation order — main and copies.
// projectInstanceField(projects)  the list of `GET /api/projects` with the field `instance` on every project that has a main
//     instance: `{ identifier, state, converted, name, container }` and — ONLY if the project has copy rows — `copies: [{ identifier,
//     name, chatId, state, copyState }]` in creation order — only ids, states and names, no paths and no error texts. `state` is the
//     instance row's, `copyState` that of the living copy row in `stack_copies` (`ready`, `clearAway`, `error` …; "" without a living
//     row): a copy being cleared away (also `earmarked`) or after a failed clearing keeps its instance row `ready`, and a chat's instance choice
//     (web/src/lib/instances-tree.ts chatInstanceOptions, iOS twin) offered it although runs/instance-switch.js instanceChoice rejects
//     it with 409 — so both states are here. `cbase-project` (server/backend/cbase-project; `<project>/<copy>`) resolves from it.
//     Without an instance row the project object stays unchanged, without any row the list itself, without a copy the field.
// bringAlongNames({ path })  ONLY with an ops marker: gives every instance with an address that carries no name yet one (first the
//     mains, then the copies, each in creation order; via the setter projectbox/instances.js — a copy without its main's name stays
//     without), and writes the block. Callers: the restart grace (hook "restart grace", name "project-names", registered in server.js
//     — /etc/hosts arises anew with every build of B), the creation and recreation (projectbox/instance.js) and the deletion
//     (projectbox/erase.js); later the restore. Without an ops marker: `{ ops: false }`, no file touched.
import * as store from "../store.js";
import { COPY_PREFIX, containerName, copyNameOf } from "./creation.js";
import { projectboxOps } from "./ops.js";
import { hostsPath, writeHostsBlock } from "./hosts-file.js";
import { setInstanceState } from "./instances.js";

export const NAMES_SUFFIX = ".cbase";
export const LABEL_MAX = 63;
const MAIN = "main";

/** The base form of the name (without ending): the slug, limited to a DNS label, empty ⇒ "project". */
export function nameBase(projectName, slot = 0) {
  const slug = store.slugifyTitle(projectName).slice(0, LABEL_MAX - slot).replace(/-+$/, "");
  return slug || "project";
}

/** The first free name of base, base-2, base-3, … against the allocated ones (full names with ending). */
export function freeName(projectName, allocated) {
  const occupied = allocated instanceof Set ? allocated : new Set(allocated || []);
  const first = `${nameBase(projectName)}${NAMES_SUFFIX}`;
  if (!occupied.has(first)) return first;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${nameBase(projectName, suffix.length)}${suffix}${NAMES_SUFFIX}`;
    if (!occupied.has(name)) return name;
  }
}

const withoutSuffix = (name) => (name.endsWith(NAMES_SUFFIX) ? name.slice(0, -NAMES_SUFFIX.length) : name);

/** The name of an instance of a project: stored, else the first free one (main) or the form of the copy (see header). */
export function dnsNameOf(projectId, instance = MAIN) {
  const pid = String(projectId);
  const inst = String(instance || MAIN);
  const copy = copyNameOf(inst); // throws for an invalid instance
  const own = store.projectInstance(pid, inst)?.dnsName;
  if (own) return own;
  if (copy !== null) {
    const main = store.projectInstance(pid, MAIN)?.dnsName;
    return main ? `${copy}.${withoutSuffix(main)}${NAMES_SUFFIX}` : null;
  }
  const proj = store.getProject(pid);
  const allocated = new Set(store.projectInstances().filter((z) => !(z.projectId === pid && z.instance === MAIN) && z.dnsName).map((z) => z.dnsName));
  return freeName(proj?.name || pid, allocated);
}

/** `GET /api/projects` with `instance` per project with a main instance (see header). */
export function projectInstanceField(projects) {
  const all = store.projectInstances();
  const rows = new Map(all.filter((z) => z.instance === MAIN).map((z) => [z.projectId, z]));
  if (!rows.size) return projects;
  // The state of the living copy row per instance (ONE query across all projects) — "" means "no living row".
  const copyStates = new Map(store.liveStackCopies().map((k) => [`${k.projectId}/${COPY_PREFIX}${k.name}`, k.state]));
  const copies = new Map(); // the copy rows per project, in creation order
  for (const z of all) {
    if (z.instance === MAIN || !String(z.instance).startsWith(COPY_PREFIX)) continue;
    if (!copies.has(z.projectId)) copies.set(z.projectId, []);
    copies.get(z.projectId).push({ identifier: z.identifier, name: z.dnsName || "", chatId: z.chatId || "", state: z.state, copyState: copyStates.get(z.identifier) || "" });
  }
  return projects.map((p) => {
    const z = rows.get(String(p?.id));
    if (!z) return p;
    const k = copies.get(z.projectId);
    return { ...p, instance: { identifier: z.identifier, state: z.state, converted: Boolean(z.convertedAt), name: z.dnsName || "", container: containerName(z.projectId), ...(k ? { copies: k } : {}) } };
  });
}

/** The lines of the block: every instance with address AND name, in creation order. */
export function hostsEntries() {
  return store.projectInstances().filter((z) => z.ip && z.dnsName).map((z) => ({ ip: z.ip, name: z.dnsName }));
}

/**
 * Assign missing names and write the block (see header) — synchronous, never a throw. Returns `{ ops: false }` without an ops marker,
 * else the result of writeHostsBlock plus `path` and `allocated` (the newly assigned names).
 */
export function bringAlongNames({ path } = {}) {
  if (!projectboxOps()) return { ops: false };
  const allocated = [];
  let without = [];
  // First the mains, then the copies: a copy's name hangs on its main's name.
  try {
    const all = store.projectInstances().filter((z) => z.ip && !z.dnsName);
    without = [...all.filter((z) => z.instance === MAIN), ...all.filter((z) => z.instance !== MAIN)];
  } catch (e) { console.warn(`[projectbox] names: instance rows not readable (${e?.message || e})`); }
  for (const z of without) {
    try {
      const name = dnsNameOf(z.projectId, z.instance);
      if (!name) { console.warn(`[projectbox] name for ${z.identifier}: the main carries none yet — later`); continue; }
      // The same state: no change, no event, no wakeup — only the name (only the setter changes the row).
      setInstanceState(z.projectId, z.instance, z.state, { dnsName: name });
      allocated.push({ identifier: z.identifier, name });
    } catch (e) { console.warn(`[projectbox] name for ${z.identifier} not assigned: ${e?.message || e}`); }
  }
  const target = path || hostsPath();
  let entries = [];
  try { entries = hostsEntries(); } catch (e) {
    // Empty is not unknown: without readable rows an empty block would write every name away.
    const error = `instance rows not readable (${e?.message || e}) — ${target} stays as it is`;
    console.warn(`[projectbox] ${error}`);
    return { written: false, unchanged: false, error, skipped: [], path: target, allocated };
  }
  return { ...writeHostsBlock(target, entries), path: target, allocated };
}

/** Consumer of the hook "restart grace" (registered in server.js as "project-names"): /etc/hosts arises anew with B. */
export function projectNamesRestartGrace() {
  bringAlongNames();
}
