// The contract of the administration page (users and resources per user container) between gateway, web and iOS, as ONE sheet
// without imports. The gateway (index.js, users.js, containers.js, resources.js) computes with these lists; the binding test
// web/test/administration-binding.test.mjs pins web (lib/api/administration.ts) and iOS (Models/AdministrationModels.swift) to
// them, so changing a line here turns the suite red until both follow. Pattern: server/backend/electron/server/preview/contract.js.

/** The CPU priority levels, in UI order. */
export const CPU_PRIO = Object.freeze(["low", "normal", "up"]);
/**
 * `--cpu-shares` per level. sysbox-runc converts LINEARLY to cpu.weight (1 + (s − 2) · 9999 / 262142, integer): 1287 ⇒ 50,
 * 2600 ⇒ 100, 5220 ⇒ 200 — half, equal, double a container without weight (kernel default 100). "normal" is set explicitly:
 * `docker update --cpu-shares 0` resets nothing (0 means "unspecified" there). Re-measure cpu.weight after every Sysbox
 * update (`CPU_PRIO_WEIGHT` is the expectation).
 */
export const CPU_PRIO_SHARES = Object.freeze({ low: 1287, normal: 2600, up: 5220 });
export const CPU_PRIO_WEIGHT = Object.freeze({ low: 50, normal: 100, up: 200 });

/** RAM is set in whole GiB. */
export const RAM_MIN_GIB = 2;
/** A new RAM value must leave at least this much headroom above measured consumption (working set), otherwise 409. */
export const RAM_BUFFER_BYTES = 512 * 1024 * 1024;
/** What the host keeps for GitLab and itself: if the sum of RAM limits exceeds the rest, the page warns (overcommit is allowed). */
export const HOST_RESERVE_GIB = 6;

export const ROLES = Object.freeze(["user", "admin"]);
export const CONTAINER_STATES = Object.freeze(["running", "stopped", "missing"]);

/** PUT /gw/admin/users/:id/resources — all three required; `cpuMax: null` means "no hard limit", a missing key is 400. */
export const RESOURCES_FIELDS = Object.freeze(["ramGiB", "cpuPrio", "cpuMax"]);
/** PATCH /gw/admin/users/:id — EXACTLY one of these keys; two or none ⇒ 400. */
export const PATCH_FIELDS = Object.freeze(["role", "locked"]);
/** POST /gw/admin/users */
export const CREATE_FIELDS = Object.freeze(["username", "password", "role"]);
/** POST /gw/admin/users/:id/password */
export const PASSWORD_FIELDS = Object.freeze(["password"]);
/** POST /gw/admin/users/:id/<action> */
export const CONTAINER_ACTIONS = Object.freeze(["start", "restart", "stop"]);

/** GET /gw/admin/administration → `{ server, user: [...] }`. */
export const ADMINISTRATION_FIELDS = Object.freeze(["server", "user"]);
export const SERVER_FIELDS = Object.freeze(["threads", "ramTotalBytes", "ramAllocatedBytes", "reserveBytes", "overcommitted"]);
/** One user in the administration (also the response of PUT …/resources, PATCH and the container actions). */
export const USER_FIELDS = Object.freeze(["id", "username", "role", "locked", "createdAt", "itself", "container", "resources", "actual", "consumption", "deviating"]);
/** `container`: state and since when (ISO or null). */
export const CONTAINER_FIELDS = Object.freeze(["state", "since"]);
/** `actual`: what the container currently carries (docker inspect + cgroup), `null` without a container. `cpuMax: null` = no hard limit. */
export const ACTUAL_FIELDS = Object.freeze(["ramBytes", "cpuMax", "cpuWeight"]);
/** `consumption`: working set and CPU threads in the last measurement window, `null` without a running container; per field `null` = not measured. */
export const CONSUMPTION_FIELDS = Object.freeze(["ramBytes", "cpuThreads"]);

/** GET /gw/env additionally carries the caller's own values — read-only, for Settings → Environment. */
export const ENV_ADDITION_FIELDS = Object.freeze(["resources", "actual", "consumption"]);

/** Where GET /gw/admin redirects; the web opens Settings → Administration with it. */
export const ADMINISTRATION_JUMP = "/?settings=administration";
/** The page key in settings (web SETTINGS_GROUPS, iOS SettingsView). */
export const PAGE = "administration";
