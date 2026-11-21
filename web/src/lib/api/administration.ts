// Administration: users and resources per user container (the lists of the contract
// `server/gateway/administration-contract.js` are the JSON forms). Replaces the old page `/gw/admin`: an
// admin sets RAM, CPU priority and CPU upper limit for EVERY user and manages the accounts; each user reads
// their own limits via `GET /gw/env` (Settings → Environment).
//
// Leaf module (README there): imports only from lib/api/, with the `.js` ending. The contract lies OUTSIDE
// lib/api/ (in the gateway) and must not be imported here — the lists therefore stand a second time here, and
// `web/test/administration-binding.test.mjs` pins them to the contract (every exported list of the contract is
// mirrored here or named there as "gateway only").
//
// Every response goes through a `norm*` function with a default per field. A default never claims anything the
// gateway did not say: a missing role is `null` (not "user"), an unknown state `null` (not "missing"), and
// `resources` without one of the three keys is `null` — a missing `cpuMax` would otherwise mean "no limit". The
// bodies are typed objects without conditional spreads and carry EVERY required key, even as `null`: the gateway
// reads a missing key as 400, and `JSON.stringify` drops `undefined` but keeps `null`.
import { api } from "./core.js";

/** The CPU priority levels, in the order of the UI. */
export const CPU_PRIO = ["low", "normal", "up"] as const;
export type CpuPrio = (typeof CPU_PRIO)[number];
/** The cgroup weight per level as the container carries it (`actual.cpuWeight`) — the page reads from it which level currently applies. */
export const CPU_PRIO_WEIGHT: Readonly<Record<CpuPrio, number>> = { low: 50, normal: 100, up: 200 };
/** RAM in whole GiB, not below. */
export const RAM_MIN_GIB = 2;
/** Headroom above the measured consumption that a new RAM value must leave — otherwise the gateway answers 409. */
export const RAM_BUFFER_BYTES = 512 * 1024 * 1024;
export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const CONTAINER_STATES = ["running", "stopped", "missing"] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];
export const CONTAINER_ACTIONS = ["start", "restart", "stop"] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

/** The required keys of the bodies. */
export const RESOURCES_FIELDS = ["ramGiB", "cpuPrio", "cpuMax"] as const;
/** PATCH carries EXACTLY one of these keys — two or none are 400. */
export const PATCH_FIELDS = ["role", "locked"] as const;
export const CREATE_FIELDS = ["username", "password", "role"] as const;
export const PASSWORD_FIELDS = ["password"] as const;
/** The fields of the responses — `norm*` delivers exactly these, in this order. */
export const ADMINISTRATION_FIELDS = ["server", "user"] as const;
export const SERVER_FIELDS = ["threads", "ramTotalBytes", "ramAllocatedBytes", "reserveBytes", "overcommitted"] as const;
export const USER_FIELDS = [
  "id", "username", "role", "locked", "createdAt", "itself", "container", "resources", "actual", "consumption", "deviating",
] as const;
export const CONTAINER_FIELDS = ["state", "since"] as const;
export const ACTUAL_FIELDS = ["ramBytes", "cpuMax", "cpuWeight"] as const;
export const CONSUMPTION_FIELDS = ["ramBytes", "cpuThreads"] as const;
/** What `GET /gw/env` carries in addition: the own values, read-only. */
export const ENV_ADDITION_FIELDS = ["resources", "actual", "consumption"] as const;

/** Where `GET /gw/admin` redirects: opens Settings → Administration (lib/settings-jump.ts reads the parameter). */
export const ADMINISTRATION_JUMP = "/?settings=administration";
/** The page's key in the settings (SettingsModal `SECTIONS`/`SETTINGS_GROUPS`, iOS SettingsView). */
export const ADMINISTRATION_PAGE = "administration";

