// The resources per user container as a computation. Admins set them for all users: three controls — RAM in whole GiB, CPU
// priority in three levels, CPU upper limit (none · 1…threads). This file holds everything that can be computed without docker,
// database or HTTP, so it can be tested without a server (guard resources.test.js). The knowledge about levels, shares and limits
// comes FROM the contract (administration-contract.js); a number like 1287 appears nowhere here, otherwise there would be two
// places where it ages.
//
// Three facts you cannot see from the functions (measured on the server, Docker 28, sysbox-runc):
// - "No CPU upper limit" is `--cpus <host threads>` for `docker update` — `--cpus 0` does NOT lift a limit (0 means "unspecified"
//   there, exit 0 without effect). A fresh creation without a limit does not set `--cpus` at all.
// - A weight of 0 (never set) and "normal" are the SAME state: both give cpu.weight 100, the kernel default. Still,
//   `CPU_PRIO_SHARES.normal` is set explicitly, because `docker update --cpu-shares 0` resets nothing — so comparison uses
//   `sharesEffective`, otherwise every container never touched would count as "deviating".
// - Swap follows RAM: `--memory-swap` = 2 × RAM, like Docker's default at creation and after every deploy swap
//   (the deploy tool's remote.mjs containerSpecFrom does not carry MemorySwap on, `docker run --memory X` sets 2X). An update
//   must carry it along: if the new RAM limit is above the old swap value, docker rejects the update.
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_DELETE_FIELDS, CREATE_FIELDS, CPU_PRIO, CPU_PRIO_SHARES, HOST_RESERVE_GIB, PASSWORD_FIELDS, PATCH_FIELDS, RAM_MIN_GIB, RAM_BUFFER_BYTES,
  RESOURCES_FIELDS, ROLES,
} from "./administration-contract.js";

export const GIB = 1024 ** 3;
/** The file the operator's status check compares every container against (the deploy tool's limits.mjs) — in the gateway data folder. */
export const DESIRED_FILE = "resources-desired.json";

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), Math.max(lo, hi));
const isInteger = (x) => typeof x === "number" && Number.isInteger(x);

/** The highest RAM value in whole GiB: what the host has (MemTotal), rounded down. */
export const ramMaxGiB = (ramTotalBytes) => Math.floor(Number(ramTotalBytes) / GIB);

/** The hard CPU limit as it takes effect: `null` if none — a value ≥ threads limits nothing either. */
export function cpuLimitEffective(cpuMax, threads) {
  return cpuMax === null || cpuMax === undefined || cpuMax >= threads ? null : cpuMax;
}

/** A weight as it takes effect: 0 (never set) sits at the kernel default and is thus "normal" (header, second fact). */
export const sharesEffective = (shares) => (Number(shares) > 0 ? Number(shares) : CPU_PRIO_SHARES.normal);

function checkValues(values) {
  if (!values || !isInteger(values.ramGiB) || values.ramGiB < 1 || !CPU_PRIO.includes(values.cpuPrio)
    || !(values.cpuMax === null || (isInteger(values.cpuMax) && values.cpuMax >= 1))) {
    throw new Error(`Invalid resources: ${JSON.stringify(values)}`);
  }
}

function ramArgs(values) {
  const ram = values.ramGiB * GIB;
  return ["--memory", String(ram), "--memory-swap", String(2 * ram), "--cpu-shares", String(CPU_PRIO_SHARES[values.cpuPrio])];
}

/** `docker run` arguments of a fresh creation. Without an effective limit no `--cpus` (header, first fact). */
export function argsForCreation(values, threads) {
  checkValues(values);
  const max = cpuLimitEffective(values.cpuMax, threads);
  return [...ramArgs(values), ...(max === null ? [] : ["--cpus", String(max)])];
}

