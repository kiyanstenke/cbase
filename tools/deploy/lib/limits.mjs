// The limits of the user containers against their STORED value. An admin sets EACH user individually; the truth lives in
// gateway.db, and the gateway writes its imprint `GW_DATA/resources-desired.json` (`{ <userId>: { memory, nanoCpus, cpuShares } }`,
// in the language of `docker inspect`, server/gateway/resources.js desiredFileContent) on every start and change. Each
// container (label `cbase.user`) is compared with ITS entry. If the file is missing (a gateway from before the administration
// feature), the unit (`GW_CONTAINER_MEM`/`_CPUS`/`_CPU_SHARES`) applies for all containers equally — named as such.
//
// limitsCommand(root)             a read-only ssh command: `nproc`, the environment line of the unit, then after DESIRED_MARKER the
//   file from GW_DATA (without GW_DATA `<root>/gateway/data`, the gateway's default) or "MISSING".
// desiredFrom(stdout)             { threads, unit: { mem, cpus, cpuShares } | null, file } — `null` without readable threads;
//   `file.state` is "present" (with `perUser`), "missing" or "unreadable". Unknown is not equality.
// limitsRow(hostConfig, desired, userId)  the status row: ok on equality, warn on deviation or without comparison.
//   "No hard limit" is met with NanoCpus 0 OR with as many CPUs as the host has threads — `docker update --cpus 0` does not
//   lift a limit (Docker 28: 0 means "not given"), `--cpus <threads>` is the way. A weight 0 (never set) is "normal": both sit
//   at the kernel default cpu.weight 100.
// Guard: tools/deploy/limits.ops.test.mjs (including the wiring in targets/status.mjs).
//
// Also the limits when a B is SWAPPED (deploy and rollback). lib/remote.mjs used to reconstruct them from the `docker inspect`
// the deploy read MINUTES before the swap: an admin who saved in that time saw the value silently reset to the old one, and
// "no hard limit" stood after every save as `--cpus <threads of back then>` in the container — the swap carried it on as a hard
// limit even if the host has more threads now. Therefore:
// swapLimits(hostConfig, desired, userId)  the limits of a B that the swap creates NEW — with an entry in resources-desired.json
//   (read IMMEDIATELY before its swap) from the SAME calculation as the gateway's creation (server/gateway/resources.js
//   valuesFromDesired + argsForCreation; without a hard limit no `--cpus`); without an entry as before from inspect, with a reason —
//   and without `--cpus` if NanoCpus ≥ threads of the host (that is "no limit", not a hard one of today). `{ source, args, values|reason }`.
// limitsFromInspect(hc, threads)  the limits from the HostConfig of the old B (containerSpec takes them without `threads`).
// specWithLimits(spec, args)      the spec (containerSpec, possibly without login variable) with these limits instead of the old ones.
// afterSwapRuling({ desired, userId, hostConfig, memCurrent })  after the swap: does the new B carry the stored value
//   (resources.js deviating — the same calculation as the administration's "deviates" marker)? Otherwise `docker update` by id with
//   the arguments of saving in the gateway (argsForUpdate); lowering only if memory.current + RAM_BUFFER_BYTES stays below
//   (ramUnderConsumption), otherwise warn. The ssh side (one ssh before the swap, the check after) is in lib/limits-swap.mjs.
import { CPU_PRIO_SHARES } from "../../../server/gateway/administration-contract.js";
import { deviating, argsForCreation, argsForUpdate, ramUnderConsumption, lowersRam, valuesFromDesired } from "../../../server/gateway/resources.js";

export const LIMITS_ROW = "Limits";
export const DESIRED_MARKER = "--- resources-desired.json";
const DESIRED_MISSING = "MISSING";

export function limitsCommand(root) {
  return "nproc; E=$(XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user show -p Environment --value cbase-gateway.service); "
    + "printf '%s\\n' \"$E\"; D=$(printf '%s\\n' $E | sed -n 's/^GW_DATA=//p' | tail -n 1); "
    + `echo '${DESIRED_MARKER}'; F="\${D:-${root}/gateway/data}/resources-desired.json"; `
    + `if [ -f "$F" ]; then cat "$F"; else echo ${DESIRED_MISSING}; fi`;
}

const UNIT = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

