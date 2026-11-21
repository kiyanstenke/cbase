// The instances of a project in the responses of the services pill. The contract for web (ServicesPill) and iOS
// (ServicesButton) — keys and field names exactly like this:
//   GET /api/project-services   per service  `instances: [{ identifier, running, holdsStart }]`
//   GET /api/project-resources  per project `instances: [{ identifier, name, dnsName, chatId, chatTitle, state, cpu, memBytes, containers }]`
//     (the resources also carry `dockerUp`, `memLimitBytes`; they stay, the contract is the subset. `containers` — the running
//     containers of the instance — is part of it: the Apps page reads "running" from it.)
//   identifier  `<projectId>/<instance>` (main: `<projectId>/main`)     running  bool, the state of THIS instance
//   holdsStart  bool, the start guard of THIS instance: a live run that does not listen on the registered port holds its start
//            (services.js startHeld with `instance`) — like `holdsStart` of the service row, only per instance; true only
//            next to `running: false`. A client offers "Stop" on `running || holdsStart` of the CHOSEN instance, otherwise its
//            start would end in 409 SERVICE_RUNNING without a stop button. The entry of main IS the value of the service row
//            (one answer, not two).
//   name     `main` or the copy name (`k1`)                            dnsName  `<slug>.cbase` or "" without a name
//   chatId   the chat of the copy ("" in main)                         chatTitle  its title ("" without chat / title)
//   state    the state of the instance row                             cpu/memBytes  the numbers of the instance
// The fields exist ONLY from two instances on (main plus at least one converted copy; at `/api/project-resources` only an
// instance whose row still exists when enriching counts). With one instance — every project without a copy, every call
// without the ops marker — the response carries no `instances` and is byte-identical.
// Guard: server/backend/test/project-instances-pill.test.js.
import * as store from "../store.js";
import { MAIN, copyNameOf } from "../projectbox/creation.js";
import { copiesOf } from "../projectbox/services.js";
import { identifierParts } from "../projectbox/network-targets.js";

/** The instances of the project, main first: `["main", "copy-k1", …]` — empty as long as there are not at least two. */
export function instancesFromTwo(projectId) {
  const copies = copiesOf(projectId);
  return copies.length ? [MAIN, ...copies] : [];
}

/**
 * The service with its state per instance, only from two instances on (otherwise the same value). Per copy `probe(instance)`
 * asks "running?" and — only next to "no" — `holds(instance)` "does a live run hold the start?"; a throw counts as "no" in
 * each case. Main takes `runningInMain` and the `holdsStart` of the service row.
 */
export async function serviceWithInstances(service, instances, runningInMain, probe, holds) {
  if (typeof probe !== "function" || typeof holds !== "function") throw new TypeError("serviceWithInstances: probe and holds are required");
  if (instances.length < 2) return service;
  const question = (fn, instance) => Promise.resolve().then(() => fn(instance)).then(Boolean, () => false);
  const list = await Promise.all(instances.map(async (instance) => {
    const identifier = `${service.projectId}/${instance}`;
    if (instance === MAIN) return { identifier, running: Boolean(runningInMain), holdsStart: Boolean(service.holdsStart) };
    const running = await question(probe, instance);
    return { identifier, running, holdsStart: !running && (await question(holds, instance)) };
  }));
  return { ...service, instances: list };
}

const instanceName = (instance) => { try { return copyNameOf(instance) ?? MAIN; } catch { return ""; } };

/**
 * The rows of `projectResources` with the contract's fields per instance (only where `instances` came with two or more).
 * An instance WITHOUT a row drops out. projectResources takes the copy list BEFORE `docker stats` measures (seconds), and
 * clearing deletes the row last — in between a copy would arrive with `state: ""` and the Apps page would show it as
 * "stopped" with a "Clear" button. Its numbers leave the project row with it (the sum stays that of the shown instances); if
 * fewer than two remain, `instances` is absent entirely (one instance is byte-identical).
 */
export function resourcesWithInstances(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((z) => {
    if (!Array.isArray(z?.instances) || z.instances.length < 2) return z;
    const instances = [];
    const gone = [];
    for (const i of z.instances) {
      const parts = identifierParts(String(i.identifier));
      const row = parts ? store.projectInstance(parts.projectId, parts.instance) : null;
      if (!row) { gone.push(i); continue; }
      const chatId = row.chatId || "";
      let chatTitle = "";
      if (chatId) { try { chatTitle = store.getChat(chatId)?.title || ""; } catch { chatTitle = ""; } }
      instances.push({
        ...i,
        name: instanceName(parts.instance),
        dnsName: row.dnsName || "",
        chatId,
        chatTitle,
        state: row.state || "",
        cpu: Number(i.cpu) || 0,
        memBytes: Number(i.memBytes) || 0,
      });
    }
    const without = gone.length ? withoutInstances(z, gone) : z;
    if (instances.length < 2) {
      const rest = { ...without };
      delete rest.instances;
      return rest;
    }
    return { ...without, instances };
  });
}

// The project row without the numbers of dropped instances (the sum of projectResources, aggregateContainerStats: CPU rounded
// to one decimal, `memLimitBytes` is a maximum and stays).
function withoutInstances(z, gone) {
  let cpu = Number(z.cpu) || 0;
  let memBytes = Number(z.memBytes) || 0;
  let containers = Number(z.containers) || 0;
  for (const i of gone) {
    cpu -= Number(i.cpu) || 0;
    memBytes -= Number(i.memBytes) || 0;
    containers -= Number(i.containers) || 0;
  }
  return { ...z, cpu: Math.max(0, Math.round(cpu * 10) / 10), memBytes: Math.max(0, memBytes), containers: Math.max(0, containers) };
}