/** `docker update` arguments (without the id). "No limit" is `--cpus <threads>` — `--cpus 0` does not lift it. */
export function argsForUpdate(values, threads) {
  checkValues(values);
  return [...ramArgs(values), "--cpus", String(cpuLimitEffective(values.cpuMax, threads) ?? threads)];
}

/** The level for a weight: the nearest of the three; 0 (never set) is "normal". */
export function priorityFromShares(shares) {
  const s = Number(shares) || 0;
  if (s <= 0) return "normal";
  let best = CPU_PRIO[0];
  for (const p of CPU_PRIO) if (Math.abs(CPU_PRIO_SHARES[p] - s) < Math.abs(CPU_PRIO_SHARES[best] - s)) best = p;
  return best;
}

/**
 * What a container carries NOW, as administration values — for the initial fill (rolling out changes no container). Memory →
 * whole GiB (without a limit: the whole machine, rounded down), NanoCpus ≥ threads or 0 ⇒ no limit, CpuShares → nearest level.
 * Every value is clamped into the range a PUT would accept too — otherwise the table would hold a row the UI could not write back.
 */
export function valuesFromInspect(hostConfig, { threads, ramTotalBytes }) {
  const hc = hostConfig || {};
  const max = ramMaxGiB(ramTotalBytes);
  const mem = Number(hc.Memory) || 0;
  const cpus = (Number(hc.NanoCpus) || 0) / 1e9;
  return {
    ramGiB: mem > 0 ? clamp(Math.round(mem / GIB), RAM_MIN_GIB, max) : Math.max(RAM_MIN_GIB, max),
    cpuPrio: priorityFromShares(hc.CpuShares),
    cpuMax: cpus > 0 && cpus < threads ? clamp(Math.round(cpus), 1, threads) : null,
  };
}

const UNIT = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
/** Docker size ("12g", "512m", "8589934592") in bytes like docker units.RAMInBytes; empty ⇒ 0, unreadable ⇒ null. */
export function bytesFromDocker(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s?([kmgt])?i?b?$/i.exec(s);
  return m ? Math.round(Number(m[1]) * UNIT[(m[2] || "").toLowerCase()]) : null;
}

/**
 * The template for a new user (and for one without a container at the initial fill) from the unit env
 * (`GW_CONTAINER_MEM`/`_CPUS`/`_CPU_SHARES`): what a container would carry that the gateway had created from it — the same
 * reverse mapping as `valuesFromInspect`. A weight outside 2…262144 was dropped in containers.js limitsArgs, so it is "normal";
 * an unreadable memory value means a failed `docker run` there, "no limit" here.
 */
export function templateFromEnvironment({ mem = "", cpus = "", cpuShares = "" } = {}, spec) {
  const s = String(cpuShares ?? "");
  const shares = /^\d+$/.test(s) && Number(s) >= 2 && Number(s) <= 262144 ? Number(s) : 0;
  const n = Number(cpus);
  return valuesFromInspect({ Memory: bytesFromDocker(mem) ?? 0, NanoCpus: Number.isFinite(n) && n > 0 ? n * 1e9 : 0, CpuShares: shares }, spec);
}

/**
 * Does the container deviate from its stored value? The HostConfig is compared (not the cgroup): RAM byte-exact, the hard CPU
 * limit in its effect (0 and ≥ threads are "none"), the weight in its effect (0 ≡ normal). Not swap — it follows RAM and docker
 * recomputes it at every deploy swap. Without a value or without a container: nothing deviates.
 */
export function deviating(desired, hostConfig, threads) {
  if (!desired || !hostConfig) return false;
  if ((Number(hostConfig.Memory) || 0) !== desired.ramGiB * GIB) return true;
  const nano = Number(hostConfig.NanoCpus) || 0;
  const isMax = nano > 0 && nano < threads * 1e9 ? nano : 0;
  const desiredMax = cpuLimitEffective(desired.cpuMax, threads);
  if (isMax !== (desiredMax === null ? 0 : desiredMax * 1e9)) return true;
  return sharesEffective(hostConfig.CpuShares) !== CPU_PRIO_SHARES[desired.cpuPrio];
}