/** Docker size ("12g", "8589934592", "512m") in bytes like docker units.RAMInBytes; `null` if it is none. */
export function bytesFrom(text) {
  const m = /^(\d+(?:\.\d+)?)\s?([kmgtp])?i?b?$/i.exec(String(text || "").trim());
  return m ? Math.round(Number(m[1]) * UNIT[(m[2] || "").toLowerCase()]) : null;
}

function unitFrom(env) {
  // The last assignment wins (a drop-in overrides the unit); if absent, the value is empty as in the gateway.
  const value = (k) => [...env.matchAll(new RegExp(`(?:^|\\s)${k}=(\\S*)`, "g"))].pop()?.[1] ?? "";
  const s = value("GW_CONTAINER_CPU_SHARES");
  // The same check as in the gateway: a weight outside 2…262144 is dropped there, so it counts as "none".
  const cpuShares = /^\d+$/.test(s) && Number(s) >= 2 && Number(s) <= 262144 ? Number(s) : 0;
  return { mem: value("GW_CONTAINER_MEM"), cpus: value("GW_CONTAINER_CPUS"), cpuShares };
}

const notNegative = (x) => Number.isInteger(x) && x >= 0;
function fileFrom(rest) {
  if (rest === null) return { state: "unreadable" }; // the marker never arrived: the output broke off earlier
  const text = rest.trim();
  if (text === DESIRED_MISSING) return { state: "missing" };
  let d;
  try { d = JSON.parse(text); } catch { return { state: "unreadable" }; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return { state: "unreadable" };
  for (const e of Object.values(d)) {
    if (!e || !notNegative(e.memory) || !notNegative(e.nanoCpus) || !notNegative(e.cpuShares)) return { state: "unreadable" };
  }
  return { state: "present", perUser: d };
}

export function desiredFrom(stdout) {
  const text = String(stdout || "");
  const i = text.indexOf(`${DESIRED_MARKER}\n`);
  const header = (i >= 0 ? text.slice(0, i) : text).split("\n").map((z) => z.trim()).filter(Boolean);
  const threads = Number(header[0]);
  if (!Number.isInteger(threads) || threads <= 0) return null;
  return {
    threads,
    unit: header.length >= 2 ? unitFrom(header.slice(1).join(" ")) : null,
    file: fileFrom(i >= 0 ? text.slice(i + DESIRED_MARKER.length + 1) : null),
  };
}

const gib = (b) => `${Math.round((b / 1024 ** 3) * 10) / 10} GiB`;
// The hard CPU limit in its effect: 0 if none (also ≥ threads).
const cpuEffective = (nano, threads) => (nano > 0 && nano < threads * 1e9 ? nano : 0);
const weightEffective = (s) => (s > 0 ? s : CPU_PRIO_SHARES.normal);
const weightText = (s) => (s ? String(s) : "default");

/** The deviations of a container from `desired` (`{ memory, nanoCpus, cpuShares }`, language of inspect) as sentences. */
function deviations(hc, desired, threads) {
  const ab = [];
  if ((hc.Memory || 0) !== desired.memory) ab.push(`memory ${hc.Memory ? gib(hc.Memory) : "none"} instead of ${desired.memory ? gib(desired.memory) : "none"}`);
  const actual = cpuEffective(hc.NanoCpus || 0, threads);
  const desiredCpu = cpuEffective(desired.nanoCpus, threads);
  if (actual !== desiredCpu) {
    ab.push(desiredCpu ? `CPU ${actual / 1e9 || "none"} instead of hard ${desiredCpu / 1e9}` : `CPU hard ${actual / 1e9} instead of none (docker update --cpus ${threads})`);
  }
  if (weightEffective(hc.CpuShares || 0) !== weightEffective(desired.cpuShares)) {
    ab.push(`weight ${weightText(hc.CpuShares)} instead of ${weightText(desired.cpuShares)}`);
  }
  return ab;
}

export function limitsRow(hostConfig, desired, userId) {
  const hc = hostConfig || null;
  if (!hc) return [LIMITS_ROW, "not measured (no inspect)", "warn"];
  const cpus = (hc.NanoCpus || 0) / 1e9;
  const actual = [
    hc.Memory ? gib(hc.Memory) : "memory without limit",
    !cpus ? "CPU without hard limit" : desired && cpus >= desired.threads ? `CPU ${cpus} of ${desired.threads} (no limit)` : `CPU hard ${cpus}`,
    hc.CpuShares ? `weight ${hc.CpuShares}` : "weight default",
  ].join(" · ");
  if (!desired) return [LIMITS_ROW, `${actual} — host unreadable, not compared`, "warn"];

  if (desired.file.state === "present") {
    if (!userId) return [LIMITS_ROW, `${actual} — container without label cbase.user, not compared`, "warn"];
    const e = desired.file.perUser[userId];
    if (!e) return [LIMITS_ROW, `${actual} — no stored value for ${userId} in resources-desired.json, not compared`, "warn"];
    const ab = deviations(hc, e, desired.threads);
    return ab.length
      ? [LIMITS_ROW, `${actual} — DEVIATES from the stored value: ${ab.join(", ")} (Settings → Administration: saving applies it)`, "warn"]
      : [LIMITS_ROW, `${actual} — == stored`, "ok"];
  }
  if (desired.file.state === "unreadable") return [LIMITS_ROW, `${actual} — resources-desired.json unreadable, not compared`, "warn"];

  // The file is missing (a gateway from before the administration feature): against the unit — and named so.
  if (!desired.unit) return [LIMITS_ROW, `${actual} — resources-desired.json missing and the unit unreadable, not compared`, "warn"];
  const memDesired = desired.unit.mem ? bytesFrom(desired.unit.mem) : 0;
  if (memDesired === null) return [LIMITS_ROW, `${actual} — GW_CONTAINER_MEM "${desired.unit.mem}" unreadable (resources-desired.json missing)`, "warn"];
  const cpusDesired = Number(desired.unit.cpus);
  const ab = deviations(hc, { memory: memDesired, nanoCpus: cpusDesired > 0 ? Math.round(cpusDesired * 1e9) : 0, cpuShares: desired.unit.cpuShares }, desired.threads);
  return ab.length
    ? [LIMITS_ROW, `${actual} — DEVIATES from the unit (resources-desired.json missing): ${ab.join(", ")} (existing containers only via \`docker update\`)`, "warn"]
    : [LIMITS_ROW, `${actual} — == unit (resources-desired.json missing)`, "ok"];
}

// ── The limits when a B is swapped (see the header above) ───────────────────────────────────────────────────────────────

/** The user of a B (label `cbase.user`) or null. */
export const userOf = (insp) => insp?.Config?.Labels?.["cbase.user"] ?? null;

/**
 * The limits from the HostConfig of a B, as docker carried them: `--memory`, `--cpus`, `--cpu-shares` (0 = never set, dropped).
 * With `threads` (nproc of the host) a hard limit ≥ threads is "no limit" and dropped — that is how "no upper limit" stands
 * after a save (`docker update --cpus <threads of back then>`), and a swap would otherwise carry it on as a hard limit.
 */
export function limitsFromInspect(hostConfig, threads = null) {
  const hc = hostConfig || {};
  const args = [];
  if (hc.Memory) args.push("--memory", String(hc.Memory));
  if (hc.NanoCpus && !(threads > 0 && hc.NanoCpus >= threads * 1e9)) args.push("--cpus", String(hc.NanoCpus / 1e9));
  if (hc.CpuShares) args.push("--cpu-shares", String(hc.CpuShares));
  return args;
}

// The stored value of a user from the read desired file: `{ values }` or `{ reason }` why there is none.
function entryFor(desired, userId) {
  if (!desired) return { reason: "host unreadable (nproc)" };
  if (desired.file.state === "missing") return { reason: "resources-desired.json missing (a gateway from before the administration feature)" };
  if (desired.file.state !== "present") return { reason: "resources-desired.json unreadable" };
  if (!userId) return { reason: "container without label cbase.user" };
  const e = desired.file.perUser[userId];
  if (!e) return { reason: `no stored value for ${userId} in resources-desired.json` };
  const values = valuesFromDesired(e);
  return values ? { values } : { reason: `the entry for ${userId} is not one the gateway writes (${JSON.stringify(e)})` };
}

/** The administration values as short text ("4 GiB · priority high · no hard limit"). */
export const valuesText = (w) => `${w.ramGiB} GiB · priority ${w.cpuPrio} · ${w.cpuMax === null ? "no hard limit" : `hard ${w.cpuMax} CPU`}`;

/**
 * The limits with which the swap creates a B NEW (`desired` = desiredFrom, read immediately before this swap): with an entry
 * `{ source: "desired", values, args }` — args from argsForCreation, like a creation in the gateway —, otherwise `{ source: "inspect",
 * reason, args }` from the HostConfig of the old B (limitsFromInspect with the threads, if known).
 */
export function swapLimits(hostConfig, desired, userId) {
  const e = entryFor(desired, userId);
  if (e.values) return { source: "desired", values: e.values, args: argsForCreation(e.values, desired.threads) };
  return { source: "inspect", reason: e.reason, args: limitsFromInspect(hostConfig, desired?.threads ?? null) };
}

// The words of a spec (lib/remote.mjs containerSpec): switches without value, switches with value, and the limits among them.
const LIMIT_TOGGLE = new Set(["--memory", "--memory-swap", "--cpus", "--cpu-shares"]);
const WITHOUT_VALUE = new Set(["-d", "--init"]);
const WITH_VALUE = new Set(["--stop-timeout", "--name", "--label", "-e", "--env", "-p", "-v", "--runtime", "--restart", "--network", ...LIMIT_TOGGLE]);

/**
 * The spec with `args` as limits: every old limit (`--memory`, `--memory-swap`, `--cpus`, `--cpu-shares` with value) is dropped, the
 * new ones sit at the place of the first old one (without old ones before `--restart`/`--network`, otherwise at the end). It is read
 * word by word — a value that looks like a switch (`-e --cpus`) stays a value. An unknown word is a throw: then the reconstruction
 * no longer matches this list, and a limit could silently appear twice.
 */
export function specWithLimits(spec, args) {
  if (!Array.isArray(spec) || !Array.isArray(args)) throw new TypeError("specWithLimits: spec and args must be arrays");
  const out = [];
  let place = -1;
  let beforeEnd = -1;
  for (let i = 0; i < spec.length; i++) {
    const a = spec[i];
    if (WITHOUT_VALUE.has(a)) { out.push(a); continue; }
    if (!WITH_VALUE.has(a) || i + 1 >= spec.length) throw new TypeError(`specWithLimits: unexpected word in the spec: ${a}`);
    if (LIMIT_TOGGLE.has(a)) {
      if (place < 0) place = out.length;
    } else {
      if (beforeEnd < 0 && (a === "--restart" || a === "--network")) beforeEnd = out.length;
      out.push(a, spec[i + 1]);
    }
    i++;
  }
  const at = place >= 0 ? place : beforeEnd >= 0 ? beforeEnd : out.length;
  out.splice(at, 0, ...args.map(String));
  return out;
}

/**
 * After the swap: does the new B (`hostConfig`, fresh) carry the stored value (`desired`, read AFTER the `docker run`)?
 * `memCurrent`: undefined = not yet measured, null = not measurable, otherwise bytes (memory.current of the new B).
 *   { action: "unchecked", reason }     no stored value (or the new B unreadable) — nothing to compare
 *   { action: "equal", values }         == stored
 *   { action: "measure", values }       deviates and lowers the RAM — read memory.current first, then ask again
 *   { action: "warn", values, reason }  lowering below memory.current + buffer (or without measurement) — not touched
 *   { action: "update", values, args }  `docker update <args> <Id>` (argsForUpdate: "no limit" = `--cpus <threads>`)
 */
export function afterSwapRuling({ desired, userId, hostConfig, memCurrent }) {
  const e = entryFor(desired, userId);
  if (!e.values) return { action: "unchecked", reason: e.reason };
  if (!hostConfig) return { action: "unchecked", reason: "the new container is unreadable (docker inspect)" };
  const { values } = e;
  if (!deviating(values, hostConfig, desired.threads)) return { action: "equal", values };
  if (lowersRam(values, hostConfig)) {
    if (memCurrent === undefined) return { action: "measure", values };
    const reason = ramUnderConsumption(values, memCurrent);
    if (reason) return { action: "warn", values, reason };
  }
  return { action: "update", values, args: argsForUpdate(values, desired.threads) };
}