/** A user's stored values — also the body of PUT …/resources. `cpuMax: null` = no hard limit. */
export type Resources = { ramGiB: number; cpuPrio: CpuPrio; cpuMax: number | null };
/** What the container currently carries (docker inspect + cgroup); per field `null` = not read or (cpuMax) no limit. */
export type ResourcesActual = { ramBytes: number | null; cpuMax: number | null; cpuWeight: number | null };
/** Working set and CPU threads in the last measuring window; per field `null` = not measured. */
export type Consumption = { ramBytes: number | null; cpuThreads: number | null };
/** `state: null` = the gateway named no known one — never silently "missing". `since`: ISO or null. */
export type ContainerStatus = { state: ContainerState | null; since: string | null };
export type AdministrationServer = {
  threads: number | null;
  ramTotalBytes: number | null;
  /** Sum of all users' RAM limits. */
  ramAllocatedBytes: number | null;
  /** What the host keeps for itself (HOST_RESERVE_GIB in the contract) — the mark in the bar. */
  reserveBytes: number | null;
  /** Sum of the limits > total − reserve: allowed, but warned. */
  overcommitted: boolean;
};
export type AdministrationUser = {
  id: string;
  username: string;
  /** `null` = no known role reported. */
  role: Role | null;
  locked: boolean;
  createdAt: number | null;
  /** The requesting admin themself — locking or deleting oneself is 400. */
  itself: boolean;
  container: ContainerStatus;
  /** `null` = not (completely) delivered; then there is nothing to edit. */
  resources: Resources | null;
  /** `null` without a container. */
  actual: ResourcesActual | null;
  /** `null` without a running container. */
  consumption: Consumption | null;
  /** Does the container carry something other than what is stored? */
  deviating: boolean;
};
export type Administration = { server: AdministrationServer; user: AdministrationUser[] };
/** The own limits from `GET /gw/env` (Settings → Environment). */
export type OwnResources = { resources: Resources | null; actual: ResourcesActual | null; consumption: Consumption | null };

export type ResourcesBody = Resources;
export type RoleBody = { role: Role };
export type LockBody = { locked: boolean };
export type CreateBody = { username: string; password: string; role: Role };
export type PasswordBody = { password: string };

/** `true` if the type `A` carries exactly the keys of the list `L` — otherwise `false`, and the assignment below is a type error. */
type SameKeys<A, L extends readonly string[]> = [Exclude<keyof A, L[number]>, Exclude<L[number], keyof A>] extends [never, never] ? true : false;
/** Binds the types to the lists (exported so that no "unused" check strips them). */
export const ADMINISTRATION_TYPES_BOUND: [
  SameKeys<Administration, typeof ADMINISTRATION_FIELDS>,
  SameKeys<AdministrationServer, typeof SERVER_FIELDS>,
  SameKeys<AdministrationUser, typeof USER_FIELDS>,
  SameKeys<ContainerStatus, typeof CONTAINER_FIELDS>,
  SameKeys<ResourcesActual, typeof ACTUAL_FIELDS>,
  SameKeys<Consumption, typeof CONSUMPTION_FIELDS>,
  SameKeys<OwnResources, typeof ENV_ADDITION_FIELDS>,
  SameKeys<ResourcesBody, typeof RESOURCES_FIELDS>,
  // The intersection type of the two PATCH bodies: `keyof (A & B)` is the UNION of their keys — both together carry PATCH_FIELDS.
  SameKeys<RoleBody & LockBody, typeof PATCH_FIELDS>,
  SameKeys<CreateBody, typeof CREATE_FIELDS>,
  SameKeys<PasswordBody, typeof PASSWORD_FIELDS>,
] = [true, true, true, true, true, true, true, true, true, true, true];

const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const count = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const one = <T extends string>(list: readonly T[], x: unknown): T | null => (list.includes(x as T) ? (x as T) : null);

/** The three stored values — `null` as soon as one is missing or unreadable (`cpuMax` too: missing is not "no limit"). */
export function normResources(raw: unknown): Resources | null {
  const r = obj(raw);
  if (!r || !("cpuMax" in r)) return null;
  const ramGiB = count(r.ramGiB);
  const cpuPrio = one(CPU_PRIO, r.cpuPrio);
  const cpuMax = r.cpuMax === null ? null : count(r.cpuMax);
  if (ramGiB === null || cpuPrio === null || (r.cpuMax !== null && cpuMax === null)) return null;
  return { ramGiB, cpuPrio, cpuMax };
}

export function normIs(raw: unknown): ResourcesActual | null {
  const r = obj(raw);
  if (!r) return null;
  return { ramBytes: count(r.ramBytes), cpuMax: count(r.cpuMax), cpuWeight: count(r.cpuWeight) };
}

export function normConsumption(raw: unknown): Consumption | null {
  const r = obj(raw);
  if (!r) return null;
  return { ramBytes: count(r.ramBytes), cpuThreads: count(r.cpuThreads) };
}

export function normContainer(raw: unknown): ContainerStatus {
  const r = obj(raw) ?? {};
  return { state: one(CONTAINER_STATES, r.state), since: typeof r.since === "string" && r.since ? r.since : null };
}

