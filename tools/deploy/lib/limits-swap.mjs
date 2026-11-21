// The limits of a B at swap time — the ssh side. The calculation is purely in lib/limits.mjs (header there), guard
// tools/deploy/limits.ops.test.mjs (6)–(9).
//
// The motive: the spec of a B is built from the `docker inspect` that the deploy reads before the gate and before the
// confirmation — minutes before the swap. If an admin saved new limits in that time, the gateway applied them to the OLD
// container, and the swap created the new one with the old ones: the value silently stood on the old one again, the
// administration showed "deviates".
//
// limitsBeforeSwap(insp, seam)    ONE ssh immediately before the swap of this B: resources-desired.json together with nproc
//   (limitsCommand) → swapLimits. Without a stored value the limits from inspect as before — explicitly as a warning.
// limitsAfterSwap(name, seam)     after the `docker run`: the desired file again (a save during the swap wrote it before its
//   `docker update`, and that update still hit the old B), the new B fresh from inspect; if it deviates, `docker update` BY ID
//   with argsForUpdate. Lowering only against memory.current of the new B (cgroup on the host, path from
//   server/gateway/cbase-share.js cgroupDirectory), otherwise a warning. Never throws — one row `[Limits, text, ok|warn]`.
//
// `seam` (for the guard): `{ probe, act, inspect, root }`, defaults sshProbe, sshAct, inspectContainer, config.remote.root.
import { config } from "../config.mjs";
import { cgroupDirectory } from "../../../server/gateway/cbase-share.js";
import { LIMITS_ROW, limitsCommand, afterSwapRuling, userOf, desiredFrom, swapLimits, valuesText } from "./limits.mjs";
import { inspectContainer } from "./remote.mjs";
import { sshAct, sshProbe } from "./ssh.mjs";
import * as log from "../../check/lib/log.mjs";

const preset = (seam) => ({ probe: sshProbe, act: sshAct, inspect: inspectContainer, root: config.remote.root, ...seam });
const ID = /^[0-9a-f]{64}$/;

export async function limitsBeforeSwap(insp, seam = {}) {
  const { probe, root } = preset(seam);
  const name = String(insp?.Name || "?").replace(/^\//, "");
  let stdout = "";
  try { stdout = (await probe(limitsCommand(root), { check: false }))?.stdout ?? ""; } catch { /* below: host unreadable */ }
  const g = swapLimits(insp?.HostConfig, desiredFrom(stdout), userOf(insp));
  if (g.source === "desired") log.detail(`${name}: limits from resources-desired.json (just read) — ${valuesText(g.values)}: ${g.args.join(" ")}`);
  else log.warn(`${name}: limits as before from docker inspect (read before the gate), because ${g.reason}: ${g.args.join(" ") || "none"}`);
  return g;
}

// memory.current of the B with this id in bytes, or null (no cgroup v2, unknown driver, file unreadable).
async function memoryCurrent(id, probe) {
  const info = await probe("docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}'", { check: false });
  const [driver, version] = String(info?.stdout ?? "").trim().split(/\s+/);
  const dir = cgroupDirectory(id, { driver, version });
  if (!dir) return null;
  const r = await probe(`cat ${dir}/memory.current`, { check: false });
  const s = String(r?.stdout ?? "").trim();
  return r?.code === 0 && /^\d+$/.test(s) ? Number(s) : null;
}

export async function limitsAfterSwap(name, seam = {}) {
  const { probe, act, inspect, root } = preset(seam);
  const row = (text, state) => ({ row: [LIMITS_ROW, text, state] });
  try {
    const desired = desiredFrom((await probe(limitsCommand(root), { check: false }))?.stdout ?? "");
    const insp = await inspect(name);
    const base = { desired, userId: userOf(insp), hostConfig: insp?.HostConfig ?? null };
    let e = afterSwapRuling(base);
    if (e.action === "measure") e = afterSwapRuling({ ...base, memCurrent: ID.test(String(insp?.Id)) ? await memoryCurrent(insp.Id, probe) : null });
    if (e.action === "unchecked") {
      log.warn(`${name}: limits not checked after the swap — ${e.reason}`);
      return { action: e.action, ...row(`not checked — ${e.reason}`, "warn") };
    }
    if (e.action === "equal") return { action: e.action, ...row(`${valuesText(e.values)} — == stored`, "ok") };
    if (e.action === "warn") {
      log.warn(`${name}: deviates from the stored value (${valuesText(e.values)}), NOT lowered — ${e.reason}`);
      return { action: e.action, ...row(`DEVIATES from ${valuesText(e.values)}, not lowered: ${e.reason}`, "warn") };
    }
    // update: by id, never by name (the name may now belong to a replacement by the gateway — whose limits are right).
    if (!ID.test(String(insp?.Id))) {
      log.warn(`${name}: deviates from the stored value, but the id is unreadable (${insp?.Id}) — not aligned`);
      return { action: "warn", ...row(`DEVIATES from ${valuesText(e.values)}, id unreadable — not aligned`, "warn") };
    }
    const r = await act(`docker update ${e.args.join(" ")} ${insp.Id} >/dev/null`, { check: false });
    if (r?.code !== 0 && !r?.skipped) {
      const reason = String(r?.stderr || "").trim().split("\n").at(-1) || `Exit ${r?.code}`;
      log.warn(`${name}: docker update to the stored value failed — ${reason}`);
      return { action: "warn", ...row(`DEVIATES from ${valuesText(e.values)}, docker update failed: ${reason}`, "warn") };
    }
    log.ok(`${name}: limits aligned to the stored value (saved during the swap) — ${valuesText(e.values)}`);
    return { action: "update", ...row(`${valuesText(e.values)} — aligned after the swap (docker update by id)`, "ok") };
  } catch (err) {
    log.warn(`${name}: limits not checked after the swap — ${err?.message || err}`);
    return { action: "unchecked", ...row(`not checked — ${err?.message || err}`, "warn") };
  }
}