/** Does this value lower the container's RAM limit? A limit where there was "none" (Memory 0) always lowers. */
export function lowersRam(values, hostConfig) {
  const now = Number(hostConfig?.Memory) || 0;
  return now === 0 || values.ramGiB * GIB < now;
}

const gibText = (b) => `${(b / GIB).toFixed(1).replace(".", ",")} GiB`;

/**
 * The reason for a 409 when lowering: new value < working set + RAM_BUFFER_BYTES — otherwise the kernel immediately kills the
 * largest process in the container. A consumption that is not measured (`null`) is not "little": lowering happens only against a
 * measurement. `null` = allowed.
 */
export function ramUnderConsumption(values, consumptionBytes) {
  if (consumptionBytes === null || consumptionBytes === undefined || !Number.isFinite(consumptionBytes)) {
    return "The container's consumption cannot be measured right now — a limit is only lowered against a measurement. Raising always works.";
  }
  const atLeast = consumptionBytes + RAM_BUFFER_BYTES;
  if (values.ramGiB * GIB >= atLeast) return null;
  return `The container currently occupies ${gibText(consumptionBytes)}; a new limit must leave at least `
    + `${gibText(RAM_BUFFER_BYTES)} of headroom above that (so ≥ ${Math.ceil(atLeast / GIB)} GiB) — otherwise the kernel immediately kills the largest process.`;
}

// ── Bodies against the contract ──────────────────────────────────────────────────────────────────────────────────────────────
// A missing key is not a statement: it is a 400, never "unchanged" or "default". A foreign key likewise — a FOREIGN field once
// silently switched another setting. `null` is a statement (cpuMax: "no limit"). Result `{ values }` or `{ error }`.
function exactlyTheKey(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object";
  const missing = fields.filter((f) => !Object.hasOwn(body, f));
  if (missing.length) return `Required field missing: ${missing.join(", ")}`;
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length) return `unknown field: ${unknown.join(", ")}`;
  return null;
}

/** PUT …/resources — all RESOURCES_FIELDS; ranges from the host (`threads`, `ramTotalBytes`). */
export function checkResources(body, { threads, ramTotalBytes }) {
  const f = exactlyTheKey(body, RESOURCES_FIELDS);
  if (f) return { error: f };
  const { ramGiB, cpuPrio, cpuMax } = body;
  const max = ramMaxGiB(ramTotalBytes);
  if (!isInteger(ramGiB) || ramGiB < RAM_MIN_GIB || ramGiB > max) {
    return { error: `ramGiB: whole number from ${RAM_MIN_GIB} to ${max} (the host's RAM)` };
  }
  if (!CPU_PRIO.includes(cpuPrio)) return { error: `cpuPrio: one of ${CPU_PRIO.join(", ")}` };
  if (!(cpuMax === null || (isInteger(cpuMax) && cpuMax >= 1 && cpuMax <= threads))) {
    return { error: `cpuMax: null (no limit) or a whole number from 1 to ${threads} (the host's threads)` };
  }
  return { values: { ramGiB, cpuPrio, cpuMax } };
}

/** PATCH /gw/admin/users/:id — EXACTLY one of PATCH_FIELDS; two, none or a foreign one ⇒ error. */
export function checkPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be a JSON object" };
  const keys = Object.keys(body);
  if (keys.length !== 1 || !PATCH_FIELDS.includes(keys[0])) {
    return { error: `exactly one of the fields ${PATCH_FIELDS.join(", ")} — received: ${keys.join(", ") || "none"}` };
  }
  if (keys[0] === "role" && !ROLES.includes(body.role)) return { error: `role: one of ${ROLES.join(", ")}` };
  if (keys[0] === "locked" && typeof body.locked !== "boolean") return { error: "locked: true or false" };
  return { values: { [keys[0]]: body[keys[0]] } };
}

