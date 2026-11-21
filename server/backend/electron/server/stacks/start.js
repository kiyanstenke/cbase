// The start of a copy. One step of the build (stacks/build.js) after the preparation: `.prepared` is in place, the
// entrypoint unmounts the raw roots and starts dockerd.
//
// startCopy({ copy, inst, desired, policy, services }) → { desired, findings, notices, policy: { <flag>: [ids] }, services }
//   1. wait: projectbox/instance.js waitForInside(containerId) — `docker info` and the status file, as for the main
//      instance (the same cap) —, then checkInside: overlay2 and cgroup `memory` (ONE place with the creation of the
//      main instance).
//   2. desired state: the desired state from the freeze (`inspect` right before the pause; `services` = the native
//      services that were running THEN) into the instance row — runInstanceUp reads the services fresh from the row.
//   3. start up: projectbox/restore.js runInstanceUp(pid, inst, { containerId, desired, state: "create" }) — the stages
//      by `depends_on` (desired ∩ present: only what ran at the freeze), the native services via the starter with
//      instance, the names. Under the held project occupancy of the build, without a state transition. NOT
//      restoreInstance (it requires `converted_at`, only takes start/recreate, reports OCCUPIED under a held occupancy
//      and sets `ready` itself).
//   4. policy: `docker update --restart <old>` for every container of the policy protection — AFTER the start-up: an
//      `always` container that was not running at the freeze stays off but carries its policy again (the next restart
//      of the copy's dockerd starts it as in the main instance). A policy that cannot be read THROWS (restartFlag).
//   5. the desired state afterwards: desiredAfterRestore over the `inspect` of now (what did not come stays "running"
//      with `failed`), the native services of the row (withServicesOfNow) — into the instance row, still in `create`.
//   `ready` is set by the build (stacks/state.js, ONE conditional UPDATE). The finding of failed services is in the
//   result (`services`), not in the row's error text (the transition to `ready` clears it).
// restartFlag(policy)  PURE: a RestartPolicy (`{ Name, MaximumRetryCount }` as cbase-clone prints it, or the name) as
//   the value of `--restart` — `no`, `always`, `unless-stopped`, `on-failure[:n]`; everything else null.
// Guard: server/backend/test/stacks-creation.test.js.
import * as store from "../store.js";
import { T } from "../i18n.js";
import { dockerIn } from "../projectbox/docker.js";
import { CALL_CAP_MS, checkInside, waitForInside } from "../projectbox/instance.js";
import { setInstanceState } from "../projectbox/instances.js";
import { withServicesOfNow } from "../projectbox/serverEnd.js";
import { runInstanceUp, insideInspect, checkLiveness, desiredAfterRestore } from "../projectbox/restore.js";
import { CopyError } from "./state.js";

export function restartFlag(policy) {
  const name = typeof policy === "string" ? policy : policy && typeof policy === "object" ? policy.Name : undefined;
  if (name === "always" || name === "unless-stopped") return name;
  if (name === "no" || name === "") return "no";
  if (name === "on-failure") {
    const n = policy && typeof policy === "object" ? policy.MaximumRetryCount : 0;
    return Number.isInteger(n) && n > 0 ? `on-failure:${n}` : "on-failure";
  }
  return null;
}

// The native services for the result: those that ran at the freeze, and whether the starter reported that one failed.
// The wordings "native service <id>: …" and "native services: …" (for all) are written by projectbox/restore.js
// runInstanceUp — both sides must carry the same words.
function nativeInResult(services, notices) {
  const all = notices.some((m) => /^native services: /.test(m));
  return (Array.isArray(services) ? services : []).map((d) => {
    const failed = all || notices.some((m) => m.startsWith(`native service ${d.id}:`));
    return { name: d.name, kind: "native", state: !d.running ? "off" : failed ? "failed" : "running", port: Number.isInteger(d.port) ? d.port : null };
  });
}

export async function startCopy({ copy, inst, desired, policy = {}, services = null }) {
  const pid = copy.projectId;
  const instance = inst.instance;
  const containerId = inst.containerId;
  if (!containerId) throw new CopyError(T`Start ${pid}/${instance}: the instance row carries no container`, { code: "COPY_START", status: 500 });
  // Read the policies first: one that cannot be read is an error before anything starts.
  const byFlag = new Map();
  for (const [id, p] of Object.entries(policy || {})) {
    const flag = restartFlag(p);
    if (!flag) throw new CopyError(T`Policy protection: the old policy of ${String(id).slice(0, 12)} (${JSON.stringify(p)}) cannot be read — the copy would carry a wrong one`, { code: "COPY_START", status: 500 });
    if (!byFlag.has(flag)) byFlag.set(flag, []);
    byFlag.get(flag).push(id);
  }

  // 1. wait, check
  const { driver, status } = await waitForInside(containerId);
  await checkInside(containerId, { driver, status });

  // 2. desired state
  setInstanceState(pid, instance, "create", { desired });

  // 3. start up
  const { findings, notices, liveness } = await runInstanceUp(pid, store.projectInstance(pid, instance), { containerId, desired, state: "create" });

  // 4. policy
  for (const [flag, ids] of byFlag) await dockerIn(containerId, ["update", "--restart", flag, ...ids.sort()], { capMs: CALL_CAP_MS });

  // 5. the desired state afterwards
  const inner = await insideInspect(containerId);
  await checkLiveness(containerId, liveness); // if the copy restarted during the start-up, its inside is the crash — no desired state from that
  const fresh = withServicesOfNow(pid, instance, desiredAfterRestore(desired, inner, { notArrived: findings.flatMap((b) => [b.id, b.name]) }));
  setInstanceState(pid, instance, "create", { desired: fresh });
  const container = (fresh?.container || []).map((c) => ({ name: c.name, kind: "container", state: c.failed ? "failed" : c.state, port: null }));
  return {
    desired: fresh, findings, notices,
    policy: Object.fromEntries([...byFlag].map(([f, ids]) => [f, [...ids].sort()])),
    services: [...container, ...nativeInResult(services, notices)],
  };
}