/** A user of the administration (also the response of PUT …/resources, PATCH and the container actions) — `null` without an id. */
export function normUser(raw: unknown): AdministrationUser | null {
  const r = obj(raw);
  const id = r ? str(r.id) : "";
  if (!r || !id) return null;
  return {
    id,
    username: str(r.username),
    role: one(ROLES, r.role),
    locked: r.locked === true,
    createdAt: count(r.createdAt),
    itself: r.itself === true,
    container: normContainer(r.container),
    resources: normResources(r.resources),
    actual: normIs(r.actual),
    consumption: normConsumption(r.consumption),
    deviating: r.deviating === true,
  };
}

export function normServer(raw: unknown): AdministrationServer {
  const r = obj(raw) ?? {};
  return {
    threads: count(r.threads),
    ramTotalBytes: count(r.ramTotalBytes),
    ramAllocatedBytes: count(r.ramAllocatedBytes),
    reserveBytes: count(r.reserveBytes),
    overcommitted: r.overcommitted === true,
  };
}

export function normAdministration(raw: unknown): Administration {
  const r = obj(raw) ?? {};
  return {
    server: normServer(r.server),
    user: (Array.isArray(r.user) ? r.user : []).map(normUser).filter((n): n is AdministrationUser => n !== null),
  };
}

/** The own limits from the response of `GET /gw/env` (the other fields there — state, start — are read by the environment page itself). */
export function normOwnResources(raw: unknown): OwnResources {
  const r = obj(raw) ?? {};
  return { resources: normResources(r.resources), actual: normIs(r.actual), consumption: normConsumption(r.consumption) };
}

const userPath = (id: string) => `/gw/admin/users/${encodeURIComponent(id)}`;
function userFromResponse(raw: unknown): AdministrationUser {
  const n = normUser(raw);
  if (!n) throw new Error("Response without a user");
  return n;
}

/** GET /gw/admin/administration — server and all users with limits, state and consumption. */
export async function loadAdministration(): Promise<Administration> {
  return normAdministration(await api<unknown>("/gw/admin/administration", { cache: "no-store" }));
}

/**
 * PUT /gw/admin/users/:id/resources — all three keys. The gateway applies the values to the container at once and stores them;
 * below the measured consumption (plus RAM_BUFFER_BYTES) it is 409, and the gateway's sentence names the number (`message`).
 */
export async function setResources(id: string, bodyText: ResourcesBody): Promise<AdministrationUser> {
  const body: ResourcesBody = { ramGiB: bodyText.ramGiB, cpuPrio: bodyText.cpuPrio, cpuMax: bodyText.cpuMax };
  return userFromResponse(await api<unknown>(`${userPath(id)}/resources`, { method: "PUT", body: JSON.stringify(body) }));
}

/** PATCH /gw/admin/users/:id with `role` — demoting the last admin is 400. */
export async function setRole(id: string, role: Role): Promise<AdministrationUser> {
  const body: RoleBody = { role };
  return userFromResponse(await api<unknown>(userPath(id), { method: "PATCH", body: JSON.stringify(body) }));
}

/** PATCH /gw/admin/users/:id with `locked` — locking oneself or the last admin is 400; locking ends the sessions. */
export async function setLocked(id: string, locked: boolean): Promise<AdministrationUser> {
  const body: LockBody = { locked };
  return userFromResponse(await api<unknown>(userPath(id), { method: "PATCH", body: JSON.stringify(body) }));
}

/** POST /gw/admin/users/:id/(start|restart|stop). */
export async function containerAction(id: string, action: ContainerAction): Promise<AdministrationUser> {
  return userFromResponse(await api<unknown>(`${userPath(id)}/${action}`, { method: "POST", body: "{}" }));
}

/** POST /gw/admin/users — the new user gets the limits of the template; the page reloads afterwards. */
export async function setUpUser(bodyText: CreateBody): Promise<void> {
  const body: CreateBody = { username: bodyText.username, password: bodyText.password, role: bodyText.role };
  await api<unknown>("/gw/admin/users", { method: "POST", body: JSON.stringify(body) });
}

/** POST /gw/admin/users/:id/password */
export async function setPassword(id: string, password: string): Promise<void> {
  const body: PasswordBody = { password };
  await api<unknown>(`${userPath(id)}/password`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * DELETE /gw/admin/users/:id — `withData` also deletes the volumes (workspaces, chats, logins; `?purge=1`). First the gateway locks,
 * then it tears down; if the teardown fails, the user stays locked (500 with a sentence), and the same delete can be repeated.
 */
export async function deleteUser(id: string, withData: boolean): Promise<void> {
  await api<unknown>(`${userPath(id)}?purge=${withData ? "1" : "0"}`, { method: "DELETE" });
}