/** POST /gw/admin/users — name, password, role (the role is required: "user" as a silent default would be a statement nobody made). */
export function checkCreate(body) {
  const f = exactlyTheKey(body, CREATE_FIELDS);
  if (f) return { error: f };
  if (typeof body.username !== "string" || typeof body.password !== "string") return { error: "username and password: text" };
  if (!ROLES.includes(body.role)) return { error: `role: one of ${ROLES.join(", ")}` };
  return { values: { username: body.username, password: body.password, role: body.role } };
}

/** POST /gw/admin/users/:id/password */
export function checkPassword(body) {
  const f = exactlyTheKey(body, PASSWORD_FIELDS);
  if (f) return { error: f };
  if (typeof body.password !== "string") return { error: "password: text" };
  return { values: { password: body.password } };
}

/** POST /gw/account/delete — exactly the current password. */
export function checkAccountDelete(body) {
  const f = exactlyTheKey(body, ACCOUNT_DELETE_FIELDS);
  if (f) return { error: f };
  if (typeof body.password !== "string" || !body.password) return { error: "password: text" };
  return { values: { password: body.password } };
}

/**
 * Is this user the last ACTIVE admin? A locked admin does not count — they cannot log in; demoting the last active one would lock
 * everyone out of the administration.
 */
export function lastAdmin(list, userId) {
  const active = list.filter((u) => u.role === "admin" && !u.locked);
  return active.length === 1 && active[0].id === userId;
}

// ── Responses in the contract's shape ───────────────────────────────────────────────────────────────────────────────────────
const TIME_NULL = /^0001-01-01/;

/** `container` from `docker inspect` (or `null` = there is none): state and since when. */
export function stateFrom(info) {
  if (!info) return { state: "missing", since: null };
  const st = info.State || {};
  const running = !!st.Running;
  const t = running ? st.StartedAt : st.FinishedAt;
  return { state: running ? "running" : "stopped", since: typeof t === "string" && t && !TIME_NULL.test(t) ? t : null };
}

/**
 * `actual`: what the container carries. `ramBytes: null` and `cpuMax: null` mean "no limit" here (inspect was read — if it
 * is not readable, there is no answer at all); `cpuWeight` is cpu.weight from the cgroup, `null` = not read (stopped, not Linux,
 * cgroup v1). It shows whether the runtime converts the shares the way `CPU_PRIO_WEIGHT` expects.
 */
export function actualOf(hostConfig, threads, cpuWeight) {
  const hc = hostConfig || {};
  const mem = Number(hc.Memory) || 0;
  const cpus = (Number(hc.NanoCpus) || 0) / 1e9;
  return {
    ramBytes: mem > 0 ? mem : null,
    cpuMax: cpus > 0 && cpus < threads ? cpus : null,
    cpuWeight: isInteger(cpuWeight) ? cpuWeight : null,
  };
}

const resourcesView = (w) => (w ? { ramGiB: w.ramGiB, cpuPrio: w.cpuPrio, cpuMax: w.cpuMax } : null);

/**
 * The three fields administration and /gw/env share. `situation`: `{ state, since, hostConfig, cpuWeight }` (containers.js
 * situation) or `null` (docker did not answer — then nothing is known); `consumption`: this container's entry from the meter
 * (`{ ramBytes, cpuThreads }`) or `null` (not measured).
 */
export function resourcesFields({ values, situation, consumption, threads }) {
  const withContainer = !!situation && situation.state !== "missing";
  return {
    resources: resourcesView(values),
    actual: withContainer ? actualOf(situation.hostConfig, threads, situation.cpuWeight) : null,
    consumption: situation?.state === "running"
      ? { ramBytes: consumption?.ramBytes ?? null, cpuThreads: consumption?.cpuThreads ?? null }
      : null,
  };
}

/** One user of the administration, exactly with USER_FIELDS. */
export function userView({ user, selfId, values, situation, consumption, threads }) {
  const r = resourcesFields({ values, situation, consumption, threads });
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    locked: !!user.locked,
    createdAt: user.createdAt ?? null,
    itself: user.id === selfId,
    container: { state: situation.state, since: situation.since ?? null },
    resources: r.resources,
    actual: r.actual,
    consumption: r.consumption,
    deviating: situation.state !== "missing" && deviating(values, situation.hostConfig, threads),
  };
}

/**
 * The server in the administration: allocated is the sum of the RAM limits of ALL users (stopped and locked ones too — anyone can
 * start their container at any time, their first request suffices). Overcommit is allowed (limits are upper bounds);
 * `overcommitted` warns as soon as the sum exceeds what remains after the host's reserve (GitLab, itself).
 */
export function serverView({ threads, ramTotalBytes }, valuesList) {
  const allocated = valuesList.reduce((s, w) => s + w.ramGiB * GIB, 0);
  const reserve = HOST_RESERVE_GIB * GIB;
  return { threads, ramTotalBytes, ramAllocatedBytes: allocated, reserveBytes: reserve, overcommitted: allocated > ramTotalBytes - reserve };
}

/**
 * `resources-desired.json`: `{ <userId>: { memory, nanoCpus, cpuShares } }` in the language of `docker inspect` — so
 * the deploy tool's limits.mjs compares without conversion. `nanoCpus: 0` means "no limit" (also a value ≥ threads).
 */
export function desiredFileContent(list, threads) {
  const out = {};
  for (const r of list) {
    const max = cpuLimitEffective(r.cpuMax, threads);
    out[r.userId] = { memory: r.ramGiB * GIB, nanoCpus: max === null ? 0 : max * 1e9, cpuShares: CPU_PRIO_SHARES[r.cpuPrio] };
  }
  return out;
}

/**
 * The inverse of `desiredFileContent`: an entry `{ memory, nanoCpus, cpuShares }` → `{ ramGiB, cpuPrio, cpuMax }` — or `null` if
 * the gateway cannot have written it that way (RAM not a whole number of GiB ≥ 1, a weight that is none of the three levels, a
 * limit that is not a whole number of CPUs). For the deploy swap (the deploy tool's limits.mjs), so it creates a new B with the
 * SAME computation as the gateway (argsForCreation) and then aligns it with the same arguments as a save (argsForUpdate). No
 * "nearest level": what does not match exactly is not a stored statement. `nanoCpus: 0` is "no limit" (cpuMax null —
 * desiredFileContent also writes a cpuMax ≥ threads that way).
 */
export function valuesFromDesired(entry) {
  if (!entry || typeof entry !== "object") return null;
  const ramGiB = Number(entry.memory) / GIB;
  const cpuPrio = CPU_PRIO.find((p) => CPU_PRIO_SHARES[p] === entry.cpuShares) ?? null;
  const nano = Number(entry.nanoCpus);
  const cpuMax = nano === 0 ? null : nano / 1e9;
  if (!isInteger(ramGiB) || ramGiB < RAM_MIN_GIB || !cpuPrio || !(cpuMax === null || (isInteger(cpuMax) && cpuMax >= 1))) return null;
  return { ramGiB, cpuPrio, cpuMax };
}

/**
 * Write atomically: first a neighbouring file, then `rename` — a the operator's status check reading mid-write sees the old or the new
 * state, never half of one (which would be "unreadable" and mean "not compared" there).
 */
export function writeDesiredFile(dir, list, threads) {
  const target = path.join(dir, DESIRED_FILE);
  const fresh = path.join(dir, `.${DESIRED_FILE}.${process.pid}.new`);
  fs.writeFileSync(fresh, `${JSON.stringify(desiredFileContent(list, threads), null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(fresh, target);
  return target;
}
